import { createAuthHandlers } from "@shedflare/auth-client/consumer";
import { createHttpApiAuth } from "@shedflare/auth-client/http-api";
import type { AuthEnv } from "@shedflare/auth-client/consumer";
import { db } from "./db";
import * as handlers from "./handlers";

type Env = AuthEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
};

export function createRouter(env: Env) {
  const auth = createHttpApiAuth(env);
  const rawAuth = createAuthHandlers(env);
  const database = db(env.DB);

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
        if (pathname === "/api/auth/callback" && method === "GET")
          return await auth.handleCallback(request);
        if (pathname === "/api/auth/logout" && method === "POST") return await auth.logout(request);
        if (pathname === "/api/session" && method === "GET")
          return await auth.sessionEndpoint(request);

        if (pathname.startsWith("/api/")) {
          await rawAuth.requireSession(request);

          if (pathname === "/api/overview" && method === "GET")
            return await handlers.overview(database);
          if (pathname === "/api/stats" && method === "GET") return await handlers.stats(database);
          if (pathname === "/api/decks" && method === "POST")
            return await handlers.createDeck(database, await request.json());
          if (pathname === "/api/cards" && method === "GET")
            return await handlers.listCards(database, url.searchParams.get("deckId"));
          if (pathname === "/api/cards" && method === "POST")
            return await handlers.createCard(database, await request.json());
          if (pathname === "/api/reviews" && method === "POST")
            return await handlers.reviewCard(database, await request.json());

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
        console.error("Anki router error:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    },
  };
}
