import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createHttpApiWebHandler } from "@shedflare/alchemy";
import { createHttpApiAuth } from "@shedflare/auth-client/http-api";
import { links } from "../db/schema";
import { shortApi } from "./definitions";
import { createLinksGroup, isValidSlug } from "./impl/links";
import type { AuthEnv } from "@shedflare/auth-client/consumer";

type Env = AuthEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
};

export function createRouter(env: Env) {
  const auth = createHttpApiAuth(env);
  const wh = createHttpApiWebHandler(shortApi, [createLinksGroup(env, auth)]);

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;

      try {
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

        if (pathname.startsWith("/api/")) {
          return await wh.handler(request);
        }

        const slug = pathname.slice(1);
        if (isValidSlug(slug)) {
          const db = drizzle(env.DB);
          const row = await db.select().from(links).where(eq(links.slug, slug)).get();
          if (row) {
            if (row.hidePreview) {
              const safeUrl = row.url
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
              const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta property="og:title" content="Link">
<meta property="og:description" content="">
<meta name="twitter:card" content="summary">
<title>Redirecting…</title>
<meta http-equiv="refresh" content="0;url=${safeUrl}">
<script>location.replace(${JSON.stringify(row.url)})</script>
</head>
<body>
<p>Redirecting to <a href="${safeUrl}">${safeUrl}</a>…</p>
</body>
</html>`;
              return new Response(html, {
                headers: { "content-type": "text/html; charset=utf-8" },
              });
            }
            return Response.redirect(row.url, 301);
          }
          return new Response("Not Found", { status: 404 });
        }

        const gate = await auth.gateHtml(request, { publicPaths: ["/forbidden"] });
        if (gate.kind === "redirect") return gate.response;

        let assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status === 404 && auth.isDocumentRequest(request)) {
          assetResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
        }
        return auth.withCookies(assetResponse, gate.setCookies);
      } catch (error) {
        if (error instanceof Response) return error;
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  };
}
