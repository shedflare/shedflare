import { safeParse } from "valibot";
import {
  DeviceStartSchema,
  DevicePollRequestSchema,
  DeviceApprovalSchema,
  UserCodeSchema,
} from "@shedflare/auth-client/deployments";
import { getCookie } from "@shedflare/auth-client/consumer";
import { deviceAuthorizationStore } from "./device-authorization";
import { renderAgentApproval } from "./home";
import { createLoginProvider, SSO_COOKIE } from "./openauth";
import { sessionStore } from "./sessions";
import { readAuthInput } from "./request-input";
import type { Env } from "./worker";

export async function handleDeviceRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const browser = url.pathname === "/agent/authorize";
  const allowed = browser ? ["GET", "POST"] : ["POST"];
  if (!allowed.includes(request.method))
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: allowed.join(", ") },
    });
  const origin = request.headers.get("origin");
  if (
    request.method === "POST" &&
    (browser ? origin !== url.origin : origin !== null && origin !== url.origin)
  )
    return new Response("Forbidden", { status: 403 });
  if (request.headers.has("authorization")) return new Response("Forbidden", { status: 403 });
  const store = deviceAuthorizationStore(env);
  if (!browser) {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
      return Response.json({ error: "JSON is required." }, { status: 400 });
    const input = await readAuthInput(request);
    if (url.pathname === "/api/agent/device/start") {
      const parsed = safeParse(DeviceStartSchema, input);
      if (!parsed.success)
        return Response.json({ error: "Provide a name (1–80 characters)." }, { status: 400 });
      const grant = await store.start(
        parsed.output.name,
        request.headers.get("cf-connecting-ip") ?? "local",
      );
      if (!grant)
        return Response.json(
          { error: "Too many login requests. Try again later." },
          { status: 429, headers: { "retry-after": "600" } },
        );
      const verificationUri = new URL("/agent/authorize", env.APP_PUBLIC_URL);
      const complete = new URL(verificationUri);
      complete.searchParams.set("user_code", grant.userCode);
      return Response.json({
        ...grant,
        verificationUri: verificationUri.href,
        verificationUriComplete: complete.href,
      });
    }
    const parsed = safeParse(DevicePollRequestSchema, input);
    if (!parsed.success) return Response.json({ error: "Invalid login request." }, { status: 400 });
    const result = await store.poll(parsed.output.deviceCode);
    if (result.kind === "error")
      return Response.json({ error: result.error, interval: result.interval }, { status: 400 });
    return Response.json({
      token: result.token,
      name: result.name,
      scope: result.scope,
      expiresAt: result.expiresAt,
    });
  }
  const login = await sessionStore(env).loginSession(getCookie(request, SSO_COOKIE) ?? "");
  if (request.method === "POST") {
    if (!login)
      return new Response("Sign in again before approving this request.", { status: 401 });
    const parsed = safeParse(DeviceApprovalSchema, await readAuthInput(request));
    if (!parsed.success) return new Response("Invalid approval request", { status: 400 });
    const decided = await store.decide(parsed.output);
    if (!decided)
      return new Response(
        renderAgentApproval({ userCode: parsed.output.userCode, status: "invalid" }),
        { status: 409, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    const target = new URL("/agent/authorize", url);
    target.searchParams.set("user_code", parsed.output.userCode);
    return new Response(null, { status: 303, headers: { location: target.href } });
  }
  const code = safeParse(UserCodeSchema, url.searchParams.get("user_code"));
  if (!code.success)
    return new Response("Invalid approval link. Start login in your terminal.", { status: 400 });
  const record = await store.find(code.output);
  if (!record)
    return new Response(renderAgentApproval({ userCode: code.output, status: "invalid" }), {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  // An existing owner session goes straight to approval. Otherwise Google signs
  // the owner in and returns here; viewing a link never grants access.
  if (!login) return createLoginProvider(env).startAgent(code.output);
  return new Response(renderAgentApproval({ userCode: code.output, ...record }), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
