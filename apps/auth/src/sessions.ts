import { and, eq, gt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { safeParse } from "valibot";
import {
  ExchangeRequestSchema,
  SessionRequestSchema,
  hashToken,
  isToken,
  randomToken,
  type ExchangeResult,
  type SessionResult,
  type ExchangeRequest,
  type SessionRequest,
} from "@shedflare/auth-client/contract";
import { normalizeEmail } from "@shedflare/auth-client/consumer";
import { isAllowedClient } from "./clients";
import { appSessions, loginFlows, handoffs, loginSessions } from "./db/schema";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const HANDOFF_TTL_MS = 60_000;

export function sessionStore(env: {
  AUTH_DB: D1Database;
  OWNER_EMAIL: string;
  ALLOWED_CLIENTS: string;
}) {
  // Deliberately use the primary database, without D1 read-replica sessions.
  // Every validation observes completed revocations; no positive session cache.
  const db = drizzle(env.AUTH_DB);

  async function loginSession(token: string) {
    if (!isToken(token)) return null;
    const [row] = await db
      .select()
      .from(loginSessions)
      .where(
        and(
          eq(loginSessions.tokenHash, await hashToken(token)),
          eq(loginSessions.email, normalizeEmail(env.OWNER_EMAIL)),
          gt(loginSessions.expiresAt, Date.now()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function createLogin(email: string) {
    if (normalizeEmail(email) !== normalizeEmail(env.OWNER_EMAIL))
      throw new Error("Owner required");
    const token = randomToken();
    const row = {
      tokenHash: await hashToken(token),
      email: normalizeEmail(email),
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };
    await db.insert(loginSessions).values(row);
    return { token, ...row };
  }

  async function createHandoff(input: {
    loginId: string;
    clientId: string;
    origin: string;
    challenge: string;
  }) {
    const code = randomToken();
    await db.insert(handoffs).values({
      ...input,
      codeHash: await hashToken(code),
      expiresAt: Date.now() + HANDOFF_TTL_MS,
    });
    return code;
  }

  async function exchangeCode(input: ExchangeRequest): Promise<ExchangeResult> {
    const parsed = safeParse(ExchangeRequestSchema, input);
    if (!parsed.success) return { kind: "invalid" };
    const { clientId, origin, code, verifier } = parsed.output;
    if (
      !isAllowedClient(env.ALLOWED_CLIENTS, clientId, origin) ||
      !isToken(code) ||
      !isToken(verifier)
    )
      return { kind: "invalid" };
    // DELETE RETURNING consumes exactly once, including simultaneous exchanges.
    const [grant] = await db
      .delete(handoffs)
      .where(
        and(
          eq(handoffs.codeHash, await hashToken(code)),
          eq(handoffs.challenge, await hashToken(verifier)),
          eq(handoffs.clientId, clientId),
          eq(handoffs.origin, origin),
          gt(handoffs.expiresAt, Date.now()),
        ),
      )
      .returning();
    if (!grant) return { kind: "invalid" };
    const token = randomToken();
    // INSERT SELECT also checks the parent at the write boundary. Logout racing
    // an exchange cannot create a session after its parent was revoked.
    const [created] = await db
      .insert(appSessions)
      .select(
        db
          .select({
            tokenHash: sql<string>`${await hashToken(token)}`.as("token_hash"),
            loginId: loginSessions.tokenHash,
            clientId: sql<string>`${clientId}`.as("client_id"),
            origin: sql<string>`${origin}`.as("origin"),
          })
          .from(loginSessions)
          .where(
            and(
              eq(loginSessions.tokenHash, grant.loginId),
              eq(loginSessions.email, normalizeEmail(env.OWNER_EMAIL)),
              gt(loginSessions.expiresAt, Date.now()),
            ),
          ),
      )
      .returning();
    if (!created) return { kind: "invalid" };
    const result = await validateSession({ clientId, origin, token });
    return result.kind === "authenticated" ? { ...result, token } : result;
  }

  async function validateSession(input: SessionRequest): Promise<SessionResult> {
    const parsed = safeParse(SessionRequestSchema, input);
    if (!parsed.success) return { kind: "invalid" };
    const { clientId, origin, token } = parsed.output;
    if (!isAllowedClient(env.ALLOWED_CLIENTS, clientId, origin) || !isToken(token))
      return { kind: "invalid" };
    const [session] = await db
      .select({ email: loginSessions.email, expiresAt: loginSessions.expiresAt })
      .from(appSessions)
      .innerJoin(loginSessions, eq(appSessions.loginId, loginSessions.tokenHash))
      .where(
        and(
          eq(appSessions.tokenHash, await hashToken(token)),
          eq(appSessions.clientId, clientId),
          eq(appSessions.origin, origin),
          eq(loginSessions.email, normalizeEmail(env.OWNER_EMAIL)),
          gt(loginSessions.expiresAt, Date.now()),
        ),
      )
      .limit(1);
    return session ? { kind: "authenticated", session } : { kind: "invalid" };
  }

  async function revokeSession(input: SessionRequest) {
    const parsed = safeParse(SessionRequestSchema, input);
    if (!parsed.success) return;
    const { clientId, origin, token } = parsed.output;
    if (!isAllowedClient(env.ALLOWED_CLIENTS, clientId, origin) || !isToken(token)) return;
    const parent = db
      .select({ id: appSessions.loginId })
      .from(appSessions)
      .where(
        and(
          eq(appSessions.tokenHash, await hashToken(token)),
          eq(appSessions.clientId, clientId),
          eq(appSessions.origin, origin),
        ),
      );
    await db.delete(loginSessions).where(eq(loginSessions.tokenHash, parent));
  }

  async function revokeLogin(token: string) {
    if (isToken(token))
      await db.delete(loginSessions).where(eq(loginSessions.tokenHash, await hashToken(token)));
  }

  async function cleanup() {
    await db.batch([
      db.delete(loginSessions).where(lte(loginSessions.expiresAt, Date.now())),
      db.delete(handoffs).where(lte(handoffs.expiresAt, Date.now())),
      db.delete(loginFlows).where(lte(loginFlows.expiresAt, Date.now())),
    ]);
  }

  return {
    db,
    loginSession,
    createLogin,
    createHandoff,
    exchangeCode,
    validateSession,
    revokeSession,
    revokeLogin,
    cleanup,
  };
}
