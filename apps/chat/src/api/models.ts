import {
  fetchModelsCatalog,
  filterModelsCatalog,
  getRuntimeEnv,
  purgeModelsCatalogCache,
  requireSession,
} from "#/runtime";
import { runApiTrace } from "../server/api-tracing";

export async function handleModels(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  return runApiTrace({
    scope: "models-api",
    name: "models.fetch",
    kind: "io",
    env,
    attrs: {
      method: request.method,
      path: new URL(request.url).pathname,
    },
    run: async () => {
      await requireSession(request, env);
      // SAFETY: Cloudflare Workers exposes the documented nonstandard default cache on CacheStorage.
      const cache = (globalThis.caches as CacheStorage & { default: Cache }).default;
      const url = new URL(request.url);
      if (url.searchParams.has("purge")) {
        await purgeModelsCatalogCache(cache);
      }
      const raw = await fetchModelsCatalog(env, cache);
      return Response.json(filterModelsCatalog(raw, env));
    },
  });
}
