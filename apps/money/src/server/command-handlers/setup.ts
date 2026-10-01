import { eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { Db } from "../d1-access";
import type { CommandInvocation } from "../../domain/commands";
import type { CommandResult } from "../../domain/types";
import { nowIso } from "../../domain/types";
import { createAccount, createCategory, createCategoryGroup } from "../../domain/factories";
import { readSetupState } from "../../domain/setup";

export async function handleSetup(
  command: Extract<CommandInvocation, { commandType: "setup_money" }>,
  db: Db,
): Promise<CommandResult> {
  const p = command.payload;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(p)));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const [setting] = await db
    .select()
    .from(s.settings)
    .where(eq(s.settings.key, "money_setup"))
    .all();
  const previous = readSetupState(setting?.value);
  if (previous?.requestId === p.requestId) {
    if (previous.fingerprint !== fingerprint)
      return { ok: false, error: "Setup was saved. Close this form to view your money." };
    return {
      ok: true,
      data: { id: previous.state === "complete" ? previous.accountId : undefined },
    };
  }
  const [accounts, categories, transactions] = await Promise.all([
    db.select({ id: s.accounts.id }).from(s.accounts).limit(1).all(),
    db.select({ id: s.categories.id }).from(s.categories).limit(1).all(),
    db.select({ id: s.transactions.id }).from(s.transactions).limit(1).all(),
  ]);
  if (accounts.length || categories.length || transactions.length || previous?.state === "complete")
    return { ok: false, error: "Your money is already set up" };
  if (!p.requestId.trim()) return { ok: false, error: "Setup request is missing" };
  const now = nowIso();
  function saveSetting(key: string, value: string) {
    return db
      .insert(s.settings)
      .values({ id: `setting-${key}`, key, value, updatedAt: now })
      .onConflictDoUpdate({ target: s.settings.key, set: { value, updatedAt: now } });
  }
  const lock = () =>
    db.insert(s.settings).values({
      id: "setting-money_setup_lock",
      key: "money_setup_lock",
      value: p.requestId,
      updatedAt: now,
    });
  async function recover(): Promise<CommandResult | null> {
    const [saved] = await db
      .select()
      .from(s.settings)
      .where(eq(s.settings.key, "money_setup"))
      .all();
    const receipt = readSetupState(saved?.value);
    if (receipt?.requestId === p.requestId && receipt.fingerprint === fingerprint)
      return {
        ok: true,
        data: { id: receipt.state === "complete" ? receipt.accountId : undefined },
      };
    if (receipt?.state === "complete") return { ok: false, error: "Your money is already set up" };
    return null;
  }
  if (p.mode === "skip") {
    try {
      await db.batch([
        lock(),
        saveSetting("display_currency", p.currency),
        saveSetting("number_format", "auto"),
        saveSetting(
          "money_setup",
          JSON.stringify({ state: "skipped", requestId: p.requestId, fingerprint }),
        ),
        db.delete(s.settings).where(eq(s.settings.key, "money_setup_lock")),
      ]);
    } catch (caught) {
      const recovered = await recover();
      if (recovered) return recovered;
      throw caught;
    }
    return { ok: true, data: {} };
  }
  if (
    !p.account.name.trim() ||
    !Number.isSafeInteger(p.account.balance) ||
    (p.currency === "IDR" && p.account.balance % 100 !== 0)
  )
    return { ok: false, error: "Enter an account name and valid balance" };
  const names = p.categories.map((row) => row.name.trim().toLocaleLowerCase());
  if (names.some((name) => !name) || new Set(names).size !== names.length || names.length > 30)
    return { ok: false, error: "Choose distinct category names" };
  const account = createAccount({ name: p.account.name.trim(), balance: p.account.balance });
  const group = p.categories.some((row) => !row.isIncome)
    ? createCategoryGroup({ name: "Everyday" })
    : null;
  const rows = p.categories.map((category, sortOrder) =>
    createCategory({
      ...category,
      name: category.name.trim(),
      groupId: category.isIncome ? null : (group?.id ?? null),
      sortOrder,
    }),
  );
  try {
    await db.batch([
      lock(),
      db.insert(s.accounts).values(account),
      ...(group ? [db.insert(s.categoryGroups).values(group)] : []),
      ...rows.map((row) => db.insert(s.categories).values(row)),
      saveSetting("display_currency", p.currency),
      saveSetting("number_format", "auto"),
      saveSetting(
        "money_setup",
        JSON.stringify({
          state: "complete",
          requestId: p.requestId,
          fingerprint,
          accountId: account.id,
        }),
      ),
    ]);
  } catch (caught) {
    const recovered = await recover();
    if (recovered) return recovered;
    throw caught;
  }
  return { ok: true, data: { id: account.id } };
}
