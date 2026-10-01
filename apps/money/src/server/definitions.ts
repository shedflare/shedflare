import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

// ── Upload endpoints ────────────────────────────────────────────────

export const uploadsGroup = HttpApiGroup.make("uploads").add(
  HttpApiEndpoint.put("upload", "/api/upload"),
  HttpApiEndpoint.get("download", "/api/upload/:key"),
);

// ── Accounts ────────────────────────────────────────────────────────

export const accountsGroup = HttpApiGroup.make("accounts").add(
  HttpApiEndpoint.get("list", "/api/accounts"),
  HttpApiEndpoint.get("get", "/api/accounts/:id"),
  HttpApiEndpoint.get("transactions", "/api/accounts/:id/transactions"),
  HttpApiEndpoint.get("tags", "/api/accounts/:id/tags"),
);

// ── Transactions ────────────────────────────────────────────────────

export const transactionsGroup = HttpApiGroup.make("transactions").add(
  HttpApiEndpoint.get("list", "/api/transactions"),
);

// ── Categories ──────────────────────────────────────────────────────

export const categoriesGroup = HttpApiGroup.make("categories").add(
  HttpApiEndpoint.get("list", "/api/categories"),
  HttpApiEndpoint.get("groups", "/api/category-groups"),
  HttpApiEndpoint.get("goalProgress", "/api/categories/goal-progress"),
);

// ── Budget ──────────────────────────────────────────────────────────

export const budgetGroup = HttpApiGroup.make("budget").add(
  HttpApiEndpoint.get("overview", "/api/budget/overview"),
  HttpApiEndpoint.get("month", "/api/budget/:month"),
);

// ── Payees ──────────────────────────────────────────────────────────

export const payeesGroup = HttpApiGroup.make("payees").add(
  HttpApiEndpoint.get("list", "/api/payees"),
  HttpApiEndpoint.get("suggestions", "/api/payees/category-suggestions"),
);

// ── Schedules ───────────────────────────────────────────────────────

export const schedulesGroup = HttpApiGroup.make("schedules").add(
  HttpApiEndpoint.get("list", "/api/schedules"),
  HttpApiEndpoint.get("get", "/api/schedules/:id"),
  HttpApiEndpoint.get("discover", "/api/schedules/discover"),
);

// ── Rules ───────────────────────────────────────────────────────────

export const rulesGroup = HttpApiGroup.make("rules").add(HttpApiEndpoint.get("list", "/api/rules"));

// ── Tags ────────────────────────────────────────────────────────────

export const tagsGroup = HttpApiGroup.make("tags").add(HttpApiEndpoint.get("list", "/api/tags"));

// ── Filters ─────────────────────────────────────────────────────────

export const filtersGroup = HttpApiGroup.make("filters").add(
  HttpApiEndpoint.get("list", "/api/filters"),
);

// ── Reports ─────────────────────────────────────────────────────────

export const reportsGroup = HttpApiGroup.make("reports").add(
  HttpApiEndpoint.get("monthly", "/api/reports/monthly/:month"),
  HttpApiEndpoint.get("netWorth", "/api/reports/net-worth"),
  HttpApiEndpoint.get("cashFlow", "/api/reports/cash-flow"),
  HttpApiEndpoint.get("spending", "/api/reports/spending"),
  HttpApiEndpoint.get("budgetAnalysis", "/api/reports/budget-analysis"),
  HttpApiEndpoint.get("ageOfMoney", "/api/reports/age-of-money"),
  HttpApiEndpoint.get("crossover", "/api/reports/crossover"),
  HttpApiEndpoint.get("calendarHeatmap", "/api/reports/calendar-heatmap"),
  HttpApiEndpoint.get("customList", "/api/reports/custom"),
  HttpApiEndpoint.get("customExecute", "/api/reports/custom/:id/execute"),
);

// ── Dashboard ───────────────────────────────────────────────────────

export const dashboardGroup = HttpApiGroup.make("dashboard").add(
  HttpApiEndpoint.get("widgets", "/api/dashboard/widgets"),
  HttpApiEndpoint.get("export", "/api/dashboard/export"),
);

// ── Command ─────────────────────────────────────────────────────────

export const commandGroup = HttpApiGroup.make("command").add(
  HttpApiEndpoint.post("execute", "/api/command"),
);

// ── Data ────────────────────────────────────────────────────────────

export const dataGroup = HttpApiGroup.make("data").add(HttpApiEndpoint.get("dump", "/api/data"));

// ── Export ──────────────────────────────────────────────────────────

export const exportGroup = HttpApiGroup.make("export").add(
  HttpApiEndpoint.get("csv", "/api/export/csv"),
);

// ── Rates ───────────────────────────────────────────────────────────

export const ratesGroup = HttpApiGroup.make("rates").add(HttpApiEndpoint.get("get", "/api/rates"));

// ── Settings ────────────────────────────────────────────────────────

export const settingsGroup = HttpApiGroup.make("settings").add(
  HttpApiEndpoint.get("get", "/api/settings"),
);

// ── Money API root ─────────────────────────────────────────────────

export const moneyApi = HttpApi.make("money").add(
  uploadsGroup,
  accountsGroup,
  transactionsGroup,
  categoriesGroup,
  budgetGroup,
  payeesGroup,
  schedulesGroup,
  rulesGroup,
  tagsGroup,
  filtersGroup,
  reportsGroup,
  dashboardGroup,
  commandGroup,
  dataGroup,
  exportGroup,
  ratesGroup,
  settingsGroup,
);
