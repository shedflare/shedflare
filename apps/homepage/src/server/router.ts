import { createHttpApiWebHandler } from "@shedflare/alchemy";
import { createHttpApiAuth } from "@shedflare/auth-client/http-api";
import { createAuthHandlers, type AuthEnv } from "@shedflare/auth-client/consumer";
import { homepageApi } from "./definitions";
import { createExperiencesGroup, createAdminExperiencesGroup } from "./impl/experiences";
import { createProjectsGroup, createAdminProjectsGroup } from "./impl/projects";
import { object, parse, string } from "valibot";

const DeleteUploadSchema = object({ key: string() });

type Env = AuthEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  IMAGES: R2Bucket;
};

export function createRouter(env: Env) {
  const auth = createHttpApiAuth(env);

  const publicGroups = [
    createExperiencesGroup(env, auth, true),
    createProjectsGroup(env, auth, true),
  ];
  const adminGroups = [createAdminExperiencesGroup(env, auth), createAdminProjectsGroup(env, auth)];

  const wh = createHttpApiWebHandler(homepageApi, [...publicGroups, ...adminGroups]);

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;

      try {
        const rawAuth = createAuthHandlers(env);
        if (pathname === "/api/auth/login" && method === "GET") {
          const returnTo = auth.validateReturnTo(url.searchParams.get("returnTo"));
          return url.searchParams.get("auto") === "1"
            ? await auth.autoLoginRedirect(returnTo)
            : await auth.loginRedirect(returnTo);
        }
        if (pathname === "/api/auth/callback" && method === "GET") {
          return await auth.handleCallback(request);
        }
        if (pathname === "/api/auth/logout" && method === "POST") return await auth.logout(request);
        if (pathname === "/api/session" && method === "GET")
          return await auth.sessionEndpoint(request);

        if (pathname === "/api/admin/uploads" && method === "POST") {
          await rawAuth.requireSession(request);
          const formData = await request.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof File)) {
            return new Response("Missing file", { status: 400 });
          }
          const key = `projects/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
          await env.IMAGES.put(key, file, {
            httpMetadata: { contentType: file.type },
          });
          return Response.json({ url: `/api/media/${key}` });
        }

        if (pathname === "/api/admin/uploads" && method === "DELETE") {
          await rawAuth.requireSession(request);
          const { key } = parse(DeleteUploadSchema, await request.json());
          if (!key) return new Response("Missing key", { status: 400 });
          await env.IMAGES.delete(key);
          return Response.json({ ok: true });
        }

        if (pathname.startsWith("/api/media/")) {
          const key = pathname.slice("/api/media/".length);
          const object = await env.IMAGES.get(key);
          if (!object) return new Response("Not found", { status: 404 });
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          return new Response(object.body, { headers });
        }

        if (pathname.startsWith("/api/")) {
          return await wh.handler(request);
        }

        // Gate admin pages, serve public pages freely
        const isAdmin = pathname.startsWith("/admin");
        if (isAdmin) {
          const gate = await auth.gateHtml(request);
          if (gate.kind === "redirect") return gate.response;
          let assetResponse = await env.ASSETS.fetch(request);
          if (assetResponse.status === 404 && auth.isDocumentRequest(request)) {
            assetResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
          }
          return auth.withCookies(assetResponse, gate.setCookies);
        }

        let assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status === 404 && auth.isDocumentRequest(request)) {
          assetResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
        }
        return assetResponse;
      } catch (error) {
        if (error instanceof Response) return error;
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  };
}
