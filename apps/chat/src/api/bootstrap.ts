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
      const headers = new Headers({
        "content-type": "application/json",
        "cache-control": "no-store",
      });

      if (!session)
        return new Response(
          JSON.stringify({ session: null, exaApiKeyConfigured: Boolean(env.EXA_API_KEY?.trim()) }),
          { headers },
        );

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
