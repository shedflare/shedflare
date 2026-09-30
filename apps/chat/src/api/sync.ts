import { getRuntimeEnv, getSyncStub, requireSession } from "#/runtime";

export async function handleSync(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const stub = await getSyncStub(env);
  const url = new URL(request.url);
  const syncPrefix = "/api/sync";
  const suffix = url.pathname.startsWith(syncPrefix) ? url.pathname.slice(syncPrefix.length) : "";
  if (suffix.startsWith("/backup/")) return new Response("Not found", { status: 404 });
  url.pathname = suffix || "/";
  return stub.fetch(new Request(url.toString(), request));
}
