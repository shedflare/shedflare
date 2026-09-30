import type { AuthRpc } from "@shedflare/auth-client/contract";
/**
 * Shared env factory for money tests.
 * Mirrors the surface money's worker hands to `createRouter(env)`.
 */
import { D1Shim } from "@shedflare/test-utils/d1-shim";
import { R2Mock } from "@shedflare/test-utils/r2-mock";
import { createDb } from "../server/d1-access";
import { createMoneyTestD1 } from "./d1-shim";

export type MoneyTestEnv = {
  MONEY_DB: D1Shim;
  UPLOADS: R2Mock;
  AUTH: AuthRpc;
  AUTH_URL: string;
  AUTH_CLIENT_ID: string;
  APP_PUBLIC_URL: string;
  OWNER_EMAIL: string;
  DEV_AUTH_EMAIL: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
};

export function createMoneyTestEnv(overrides?: Partial<MoneyTestEnv>): MoneyTestEnv {
  return {
    MONEY_DB: createMoneyTestD1(),
    UPLOADS: new R2Mock(),
    AUTH: {
      async validateSession() {
        throw new Error("Unexpected Auth RPC in local test");
      },
      async exchangeCode() {
        throw new Error("Unexpected Auth RPC in local test");
      },
      async revokeSession() {
        throw new Error("Unexpected Auth RPC in local test");
      },
    },
    AUTH_URL: "https://auth.test.example.com",
    AUTH_CLIENT_ID: "shedflare-money-test",
    APP_PUBLIC_URL: "https://money.test.example.com",
    OWNER_EMAIL: "test@example.com",
    DEV_AUTH_EMAIL: "test@example.com",
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    ...overrides,
  };
}

/**
 * Build a Drizzle Db from a money test env.
 * The returned Db matches the type signature used by the server's
 * `createDb(env.MONEY_DB)`, so handler code can run unmodified.
 */
export function dbFor(env: MoneyTestEnv) {
  // SAFETY: The published shim implements the D1 methods Drizzle exercises in these tests.
  return createDb(env.MONEY_DB as D1Shim & D1Database);
}

export type Db = ReturnType<typeof dbFor>;
