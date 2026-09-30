import { createAuthHandlers, type AuthEnv } from "@shedflare/auth-client/consumer";
import { safeParse } from "valibot";
import { ExchangeRequestSchema } from "@shedflare/auth-client/contract";

// A real second Worker exercises the same adapter used by the suite over a
// native service binding. The probe is only bundled by the local test harness.
export default {
  async fetch(request: Request, env: AuthEnv) {
    const auth = createAuthHandlers(env);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/auth/login")
        return url.searchParams.get("auto") === "1"
          ? auth.autoLoginRedirect(url.searchParams.get("returnTo"))
          : auth.loginRedirect(url.searchParams.get("returnTo"));
      if (url.pathname === "/api/auth/callback") return await auth.handleCallback(request);
      if (url.pathname === "/api/auth/logout") return await auth.logout(request);
      if (url.pathname === "/api/session") return await auth.sessionEndpoint(request);
      if (url.pathname === "/test/exchange") {
        const input = safeParse(ExchangeRequestSchema, await request.json());
        if (!input.success) return new Response(null, { status: 400 });
        return Response.json(await env.AUTH.exchangeCode(input.output));
      }
      const gate = await auth.gateHtml(request);
      if (gate.kind === "redirect") return gate.response;
      return auth.withCookies(
        Response.json({ email: gate.session?.email ?? null }),
        gate.setCookies,
      );
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  },
} satisfies ExportedHandler<AuthEnv>;
