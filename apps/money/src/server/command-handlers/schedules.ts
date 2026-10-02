import { eq } from "drizzle-orm";
import * as Schema from "effect/Schema";
import type { Db } from "../d1-access";
import * as s from "../../db/schema";
import { createSchedule, createTransaction } from "../../domain/factories";
import { nowIso, parseCalendarDate } from "../../domain/types";
import type { CommandInvocation } from "../../domain/commands";
import type { CommandResult } from "../../domain/types";
import type { Schedule } from "../../db/schema";

type ScheduleCommand =
  | "create_schedule"
  | "update_schedule"
  | "delete_schedule"
  | "skip_schedule_date"
  | "undo_schedule_payment"
  | "post_schedule_transaction";

type RecurrenceConfig = {
  type?: string;
  skipWeekend?: boolean;
  weekendSolveMode?: "before" | "after";
  endMode?: "never" | "after_n" | "after_n_occurrences" | "on_date";
  endOccurrences?: number;
  endDate?: string;
};

const RecurrenceConfigSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  skipWeekend: Schema.optional(Schema.Boolean),
  weekendSolveMode: Schema.optional(Schema.Literals(["before", "after"])),
  endMode: Schema.optional(Schema.Literals(["never", "after_n", "after_n_occurrences", "on_date"])),
  endOccurrences: Schema.optional(Schema.Number),
  endDate: Schema.optional(Schema.String),
});
const RecurrenceInputSchema = Schema.Union([RecurrenceConfigSchema, Schema.String]);

function parseRecurrenceConfig(rules: string): RecurrenceConfig {
  try {
    const parsed = Schema.decodeUnknownSync(RecurrenceInputSchema)(JSON.parse(rules));
    return parsed instanceof Object ? parsed : { type: parsed };
  } catch {
    return { type: rules || "monthly" };
  }
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function applyWeekendHandling(date: Date, config: RecurrenceConfig): Date {
  if (!config.skipWeekend) return date;
  const day = date.getUTCDay();
  const next = new Date(date);
  if (day === 6)
    next.setUTCDate(next.getUTCDate() + (config.weekendSolveMode === "before" ? -1 : 2));
  if (day === 0)
    next.setUTCDate(next.getUTCDate() + (config.weekendSolveMode === "before" ? -2 : 1));
  return next;
}

function nextScheduleState(
  schedule: Schedule,
): Pick<Schedule, "nextDate" | "completed" | "recurrenceRules"> {
  const config = parseRecurrenceConfig(schedule.recurrenceRules);
  const current = new Date(
    `${schedule.nextDate ?? schedule.startDate ?? toDateOnly(new Date())}T00:00:00.000Z`,
  );
  const type = config.type ?? "monthly";
  const next =
    type === "daily"
      ? new Date(current.setUTCDate(current.getUTCDate() + 1))
      : type === "weekly"
        ? new Date(current.setUTCDate(current.getUTCDate() + 7))
        : type === "biweekly"
          ? new Date(current.setUTCDate(current.getUTCDate() + 14))
          : type === "quarterly"
            ? addMonths(current, 3)
            : type === "yearly"
              ? addMonths(current, 12)
              : addMonths(current, 1);
  const nextDate = toDateOnly(applyWeekendHandling(next, config));
  const remainingOccurrences =
    config.endMode === "after_n" || config.endMode === "after_n_occurrences"
      ? config.endOccurrences
      : undefined;
  const completedByCount = remainingOccurrences !== undefined && remainingOccurrences <= 1;
  const completedByDate =
    config.endMode === "on_date" && !!config.endDate && nextDate > config.endDate;
  const nextConfig = { ...config };
  if (remainingOccurrences !== undefined) {
    nextConfig.endOccurrences = Math.max(remainingOccurrences - 1, 0);
  }
  return {
    nextDate: completedByCount || completedByDate ? null : nextDate,
    completed: completedByCount || completedByDate,
    recurrenceRules: JSON.stringify(nextConfig),
  };
}

type ScheduleInvocation = Extract<CommandInvocation, { commandType: ScheduleCommand }>;

export async function handleScheduleCommands(
  command: ScheduleInvocation,
  db: Db,
): Promise<CommandResult> {
  switch (command.commandType) {
    case "undo_schedule_payment": {
      const p = command.payload;
      const [transaction] = await db
        .select()
        .from(s.transactions)
        .where(eq(s.transactions.id, p.transactionId))
        .all();
      const [schedule] = await db
        .select()
        .from(s.schedules)
        .where(eq(s.schedules.id, p.scheduleId))
        .all();
      if (
        !transaction ||
        !schedule ||
        transaction.scheduleId !== schedule.id ||
        transaction.reconciled
      )
        return { ok: false, error: "This payment can no longer be undone" };
      if (p.nextDate && !parseCalendarDate(p.nextDate))
        return { ok: false, error: "Choose a valid payment date" };
      await db.batch([
        db.delete(s.transactions).where(eq(s.transactions.id, transaction.id)),
        db
          .update(s.schedules)
          .set({
            nextDate: p.nextDate,
            completed: p.completed,
            recurrenceRules: p.recurrenceRules,
            updatedAt: nowIso(),
          })
          .where(eq(s.schedules.id, schedule.id)),
      ]);
      return { ok: true, data: { id: schedule.id } };
    }
    case "create_schedule": {
      const pp = command.payload;
      if (
        pp.schedule.amount !== undefined &&
        pp.schedule.amount !== null &&
        !Number.isSafeInteger(pp.schedule.amount)
      )
        return { ok: false, error: "Enter a valid whole amount" };
      for (const date of [pp.schedule.startDate, pp.schedule.nextDate])
        if (date !== undefined && date !== null && !parseCalendarDate(date))
          return { ok: false, error: "Choose a valid payment date" };
      const row = createSchedule(pp.schedule);
      await db.insert(s.schedules).values(row).run();
      return { ok: true, data: { id: row.id } };
    }
    case "update_schedule": {
      const pp = command.payload;
      const [existing] = await db.select().from(s.schedules).where(eq(s.schedules.id, pp.id)).all();
      if (!existing) return { ok: false, error: "Payment no longer exists" };
      const set: Partial<typeof s.schedules.$inferInsert> = { updatedAt: nowIso() };
      const f = pp.fields;
      if (f.amount !== undefined && f.amount !== null && !Number.isSafeInteger(f.amount))
        return { ok: false, error: "Enter a valid whole amount" };
      for (const date of [f.startDate, f.nextDate])
        if (date !== undefined && date !== null && !parseCalendarDate(date))
          return { ok: false, error: "Choose a valid payment date" };
      if (f.name !== undefined) set.name = f.name;
      if (f.accountId !== undefined) set.accountId = f.accountId;
      if (f.payeeId !== undefined) set.payeeId = f.payeeId;
      if (f.categoryId !== undefined) set.categoryId = f.categoryId;
      if (f.amount !== undefined) set.amount = f.amount;
      if (f.recurrenceRules !== undefined) set.recurrenceRules = f.recurrenceRules;
      if (f.startDate !== undefined) set.startDate = f.startDate;
      if (f.nextDate !== undefined) set.nextDate = f.nextDate;
      if (f.active !== undefined) set.active = f.active;
      if (f.completed !== undefined) set.completed = f.completed;
      if (f.postsTransaction !== undefined) set.postsTransaction = f.postsTransaction;
      if (f.customUpcomingLength !== undefined) set.customUpcomingLength = f.customUpcomingLength;
      await db.update(s.schedules).set(set).where(eq(s.schedules.id, pp.id)).run();
      return { ok: true, data: { id: pp.id } };
    }
    case "delete_schedule": {
      const pp = command.payload;
      await db.delete(s.schedules).where(eq(s.schedules.id, pp.id)).run();
      return { ok: true, data: { id: pp.id } };
    }
    case "skip_schedule_date": {
      const pp = command.payload;
      const [schedule] = await db.select().from(s.schedules).where(eq(s.schedules.id, pp.id)).all();
      if (!schedule) return { ok: false, error: "Schedule not found" };
      if (!schedule.active || schedule.completed)
        return { ok: false, error: "This payment is paused or finished" };
      const next = nextScheduleState(schedule);
      await db
        .update(s.schedules)
        .set({ ...next, updatedAt: nowIso() })
        .where(eq(s.schedules.id, pp.id))
        .run();
      return { ok: true, data: { id: pp.id, ...next } };
    }
    case "post_schedule_transaction": {
      const pp = command.payload;
      const [schedule] = await db
        .select()
        .from(s.schedules)
        .where(eq(s.schedules.id, pp.scheduleId))
        .all();
      if (!schedule) return { ok: false, error: "Schedule not found" };
      if (!schedule.active || schedule.completed)
        return { ok: false, error: "This payment is paused or finished" };
      if (!schedule.accountId) return { ok: false, error: "Schedule has no account" };
      if (schedule.amount === null) return { ok: false, error: "Schedule has no amount" };
      if (!Number.isSafeInteger(schedule.amount))
        return { ok: false, error: "Enter a valid whole amount" };
      const [account] = await db
        .select()
        .from(s.accounts)
        .where(eq(s.accounts.id, schedule.accountId))
        .all();
      if (!account || account.closed) return { ok: false, error: "Choose an open account" };

      const [payee] = schedule.payeeId
        ? await db
            .select({ name: s.payees.name })
            .from(s.payees)
            .where(eq(s.payees.id, schedule.payeeId))
            .all()
        : [];
      const paymentDate = pp.date ?? toDateOnly(new Date());
      if (!parseCalendarDate(paymentDate))
        return { ok: false, error: "Choose a valid payment date" };
      const transaction = createTransaction({
        accountId: schedule.accountId,
        categoryId: schedule.categoryId,
        amount: schedule.amount,
        payee: payee?.name ?? schedule.name,
        date: paymentDate,
        scheduleId: schedule.id,
      });
      const next = nextScheduleState(schedule);
      await db.batch([
        db.insert(s.transactions).values(transaction),
        db
          .update(s.schedules)
          .set({ ...next, updatedAt: nowIso() })
          .where(eq(s.schedules.id, pp.scheduleId)),
      ]);
      return { ok: true, data: { id: pp.scheduleId, transactionId: transaction.id, ...next } };
    }
    default:
      return { ok: false, error: "Unknown schedule command" };
  }
}
