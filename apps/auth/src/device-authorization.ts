import { and, count, eq, gt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { hashToken, randomToken } from "@shedflare/auth-client/contract";
import { normalizeEmail } from "@shedflare/auth-client/consumer";
import type { InferOutput } from "valibot";
import type {
  DeviceApprovalSchema,
  DevicePollErrorSchema,
} from "@shedflare/auth-client/deployments";
import { agentAuthorizations, agentLoginFlows, agentTokens } from "./db/schema";
import { DEPLOYMENT_SCOPE } from "./tokens";

const LIFETIME_MS = 600_000;
const POLL_SECONDS = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function userCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const code = Array.from(bytes, (byte) => CODE_ALPHABET[byte & 31]).join("");
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

export function deviceAuthorizationStore(env: { AUTH_DB: D1Database; OWNER_EMAIL: string }) {
  const db = drizzle(env.AUTH_DB);
  const email = normalizeEmail(env.OWNER_EMAIL);

  async function start(name: string, requester: string) {
    const deviceCode = randomToken();
    const code = userCode();
    const now = Date.now();
    const requesterHash = await hashToken(requester);
    const recent = db
      .select({ value: count() })
      .from(agentAuthorizations)
      .where(
        and(
          eq(agentAuthorizations.requesterHash, requesterHash),
          gt(agentAuthorizations.createdAt, now - LIFETIME_MS),
        ),
      );
    // INSERT SELECT makes the per-address request budget atomic, including races.
    const [created] = await db
      .insert(agentAuthorizations)
      .select(
        db
          .select({
            deviceCodeHash: sql<string>`${await hashToken(deviceCode)}`.as("device_code_hash"),
            userCodeHash: sql<string>`${await hashToken(code)}`.as("user_code_hash"),
            requesterHash: sql<string>`${requesterHash}`.as("requester_hash"),
            email: sql<string>`${email}`.as("email"),
            name: sql<string>`${name}`.as("name"),
            status: sql<"pending">`'pending'`.as("status"),
            days: sql<number>`30`.as("days"),
            createdAt: sql<number>`${now}`.as("created_at"),
            expiresAt: sql<number>`${now + LIFETIME_MS}`.as("expires_at"),
            nextPollAt: sql<number>`${now + POLL_SECONDS * 1000}`.as("next_poll_at"),
            interval: sql<number>`${POLL_SECONDS}`.as("interval"),
          })
          .from(sql`(SELECT 1)`)
          .where(sql`(${recent}) < 10`),
      )
      .returning({ id: agentAuthorizations.deviceCodeHash });
    return created
      ? { deviceCode, userCode: code, expiresIn: LIFETIME_MS / 1000, interval: POLL_SECONDS }
      : null;
  }

  async function find(code: string) {
    const [record] = await db
      .select({
        name: agentAuthorizations.name,
        status: agentAuthorizations.status,
        expiresAt: agentAuthorizations.expiresAt,
      })
      .from(agentAuthorizations)
      .where(
        and(
          eq(agentAuthorizations.userCodeHash, await hashToken(code)),
          eq(agentAuthorizations.email, email),
          gt(agentAuthorizations.expiresAt, Date.now()),
        ),
      );
    return record ?? null;
  }

  async function decide(input: InferOutput<typeof DeviceApprovalSchema>) {
    const [record] = await db
      .update(agentAuthorizations)
      .set({
        status: input.decision === "approve" ? "approved" : "denied",
        days: input.decision === "approve" ? input.days : 30,
      })
      .where(
        and(
          eq(agentAuthorizations.userCodeHash, await hashToken(input.userCode)),
          eq(agentAuthorizations.email, email),
          eq(agentAuthorizations.status, "pending"),
          gt(agentAuthorizations.expiresAt, Date.now()),
        ),
      )
      .returning({ name: agentAuthorizations.name });
    return record ?? null;
  }

  async function poll(deviceCode: string) {
    const hash = await hashToken(deviceCode);
    const now = Date.now();
    const [record] = await db
      .select()
      .from(agentAuthorizations)
      .where(eq(agentAuthorizations.deviceCodeHash, hash));
    const error = (
      value: InferOutput<typeof DevicePollErrorSchema>["error"],
      interval?: number,
    ) => ({ kind: "error" as const, error: value, interval });
    if (
      !record ||
      record.email !== email ||
      record.expiresAt <= now ||
      record.status === "consumed"
    )
      return error("expired_token");
    if (record.status === "denied") return error("access_denied");
    // Reserve a polling slot atomically. Fast or concurrent polls must back off.
    const [slot] = await db
      .update(agentAuthorizations)
      .set({
        nextPollAt: sql`${now} + ${agentAuthorizations.interval} * 1000`,
      })
      .where(
        and(
          eq(agentAuthorizations.deviceCodeHash, hash),
          lte(agentAuthorizations.nextPollAt, now),
          gt(agentAuthorizations.expiresAt, now),
        ),
      )
      .returning({ interval: agentAuthorizations.interval });
    if (!slot) {
      const [slowed] = await db
        .update(agentAuthorizations)
        .set({
          interval: sql`min(${agentAuthorizations.interval} + 5, 600)`,
          nextPollAt: sql`${now} + min(${agentAuthorizations.interval} + 5, 600) * 1000`,
        })
        .where(eq(agentAuthorizations.deviceCodeHash, hash))
        .returning({ interval: agentAuthorizations.interval });
      return error("slow_down", slowed?.interval ?? POLL_SECONDS + 5);
    }
    if (record.status === "pending") return error("authorization_pending");
    const token = `sf_agent_${randomToken()}`;
    const id = crypto.randomUUID();
    const tokenHash = await hashToken(token);
    const eligible = and(
      eq(agentAuthorizations.deviceCodeHash, hash),
      eq(agentAuthorizations.status, "approved"),
      eq(agentAuthorizations.email, email),
      gt(agentAuthorizations.expiresAt, now),
    );
    // D1 batches are transactional: issue and consume together, or neither.
    // INSERT SELECT rechecks approval at the write boundary; only one poll wins.
    const [issued] = await db.batch([
      db
        .insert(agentTokens)
        .select(
          db
            .select({
              id: sql<string>`${id}`.as("id"),
              tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
              email: agentAuthorizations.email,
              name: agentAuthorizations.name,
              scope: sql<typeof DEPLOYMENT_SCOPE>`${DEPLOYMENT_SCOPE}`.as("scope"),
              createdAt: sql<number>`${now}`.as("created_at"),
              expiresAt: sql<number>`${now} + ${agentAuthorizations.days} * 86400000`.as(
                "expires_at",
              ),
              lastUsedAt: sql<number | null>`NULL`.as("last_used_at"),
            })
            .from(agentAuthorizations)
            .where(eligible),
        )
        .returning({
          name: agentTokens.name,
          scope: agentTokens.scope,
          expiresAt: agentTokens.expiresAt,
        }),
      db
        .update(agentAuthorizations)
        .set({ status: "consumed" })
        .where(
          and(
            eligible,
            sql`exists ${db.select({ id: agentTokens.id }).from(agentTokens).where(eq(agentTokens.id, id))}`,
          ),
        ),
    ]);
    if (issued[0]) return { kind: "authorized" as const, token, ...issued[0] };
    return error("authorization_pending");
  }

  async function cleanup() {
    const now = Date.now();
    await db.batch([
      db.delete(agentAuthorizations).where(lte(agentAuthorizations.expiresAt, now)),
      db.delete(agentLoginFlows).where(lte(agentLoginFlows.expiresAt, now)),
    ]);
  }

  return { start, find, decide, poll, cleanup };
}
