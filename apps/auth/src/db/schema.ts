import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const agentAuthorizations = sqliteTable(
  "agent_authorizations",
  {
    deviceCodeHash: text("device_code_hash").primaryKey(),
    userCodeHash: text("user_code_hash").notNull(),
    requesterHash: text("requester_hash").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "consumed"] }).notNull(),
    days: integer("days").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    nextPollAt: integer("next_poll_at").notNull(),
    interval: integer("interval").notNull(),
  },
  (table) => [
    uniqueIndex("agent_authorizations_user_code").on(table.userCodeHash),
    index("agent_authorizations_expiry").on(table.expiresAt),
    index("agent_authorizations_requester").on(table.requesterHash, table.createdAt),
  ],
);

export const agentLoginFlows = sqliteTable(
  "agent_login_flows",
  {
    tokenHash: text("token_hash").primaryKey(),
    userCode: text("user_code").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("agent_login_flows_expiry").on(table.expiresAt)],
);

export const agentTokens = sqliteTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    scope: text("scope", { enum: ["deployments:read"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    uniqueIndex("agent_tokens_hash").on(table.tokenHash),
    index("agent_tokens_expiry").on(table.expiresAt),
  ],
);

export const loginSessions = sqliteTable(
  "login_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    email: text("email").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("login_sessions_expiry").on(table.expiresAt)],
);

export const appSessions = sqliteTable(
  "app_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    loginId: text("login_id")
      .notNull()
      .references(() => loginSessions.tokenHash, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    origin: text("origin").notNull(),
  },
  (table) => [index("app_sessions_login").on(table.loginId)],
);

export const handoffs = sqliteTable(
  "handoffs",
  {
    codeHash: text("code_hash").primaryKey(),
    loginId: text("login_id")
      .notNull()
      .references(() => loginSessions.tokenHash, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    origin: text("origin").notNull(),
    challenge: text("challenge").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("handoffs_login").on(table.loginId),
    index("handoffs_expiry").on(table.expiresAt),
  ],
);

export const loginFlows = sqliteTable(
  "login_flows",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    origin: text("origin").notNull(),
    appState: text("app_state").notNull(),
    challenge: text("challenge").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("login_flows_expiry").on(table.expiresAt)],
);
