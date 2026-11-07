import { formatCalendarDate, monthBoundaries } from "../domain/types";

export type CalendarDayTotals = { date: string; income: number; expense: number };
export type CalendarCell =
  | { kind: "blank"; key: string }
  | { kind: "day"; key: string; date: string; day: number; income: number; expense: number };

/** 0 = Sunday, 1 = Monday. Indonesian calendars start on Monday; US calendars on Sunday. */
export type WeekStart = 0 | 1;

export function weekStartForLocale(locale: string): WeekStart {
  return locale.startsWith("en-US") ? 0 : 1;
}

export function weekdayLabels(locale: string, weekStart: WeekStart): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, index) =>
    format.format(new Date(2023, 0, 1 + ((index + weekStart) % 7))),
  );
}

/** Weeks of a YYYY-MM month padded to whole rows, with each day's totals (zero when idle). */
export function calendarWeeks(
  month: string,
  days: readonly CalendarDayTotals[],
  weekStart: WeekStart,
): CalendarCell[][] {
  const totals = new Map(days.map((row) => [row.date, row]));
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = Number(monthBoundaries(month).end.slice(8, 10));
  const lead = (new Date(year, monthNumber - 1, 1).getDay() - weekStart + 7) % 7;
  const cells: CalendarCell[] = Array.from({ length: lead }, (_, index) => ({
    kind: "blank",
    key: `lead-${index}`,
  }));
  for (let day = 1; day <= lastDay; day++) {
    const date = formatCalendarDate(new Date(year, monthNumber - 1, day));
    const row = totals.get(date);
    cells.push({
      kind: "day",
      key: date,
      date,
      day,
      income: row?.income ?? 0,
      expense: row?.expense ?? 0,
    });
  }
  while (cells.length % 7) cells.push({ kind: "blank", key: `tail-${cells.length}` });
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** Spending shade step 0–4, relative to the month's busiest day; refunds and idle days are 0. */
export function spendingLevel(expense: number, maximum: number): number {
  if (expense <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.ceil((expense / maximum) * 4));
}

/** Days elapsed in the month as of `today`: all days for past months, none for future ones. */
export function elapsedDays(month: string, today: string): number {
  const { start, end } = monthBoundaries(month);
  const total = Number(end.slice(8, 10));
  if (today > end) return total;
  if (today < start) return 0;
  return Number(today.slice(8, 10));
}
