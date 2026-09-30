import { createHttpApiWebHandler } from "@shedflare/alchemy";
import { createHttpApiAuth } from "@shedflare/auth-client/http-api";
import { createAuthHandlers } from "@shedflare/auth-client/consumer";
import { moneyApi } from "./definitions";
import { createUploadsGroup } from "./impl/uploads";
import { createAccountsGroup } from "./impl/accounts";
import { createTransactionsGroup } from "./impl/transactions";
import { createCategoriesGroup } from "./impl/categories";
import { createBudgetGroup } from "./impl/budget";
import { createPayeesGroup } from "./impl/payees";
import { createSchedulesGroup } from "./impl/schedules";
import { createRulesGroup } from "./impl/rules";
import { createTagsGroup } from "./impl/tags";
import { createFiltersGroup } from "./impl/filters";
import { createReportsGroup } from "./impl/reports";
import { createDashboardGroup } from "./impl/dashboard";
import { createCommandGroup } from "./impl/command";
import { createDataGroup } from "./impl/data";
import { createExportGroup } from "./impl/export";
import { createRatesGroup } from "./impl/rates";
import { createSettingsGroup } from "./impl/settings";
import type { AuthEnv } from "@shedflare/auth-client/consumer";

type Env = AuthEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MONEY_DB: D1Database;
  UPLOADS: R2Bucket;
};

export function createRouter(env: Env) {
  const auth = createHttpApiAuth(env);
  const rawAuth = createAuthHandlers(env);

  const wh = createHttpApiWebHandler(moneyApi, [
    createUploadsGroup(env),
    createAccountsGroup(env),
    createTransactionsGroup(env),
    createCategoriesGroup(env),
    createBudgetGroup(env),
    createPayeesGroup(env),
    createSchedulesGroup(env),
    createRulesGroup(env),
    createTagsGroup(env),
    createFiltersGroup(env),
    createReportsGroup(env),
    createDashboardGroup(env),
    createCommandGroup(env),
    createDataGroup(env),
    createExportGroup(env),
    createRatesGroup(env),
    createSettingsGroup(env),
  ]);

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;

      try {
        // ── Auth routes ──────────────────────────────────────────────
        if (url.pathname === "/api/auth/login" && method === "GET") {
          const returnTo = auth.validateReturnTo(url.searchParams.get("returnTo"));
          return url.searchParams.get("auto") === "1"
            ? await auth.autoLoginRedirect(returnTo)
            : await auth.loginRedirect(returnTo);
        }
        if (url.pathname === "/api/auth/callback" && method === "GET") {
          return await auth.handleCallback(request);
        }
        if (url.pathname === "/api/auth/logout" && method === "POST")
          return await auth.logout(request);
        if (url.pathname === "/api/session" && method === "GET")
          return await auth.sessionEndpoint(request);

        // ── Require session for all other API routes ─────────────────
        if (url.pathname.startsWith("/api/")) {
          await rawAuth.requireSession(request);
          return await wh.handler(request);
        }

        // ── Assets ──────────────────────────────────────────────────
        const gate = await auth.gateHtml(request, { publicPaths: ["/forbidden"] });
        if (gate.kind === "redirect") return gate.response;

        let assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status === 404 && auth.isDocumentRequest(request)) {
          assetResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
        }
        return auth.withCookies(assetResponse, gate.setCookies);
      } catch (error) {
        if (error instanceof Response) return error;
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            message: "money request failed",
            error: message,
            method,
            path: url.pathname,
          }),
        );
        return url.pathname.startsWith("/api/")
          ? Response.json({ error: "Internal server error" }, { status: 500 })
          : new Response("Internal Server Error", { status: 500 });
      }
    },
  };
}
