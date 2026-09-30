import { object, safeParse } from "valibot";
import { AgentDaysSchema, AgentNameSchema } from "@shedflare/auth-client/deployments";
import { readAuthInput } from "./request-input";
import { getCookie } from "@shedflare/auth-client/consumer";
import { SSO_COOKIE } from "./openauth";
import { sessionStore } from "./sessions";
import { agentTokenStore } from "./tokens";
import { renderAgentTokens } from "./home";
import type { Env } from "./worker";

const CreateTokenSchema = object({
  name: AgentNameSchema,
  days: AgentDaysSchema,
});

export async function handleTokenManagement(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const revoke = /^\/tokens\/([a-f0-9-]{36})\/revoke$/.exec(url.pathname);
  if (url.pathname !== "/tokens" && !revoke) return new Response("Not found", { status: 404 });
  const expectedMethod = revoke ? "POST" : "GET, POST";
  if (request.method !== "POST" && (revoke || request.method !== "GET"))
    return new Response("Method not allowed", { status: 405, headers: { allow: expectedMethod } });
  // Bearer tokens never authorize token management, even with a valid cookie.
  if (request.headers.has("authorization")) return new Response("Forbidden", { status: 403 });
  if (request.method === "POST" && request.headers.get("origin") !== url.origin)
    return new Response("Forbidden", { status: 403 });
  const login = await sessionStore(env).loginSession(getCookie(request, SSO_COOKIE) ?? "");
  if (!login) return new Response("Sign in through a Shedflare app first.", { status: 401 });
  const store = agentTokenStore(env);
  if (revoke) {
    await store.revoke(revoke[1]);
    return new Response(null, { status: 303, headers: { location: new URL("/tokens", url).href } });
  }
  if (request.method === "GET") {
    const tokens = await store.list();
    return request.headers.get("accept")?.includes("application/json")
      ? Response.json({ tokens })
      : new Response(renderAgentTokens(tokens), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
  }
  const parsed = safeParse(CreateTokenSchema, await readAuthInput(request));
  if (!parsed.success)
    return Response.json(
      { error: "Provide a name (1–80 characters) and days (1–90)." },
      { status: 400 },
    );
  const created = await store.create(parsed.output);
  if (request.headers.get("accept")?.includes("application/json"))
    return Response.json(created, { status: 201 });
  return new Response(renderAgentTokens(await store.list(), created.token), {
    status: 201,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
