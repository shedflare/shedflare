import { and, desc, eq, gt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { hashToken, isToken, randomToken } from "@shedflare/auth-client/contract";
import { normalizeEmail } from "@shedflare/auth-client/consumer";
import { agentTokens } from "./db/schema";

const TOKEN_PREFIX = "sf_agent_";
export const DEPLOYMENT_SCOPE = "deployments:read";

export function agentTokenStore(env: { AUTH_DB: D1Database; OWNER_EMAIL: string }) {
  const db = drizzle(env.AUTH_DB);
  const email = normalizeEmail(env.OWNER_EMAIL);
  // Tokens are independent of browser logins. Only metadata and SHA-256 hashes
  // persist; expiry and explicit revocation are checked on the D1 primary.
  const metadata = {
    id: agentTokens.id,
    name: agentTokens.name,
    scope: agentTokens.scope,
    createdAt: agentTokens.createdAt,
    expiresAt: agentTokens.expiresAt,
    lastUsedAt: agentTokens.lastUsedAt,
  };

  async function create(input: { name: string; days: number }) {
    const token = `${TOKEN_PREFIX}${randomToken()}`;
    const createdAt = Date.now();
    const [record] = await db
      .insert(agentTokens)
      .values({
        id: crypto.randomUUID(),
        tokenHash: await hashToken(token),
        email,
        name: input.name,
        scope: DEPLOYMENT_SCOPE,
        createdAt,
        expiresAt: createdAt + input.days * 86_400_000,
      })
      .returning(metadata);
    if (!record) throw new Error("Could not create agent token");
    return { token, ...record };
  }

  async function list() {
    return db
      .select(metadata)
      .from(agentTokens)
      .where(eq(agentTokens.email, email))
      .orderBy(desc(agentTokens.createdAt));
  }

  async function revoke(id: string) {
    await db.delete(agentTokens).where(and(eq(agentTokens.id, id), eq(agentTokens.email, email)));
  }

  async function authenticate(request: Request) {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer (sf_agent_[A-Za-z0-9_-]{43})$/i.exec(header);
    const token = match?.[1];
    if (!token || !token.startsWith(TOKEN_PREFIX) || !isToken(token.slice(TOKEN_PREFIX.length)))
      return null;
    const now = Date.now();
    // UPDATE RETURNING validates and records use in one statement. A completed
    // revocation cannot be bypassed by a cached or previously selected record.
    const [record] = await db
      .update(agentTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(agentTokens.tokenHash, await hashToken(token)),
          eq(agentTokens.email, email),
          eq(agentTokens.scope, DEPLOYMENT_SCOPE),
          gt(agentTokens.expiresAt, now),
        ),
      )
      .returning(metadata);
    return record ?? null;
  }

  async function cleanup() {
    await db.delete(agentTokens).where(lte(agentTokens.expiresAt, Date.now()));
  }

  return { create, list, revoke, authenticate, cleanup };
}

export type AgentTokenMetadata = Awaited<
  ReturnType<ReturnType<typeof agentTokenStore>["list"]>
>[number];
