import { nullable, object, safeParse, string } from "valibot";
import { AUTH_HINT_COOKIE } from "./client";
import {
  LOGIN_TTL_SECONDS,
  SESSION_COOKIE,
  STATE_COOKIE,
  hashToken,
  randomToken,
  type AuthRpc,
  type Session,
} from "./contract";

export type { Session } from "./contract";
export type AuthEnv = {
  AUTH: AuthRpc;
  AUTH_URL: string;
  AUTH_CLIENT_ID: string;
  APP_PUBLIC_URL: string;
  OWNER_EMAIL: string;
  DEV_AUTH_EMAIL?: string;
  E2E_AUTH_EMAIL?: string;
  E2E_AUTH_TOKEN?: string;
};

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isOwnerEmail(email: string, ownerEmail: string): boolean {
  return normalizeEmail(email) === normalizeEmail(ownerEmail);
}

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}

export function serializeCookie(
  name: string,
  value: string,
  opts: {
    maxAge?: number;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
  } = {},
) {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  cookie += `; Path=${opts.path ?? "/"}`;
  if (opts.secure !== false) cookie += `; Secure`;
  if (opts.httpOnly !== false) cookie += `; HttpOnly`;
  cookie += `; SameSite=${opts.sameSite ?? "Lax"}`;
  return cookie;
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  try {
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function secretsEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function authenticateE2eRequest(request: Request, env: AuthEnv): Promise<Session | null> {
  if (!env.E2E_AUTH_EMAIL || !env.E2E_AUTH_TOKEN) return null;
  const token = request.headers.get("x-shedflare-e2e-token");
  if (!token || !(await secretsEqual(token, env.E2E_AUTH_TOKEN))) return null;
  return { email: normalizeEmail(env.E2E_AUTH_EMAIL), expiresAt: Date.now() + 60_000 };
}

export function isDocumentRequest(request: Request): boolean {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest === "document") return true;
  if (dest) return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

export function validateReturnTo(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const target = input.trim();
  if (!target.startsWith("/")) return null;
  // Check decoded separators, but preserve escaping in app paths and queries.
  // The stored return path is validated again when the callback uses it.
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//") || decoded.includes("\\")) return null;
  for (const char of decoded) {
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return null;
  }
  if (decoded.startsWith("/api/")) return null;
  return target;
}

const LoginStateSchema = object({
  state: string(),
  verifier: string(),
  returnTo: nullable(string()),
});

export type HtmlGateResult =
  | { kind: "proceed"; session: Session | null; setCookies: string[] }
  | { kind: "redirect"; response: Response };

export function createAuthHandlers(env: AuthEnv) {
  const origin = new URL(env.APP_PUBLIC_URL).origin;
  const client = { clientId: env.AUTH_CLIENT_ID, origin };
  const clearCookie = (name: string, httpOnly = true) =>
    serializeCookie(name, "", { maxAge: 0, httpOnly });
  const hintCookie = (session: Session) =>
    serializeCookie(AUTH_HINT_COOKIE, session.email, {
      httpOnly: false,
      maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
    });

  async function rpc<A>(call: () => Promise<A>): Promise<A> {
    try {
      return await call();
    } catch {
      throw new Response("Authentication service unavailable. Please retry.", {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "5" },
      });
    }
  }

  async function authenticate(request: Request): Promise<Session | null> {
    const e2eSession = await authenticateE2eRequest(request, env);
    if (e2eSession && isOwnerEmail(e2eSession.email, env.OWNER_EMAIL)) return e2eSession;
    if (
      env.DEV_AUTH_EMAIL &&
      isLocalRequest(request) &&
      isOwnerEmail(env.DEV_AUTH_EMAIL, env.OWNER_EMAIL)
    ) {
      return { email: normalizeEmail(env.DEV_AUTH_EMAIL), expiresAt: Date.now() + 60_000 };
    }
    const token = getCookie(request, SESSION_COOKIE);
    if (!token) return null;
    const result = await rpc(() => env.AUTH.validateSession({ ...client, token }));
    return result.kind === "authenticated" ? result.session : null;
  }

  async function requireSession(request: Request): Promise<Session> {
    const session = await authenticate(request);
    if (!session)
      throw new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
    return session;
  }

  function withCookies(response: Response, cookies: string[]) {
    if (cookies.length === 0) return response;
    const headers = new Headers(response.headers);
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    headers.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  async function startLogin(returnTo: string | null | undefined, silent: boolean) {
    const state = randomToken();
    const verifier = randomToken();
    const url = new URL("/authorize", env.AUTH_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await hashToken(verifier));
    if (silent) url.searchParams.set("auto", "1");
    const headers = new Headers({
      Location: url.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    headers.append(
      "Set-Cookie",
      serializeCookie(
        STATE_COOKIE,
        JSON.stringify({ state, verifier, returnTo: validateReturnTo(returnTo) }),
        { maxAge: LOGIN_TTL_SECONDS },
      ),
    );
    return new Response(null, { status: 302, headers });
  }

  function loginRedirect(returnTo?: string | null) {
    return startLogin(returnTo, false);
  }
  function autoLoginRedirect(returnTo?: string | null) {
    return startLogin(returnTo, true);
  }

  async function handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let rawState;
    try {
      rawState = JSON.parse(getCookie(request, STATE_COOKIE) ?? "null");
    } catch {
      rawState = null;
    }
    const parsed = safeParse(LoginStateSchema, rawState);
    if (
      !parsed.success ||
      !parsed.output.state ||
      url.searchParams.get("state") !== parsed.output.state
    ) {
      return new Response("Invalid login state", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    const { verifier, returnTo } = parsed.output;
    const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    headers.append("Set-Cookie", clearCookie(STATE_COOKIE));
    const target = new URL(validateReturnTo(returnTo) ?? "/", origin);
    if (url.searchParams.get("error") === "no_session") {
      target.searchParams.set("error", "no_session");
      headers.set("Location", target.toString());
      return new Response(null, { status: 302, headers });
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error"))
      return new Response("Login failed", { status: 400, headers });
    const result = await rpc(() => env.AUTH.exchangeCode({ ...client, code, verifier }));
    if (result.kind === "invalid")
      return new Response("Login expired or already used. Please sign in again.", {
        status: 400,
        headers,
      });
    headers.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, result.token, {
        maxAge: Math.max(0, Math.floor((result.session.expiresAt - Date.now()) / 1000)),
      }),
    );
    headers.append("Set-Cookie", hintCookie(result.session));
    headers.set("Location", target.toString());
    return new Response(null, { status: 302, headers });
  }

  async function logout(request: Request): Promise<Response> {
    if (request.method !== "POST" || request.headers.get("origin") !== origin)
      return new Response("Forbidden", { status: 403 });
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await rpc(() => env.AUTH.revokeSession({ ...client, token }));
    const headers = new Headers({ Location: "/?error=no_session", "cache-control": "no-store" });
    for (const name of [SESSION_COOKIE, STATE_COOKIE])
      headers.append("Set-Cookie", clearCookie(name));
    headers.append("Set-Cookie", clearCookie(AUTH_HINT_COOKIE, false));
    return new Response(null, { status: 303, headers });
  }

  async function sessionEndpoint(request: Request): Promise<Response> {
    const session = await requireSession(request);
    return new Response(JSON.stringify({ user: { email: session.email } }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": hintCookie(session),
      },
    });
  }

  async function gateHtml(
    request: Request,
    options?: { publicPaths?: string[] },
  ): Promise<HtmlGateResult> {
    const url = new URL(request.url);
    if (
      !isDocumentRequest(request) ||
      options?.publicPaths?.some(
        (path) => url.pathname === path || url.pathname.startsWith(`${path}/`),
      )
    ) {
      return { kind: "proceed", session: null, setCookies: [] };
    }
    const session = await authenticate(request);
    if (session) return { kind: "proceed", session, setCookies: [hintCookie(session)] };
    const setCookies = [clearCookie(SESSION_COOKIE), clearCookie(AUTH_HINT_COOKIE, false)];
    if (url.searchParams.get("error") === "no_session")
      return { kind: "proceed", session: null, setCookies };
    return {
      kind: "redirect",
      response: withCookies(await autoLoginRedirect(`${url.pathname}${url.search}`), setCookies),
    };
  }

  return {
    authenticate,
    requireSession,
    withCookies,
    loginRedirect,
    autoLoginRedirect,
    handleCallback,
    logout,
    sessionEndpoint,
    gateHtml,
    serializeCookie,
    normalizeEmail,
    getCookie,
    isDocumentRequest,
    validateReturnTo,
  };
}
