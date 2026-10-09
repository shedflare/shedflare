import { MonthlyReportSchema } from "../domain/monthly-report";
import { PayeeHistorySchema } from "../domain/payee-history";
/**
 * Schema-validated REST API client for the money app.
 * Every response is decoded against an Effect Schema at runtime.
 */

import * as S from "effect/Schema";
import {
  SettingsResponseSchema,
  AccountsResponseSchema,
  AccountApiSchema,
  AccountTransactionsResponseSchema,
  AccountTagsResponseSchema,
  TransactionsResponseSchema,
  CategoriesResponseSchema,
  CategoryGroupsResponseSchema,
  GoalProgressResponseSchema,
  BudgetOverviewResponseSchema,
  MonthBudgetResponseSchema,
  PayeesResponseSchema,
  PayeeSuggestionsResponseSchema,
  SchedulesResponseSchema,
  ScheduleResponseSchema,
  SchedulesDiscoverResponseSchema,
  RulesResponseSchema,
  TagsResponseSchema,
  FiltersResponseSchema,
  ReportsNetWorthResponseSchema,
  ReportsCashFlowResponseSchema,
  ReportsSpendingResponseSchema,
  ReportsBudgetAnalysisResponseSchema,
  ReportsAgeOfMoneyResponseSchema,
  ReportsCrossoverResponseSchema,
  ReportsHeatmapResponseSchema,
  CustomReportsResponseSchema,
  CustomReportResultSchema,
  DashboardWidgetsResponseSchema,
  DashboardExportSchema,
  RatesResponseSchema,
  CommandResponseSchema,
} from "../domain/schemas-client";

const BASE = ""; // same-origin

type AnyDecoder = Parameters<typeof S.decodeUnknownSync>[0];
const ErrorResponseSchema = S.Struct({ error: S.String });

/**
 * Fetch and decode an API response against an Effect Schema.
 * Throws if the response status is not OK or if schema decoding fails.
 */
export async function fetchApi<SchemaType extends AnyDecoder>(
  schema: SchemaType,
  path: string,
): Promise<SchemaType["Type"]> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return S.decodeUnknownSync(schema)(data);
}

export type CommandResponse = S.Schema.Type<typeof CommandResponseSchema>;
export type CommandType = string;
export type CommandPayload = object;

/**
 * Execute a command via POST /api/command.
 */
export type TransactionListQuery = {
  filterId?: string;
  conditions?: Array<{
    field: string;
    op: string;
    value: string | number | boolean | null | string[];
    value2?: string | number | boolean | null | string[];
  }>;
  conditionsOp?: "and" | "or";
};

function transactionQueryParams(query?: TransactionListQuery): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.filterId) params.set("filter", query.filterId);
  if (query.conditions && query.conditions.length > 0) {
    params.set("conditions", JSON.stringify(query.conditions));
    params.set("conditionsOp", query.conditionsOp ?? "and");
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function execute<Payload>(
  commandType: CommandType,
  payload: Payload,
): Promise<CommandResponse> {
  const res = await fetch(`${BASE}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandType, payload }),
  });
  const data = await res.json();
  if (!res.ok) {
    let message = `API error: ${res.status}`;
    try {
      message = S.decodeUnknownSync(ErrorResponseSchema)(data).error;
    } catch {
      // The fallback already carries the HTTP status when the server body is not an error payload.
    }
    return { ok: false, error: message };
  }
  return S.decodeUnknownSync(CommandResponseSchema)(data);
}

// ── Typed API functions ────────────────────────────────────────────────

export const api = {
  settings: () => fetchApi(SettingsResponseSchema, "/api/settings"),
  accounts: () => fetchApi(AccountsResponseSchema, "/api/accounts"),
  account: (id: string) => fetchApi(AccountApiSchema, `/api/accounts/${id}`),
  accountTransactions: (id: string, query?: string | TransactionListQuery) => {
    const params =
      query instanceof Object
        ? transactionQueryParams(query)
        : query
          ? `?filter=${encodeURIComponent(query)}`
          : "";
    return fetchApi(AccountTransactionsResponseSchema, `/api/accounts/${id}/transactions${params}`);
  },
  accountTags: (id: string) => fetchApi(AccountTagsResponseSchema, `/api/accounts/${id}/tags`),

  transactions: (query?: string | TransactionListQuery) => {
    const params =
      query instanceof Object
        ? transactionQueryParams(query)
        : query
          ? `?filter=${encodeURIComponent(query)}`
          : "";
    return fetchApi(TransactionsResponseSchema, `/api/transactions${params}`);
  },

  categories: () => fetchApi(CategoriesResponseSchema, "/api/categories"),
  categoryGroups: () => fetchApi(CategoryGroupsResponseSchema, "/api/category-groups"),
  goalProgress: () => fetchApi(GoalProgressResponseSchema, "/api/categories/goal-progress"),

  budgetOverview: () => fetchApi(BudgetOverviewResponseSchema, "/api/budget/overview"),
  budgetMonth: (monthInt: number) => fetchApi(MonthBudgetResponseSchema, `/api/budget/${monthInt}`),

  payees: () => fetchApi(PayeesResponseSchema, "/api/payees"),
  payeeHistory: () => fetchApi(PayeeHistorySchema, "/api/payees/history"),
  payeeSuggestions: (payee: string) =>
    fetchApi(
      PayeeSuggestionsResponseSchema,
      `/api/payees/category-suggestions?payee=${encodeURIComponent(payee)}`,
    ),

  schedules: () => fetchApi(SchedulesResponseSchema, "/api/schedules"),
  schedule: (id: string) => fetchApi(ScheduleResponseSchema, `/api/schedules/${id}`),
  schedulesDiscover: () => fetchApi(SchedulesDiscoverResponseSchema, "/api/schedules/discover"),

  rules: () => fetchApi(RulesResponseSchema, "/api/rules"),
  tags: () => fetchApi(TagsResponseSchema, "/api/tags"),
  filters: () => fetchApi(FiltersResponseSchema, "/api/filters"),

  reports: {
    monthly: (month: string) =>
      fetchApi(MonthlyReportSchema, `/api/reports/monthly/${encodeURIComponent(month)}`),
    netWorth: () => fetchApi(ReportsNetWorthResponseSchema, "/api/reports/net-worth"),
    cashFlow: () => fetchApi(ReportsCashFlowResponseSchema, "/api/reports/cash-flow"),
    spending: () => fetchApi(ReportsSpendingResponseSchema, "/api/reports/spending"),
    budgetAnalysis: (month?: string) =>
      fetchApi(
        ReportsBudgetAnalysisResponseSchema,
        month
          ? `/api/reports/budget-analysis?month=${encodeURIComponent(month)}`
          : "/api/reports/budget-analysis",
      ),
    ageOfMoney: () => fetchApi(ReportsAgeOfMoneyResponseSchema, "/api/reports/age-of-money"),
    crossover: () => fetchApi(ReportsCrossoverResponseSchema, "/api/reports/crossover"),
    calendarHeatmap: () => fetchApi(ReportsHeatmapResponseSchema, "/api/reports/calendar-heatmap"),
    custom: () => fetchApi(CustomReportsResponseSchema, "/api/reports/custom"),
    customExecute: (id: string) =>
      fetchApi(CustomReportResultSchema, `/api/reports/custom/${id}/execute`),
  },

  dashboard: {
    widgets: () => fetchApi(DashboardWidgetsResponseSchema, "/api/dashboard/widgets"),
    export: () => fetchApi(DashboardExportSchema, "/api/dashboard/export"),
  },

  rates: () => fetchApi(RatesResponseSchema, "/api/rates"),
};
