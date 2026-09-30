import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type AuthRpc,
  type ExchangeRequest,
  type SessionRequest,
} from "@shedflare/auth-client/contract";
import { getCookie, serializeCookie } from "@shedflare/auth-client/consumer";
import { allowedClients, authorizationInput } from "./clients";
import { createLoginProvider, SSO_COOKIE, type OpenAuthStorage } from "./openauth";
import { renderAuthHome } from "./home";
import { sessionStore } from "./sessions";
import { agentTokenStore } from "./tokens";
import { handleTokenManagement } from "./token-routes";
import { inspectDeployments, type DeploymentEnv } from "./deployments";
import { handleDeviceRequest } from "./device-routes";
import { deviceAuthorizationStore } from "./device-authorization";

export type Env = DeploymentEnv & {
  APP_PUBLIC_URL: string;
  GOOGLE_CLIENT_ID: string;
  OWNER_EMAIL: string;
  ALLOWED_CLIENTS: string;
  AUTH_DB: D1Database;
  OPENAUTH_STORAGE: OpenAuthStorage;
};

function redirect(url: URL, cookies: string[] = []) {
  const headers = new Headers({ Location: url.toString() });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== new URL(env.APP_PUBLIC_URL).origin)
    return new Response("Not found", { status: 404 });
  const store = sessionStore(env);
  if (
    ["/agent/authorize", "/api/agent/device/start", "/api/agent/device/poll"].includes(url.pathname)
  )
    return handleDeviceRequest(request, env);
  if (url.pathname === "/tokens" || url.pathname.startsWith("/tokens/"))
    return handleTokenManagement(request, env);
  if (url.pathname === "/api/deployments" || url.pathname === "/api/agent/session") {
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    const token = await agentTokenStore(env).authenticate(request);
    if (!token)
      return Response.json(
        { error: "A valid agent token is required." },
        {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="shedflare", error="invalid_token"' },
        },
      );
    if (url.pathname === "/api/agent/session")
      return Response.json({ name: token.name, scope: token.scope, expiresAt: token.expiresAt });
    return inspectDeployments(request, env);
  }
  if (url.pathname === "/" && request.method === "GET") {
    const session = await store.loginSession(getCookie(request, SSO_COOKIE) ?? "");
    return new Response(
      renderAuthHome({
        email: session?.email ?? null,
        appOrigins: Object.values(allowedClients(env.ALLOWED_CLIENTS)).flat(),
      }),
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    if (request.headers.get("origin") !== url.origin)
      return new Response("Forbidden", { status: 403 });
    await store.revokeLogin(getCookie(request, SSO_COOKIE) ?? "");
    return redirect(new URL("/", url), [serializeCookie(SSO_COOKIE, "", { maxAge: 0 })]);
  }
  if (url.pathname === "/authorize" && request.method === "GET") {
    const input = authorizationInput(request, env.ALLOWED_CLIENTS);
    if (!input) return new Response("Invalid login request", { status: 400 });
    const callback = new URL("/api/auth/callback", input.origin);
    callback.searchParams.set("state", input.appState);
    const session = await store.loginSession(getCookie(request, SSO_COOKIE) ?? "");
    if (session) {
      const code = await store.createHandoff({
        loginId: session.tokenHash,
        clientId: input.clientId,
        origin: input.origin,
        challenge: input.challenge,
      });
      callback.searchParams.set("code", code);
      return redirect(callback);
    }
    if (url.searchParams.get("auto") === "1") {
      callback.searchParams.set("error", "no_session");
      return redirect(callback);
    }
    return createLoginProvider(env).start(input);
  }
  if (url.pathname === "/google/callback" && request.method === "POST") {
    return createLoginProvider(env).callback(request);
  }
  return new Response("Not found", { status: 404 });
}

export default class AuthWorker extends WorkerEntrypoint<Env> implements AuthRpc {
  validateSession(input: SessionRequest) {
    return sessionStore(this.env).validateSession(input);
  }
  exchangeCode(input: ExchangeRequest) {
    return sessionStore(this.env).exchangeCode(input);
  }
  revokeSession(input: SessionRequest) {
    return sessionStore(this.env).revokeSession(input);
  }

  async fetch(request: Request): Promise<Response> {
    let response: Response;
    try {
      response = await handleRequest(request, this.env);
    } catch {
      response = new Response("Authentication service unavailable. Please retry sign-in.", {
        status: 503,
        headers: { "retry-after": "5" },
      });
    }
    response.headers.set("cache-control", "no-store");
    // Native form POSTs under no-referrer send Origin: null and fail our CSRF check.
    // HTML keeps same-origin form origins while suppressing cross-origin referrers.
    response.headers.set(
      "referrer-policy",
      response.headers.get("content-type")?.split(";")[0] === "text/html"
        ? "same-origin"
        : "no-referrer",
    );
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    return response;
  }

  async scheduled() {
    await sessionStore(this.env).cleanup();
    await agentTokenStore(this.env).cleanup();
    await deviceAuthorizationStore(this.env).cleanup();
  }
}
