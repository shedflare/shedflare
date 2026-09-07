import { serializeCookie } from "@shedflare/auth-client/consumer";
import { getRuntimeEnv, getSession } from "#/runtime";
import { runApiTrace } from "../server/api-tracing";

export async function handleBootstrap(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  return runApiTrace({
    scope: "bootstrap-api",
    name: "bootstrap.fetch",
    kind: "io",
    env,
    attrs: {
      method: request.method,
      path: new URL(request.url).pathname,
    },
    run: async () => {
      const session = await getSession(request, env);
      const headers = new Headers({ "content-type": "application/json" });

      if (!session)
        return new Response(
          JSON.stringify({ session: null, exaApiKeyConfigured: Boolean(env.EXA_API_KEY?.trim()) }),
          { headers },
        );

      if (session.tokens) {
        headers.append(
          "Set-Cookie",
          serializeCookie("auth_access_token", session.tokens.access, {
            maxAge: session.tokens.expiresIn,
          }),
        );
        headers.append(
          "Set-Cookie",
          serializeCookie("auth_refresh_token", session.tokens.refresh, {
            maxAge: 60 * 60 * 24 * 365,
          }),
        );
      }

      return new Response(
        JSON.stringify({
          session: { user: session.user },
          exaApiKeyConfigured: Boolean(env.EXA_API_KEY?.trim()),
        }),
        { headers },
      );
    },
  });
}
