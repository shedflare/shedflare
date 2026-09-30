import { issuer } from "@openauthjs/openauth";
import { OauthError } from "@openauthjs/openauth/error";
import { GoogleOidcProvider } from "@openauthjs/openauth/provider/google";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { createSubjects } from "@openauthjs/openauth/subject";
import { and, eq, gt } from "drizzle-orm";
import { literal, number, object, optional, picklist, safeParse, string } from "valibot";
import { getCookie, normalizeEmail, serializeCookie } from "@shedflare/auth-client/consumer";
import {
  LOGIN_TTL_SECONDS,
  hashToken,
  isToken,
  randomToken,
} from "@shedflare/auth-client/contract";
import { isAllowedClient, type authorizationInput } from "./clients";
import { agentLoginFlows, loginFlows } from "./db/schema";
import { deviceAuthorizationStore } from "./device-authorization";
import { SESSION_TTL_SECONDS, sessionStore } from "./sessions";
import type { Env } from "./worker";

export const SSO_COOKIE = "__Host-shedflare_sso";
const FLOW_COOKIE = "__Host-shedflare_login_flow";
const subjects = createSubjects({ user: object({ email: string() }) });
const GoogleClaimsSchema = object({
  email: string(),
  email_verified: literal(true),
  iss: picklist(["https://accounts.google.com", "accounts.google.com"]),
  sub: string(),
  exp: number(),
  azp: optional(string()),
});

export type OpenAuthStorage = Parameters<typeof CloudflareStorage>[0]["namespace"];

export function createLoginProvider(env: Env) {
  const store = sessionStore(env);
  const app = issuer({
    subjects,
    storage: CloudflareStorage({ namespace: env.OPENAUTH_STORAGE }),
    providers: {
      google: GoogleOidcProvider({ clientID: env.GOOGLE_CLIENT_ID, scopes: ["email", "profile"] }),
    },
    // Only the Worker-owned login entry point is exposed. App token issuance
    // and validation use the RPC contract, never OpenAuth's public endpoints.
    allow: async () => false,
    async success(_ctx, value, request) {
      if (value.provider !== "google") return new Response("Invalid provider", { status: 400 });
      // OpenAuth verifies Google's signature, audience, expiry and nonce.
      // Apply Shedflare's owner policy to the verified claims.
      const claims = safeParse(GoogleClaimsSchema, value.id);
      if (
        !claims.success ||
        normalizeEmail(claims.output.email) !== normalizeEmail(env.OWNER_EMAIL) ||
        (claims.output.azp !== undefined && claims.output.azp !== env.GOOGLE_CLIENT_ID) ||
        (Array.isArray(value.id.aud) && value.id.aud.length > 1 && !claims.output.azp)
      ) {
        return new Response("This Google account is not allowed for this Shedflare install.", {
          status: 403,
        });
      }
      const token = getCookie(request, FLOW_COOKIE) ?? "";
      if (!isToken(token)) return new Response("Invalid login state", { status: 400 });
      const [agentFlow] = await store.db
        .delete(agentLoginFlows)
        .where(
          and(
            eq(agentLoginFlows.tokenHash, await hashToken(token)),
            gt(agentLoginFlows.expiresAt, Date.now()),
          ),
        )
        .returning();
      if (agentFlow) {
        const pending = await deviceAuthorizationStore(env).find(agentFlow.userCode);
        if (!pending || pending.status !== "pending")
          return new Response("Agent login expired or already used", { status: 400 });
        const session = await store.createLogin(claims.output.email);
        const target = new URL("/agent/authorize", env.APP_PUBLIC_URL);
        target.searchParams.set("user_code", agentFlow.userCode);
        const headers = new Headers({ location: target.href });
        headers.append(
          "set-cookie",
          serializeCookie(SSO_COOKIE, session.token, { maxAge: SESSION_TTL_SECONDS }),
        );
        headers.append(
          "set-cookie",
          serializeCookie(FLOW_COOKIE, "", { maxAge: 0, sameSite: "None" }),
        );
        headers.append(
          "set-cookie",
          serializeCookie("provider", "", { maxAge: 0, sameSite: "None" }),
        );
        return new Response(null, { status: 303, headers });
      }
      // This is the browser's pending app handoff, not provider/OIDC state.
      // Consume it once so replaying an OpenAuth callback cannot create sessions.
      const [flow] = await store.db
        .delete(loginFlows)
        .where(
          and(
            eq(loginFlows.tokenHash, await hashToken(token)),
            gt(loginFlows.expiresAt, Date.now()),
          ),
        )
        .returning();
      if (!flow || !isAllowedClient(env.ALLOWED_CLIENTS, flow.clientId, flow.origin))
        return new Response("Login expired or already used", { status: 400 });
      const session = await store.createLogin(claims.output.email);
      const code = await store.createHandoff({
        loginId: session.tokenHash,
        clientId: flow.clientId,
        origin: flow.origin,
        challenge: flow.challenge,
      });
      const callback = new URL("/api/auth/callback", flow.origin);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", flow.appState);
      const headers = new Headers({ location: callback.toString() });
      headers.append(
        "set-cookie",
        serializeCookie(SSO_COOKIE, session.token, { maxAge: SESSION_TTL_SECONDS }),
      );
      headers.append(
        "set-cookie",
        serializeCookie(FLOW_COOKIE, "", { maxAge: 0, sameSite: "None" }),
      );
      headers.append(
        "set-cookie",
        serializeCookie("provider", "", { maxAge: 0, sameSite: "None" }),
      );
      return new Response(null, { status: 303, headers });
    },
  });
  // OpenAuth's default error handler redirects using its OAuth-client state.
  // This Worker owns that handoff, so finish errors here without token redirects.
  app.onError((error) => {
    const invalidToken =
      "code" in error &&
      [
        "ERR_JWT_EXPIRED",
        "ERR_JWT_CLAIM_VALIDATION_FAILED",
        "ERR_JWS_INVALID",
        "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
        "ERR_JOSE_ALG_NOT_ALLOWED",
        "ERR_JWKS_NO_MATCHING_KEY",
      ].includes(String(error.code));
    if (error instanceof OauthError || invalidToken)
      return new Response("Invalid Google login response. Please sign in again.", { status: 403 });
    return new Response("Authentication service unavailable. Please retry sign-in.", {
      status: 503,
      headers: { "retry-after": "5" },
    });
  });

  return {
    async startAgent(userCode: string) {
      const token = randomToken();
      await store.db.insert(agentLoginFlows).values({
        tokenHash: await hashToken(token),
        userCode,
        expiresAt: Date.now() + LOGIN_TTL_SECONDS * 1000,
      });
      const response = await app.fetch(
        new Request(new URL("/google/authorize", env.APP_PUBLIC_URL)),
      );
      response.headers.append(
        "set-cookie",
        serializeCookie(FLOW_COOKIE, token, { maxAge: LOGIN_TTL_SECONDS, sameSite: "None" }),
      );
      return response;
    },
    async start(input: NonNullable<ReturnType<typeof authorizationInput>>) {
      const token = randomToken();
      await store.db.insert(loginFlows).values({
        ...input,
        tokenHash: await hashToken(token),
        expiresAt: Date.now() + LOGIN_TTL_SECONDS * 1000,
      });
      const response = await app.fetch(
        new Request(new URL("/google/authorize", env.APP_PUBLIC_URL)),
      );
      response.headers.append(
        "set-cookie",
        serializeCookie(FLOW_COOKIE, token, {
          maxAge: LOGIN_TTL_SECONDS,
          sameSite: "None",
        }),
      );
      return response;
    },
    async callback(request: Request) {
      if (!isToken(getCookie(request, FLOW_COOKIE) ?? "") || !getCookie(request, "provider"))
        return new Response("Invalid login state", { status: 400 });
      const headers = new Headers(request.headers);
      for (const name of ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"])
        headers.delete(name);
      const response = await app.fetch(new Request(request, { headers }));
      // OpenAuth restarts its provider route when its encrypted cookie is
      // missing or corrupt. Start again through the app's validated login flow.
      return response.status === 302
        ? new Response("Login expired. Please sign in again.", { status: 400 })
        : response;
    },
  };
}
