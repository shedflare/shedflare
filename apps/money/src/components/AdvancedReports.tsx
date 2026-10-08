import { createSignal, createEffect, For, onCleanup, onMount, Show } from "solid-js";
import { AreaChart, BarChart, DonutChart, BudgetBar, CHART_COLORS } from "../charts";
import type { TimeSeriesPoint, BarGroup, PieSlice, BudgetPair } from "../charts";
import { dispatch } from "../lib/pending-ops";
import { api } from "../lib/api";
import { useCurrency, formatCentsValue, type NumberFormat } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { PageState } from "../components/PageState";
import { listenForMoneyDataChanged } from "../lib/data-events";
import * as Schema from "effect/Schema";
import type { CustomReportResult, CustomReportsResponse } from "../domain/schemas-client";

type ReportId =
  | "net-worth"
  | "cash-flow"
  | "spending"
  | "budget-analysis"
  | "age-of-money"
  | "custom";

type CustomReport = CustomReportsResponse["reports"][number];
type CustomReportRow = CustomReportResult["rows"][number];
type ReportCell = CustomReportRow[keyof CustomReportRow];
type ConditionalFormat = { field: string; op: string; value: string; color: string };
const REPORT_COLUMNS = [
  "id",
  "date",
  "amount",
  "payee",
  "notes",
  "cleared",
  "reconciled",
  "category",
  "account",
  "month",
  "total",
  "count",
  "groupName",
] as const satisfies ReadonlyArray<keyof CustomReportRow>;

const NumberFormatSchema = Schema.Literals(["comma-dot", "dot-comma", "space-dot"]);
const NumberFormatFormSchema = Schema.Union([NumberFormatSchema, Schema.Literal("")]);
const ReportMetadataSchema = Schema.Struct({
  colors: Schema.optional(
    Schema.Struct({
      income: Schema.optional(Schema.String),
      expense: Schema.optional(Schema.String),
      balance: Schema.optional(Schema.String),
      background: Schema.optional(Schema.String),
    }),
  ),
  condFormat: Schema.optional(
    Schema.Array(
      Schema.Struct({
        field: Schema.String,
        op: Schema.String,
        value: Schema.String,
        color: Schema.String,
      }),
    ),
  ),
  numberFormat: Schema.optional(NumberFormatSchema),
});
type ReportMetadata = Schema.Schema.Type<typeof ReportMetadataSchema>;
interface WritableReportMetadata {
  colors: NonNullable<ReportMetadata["colors"]>;
  condFormat?: ConditionalFormat[];
  numberFormat?: NumberFormat;
}

function formatReportCell(value: ReportCell): string {
  return value == null ? "" : String(value);
}

const REPORTS = [
  {
    id: "net-worth",
    label: "Net Worth",
    icon: "📈",
    description: "Total assets minus liabilities over time",
  },
  { id: "cash-flow", label: "Cash Flow", icon: "💵", description: "Monthly income vs expenses" },
  { id: "spending", label: "Spending", icon: "🍩", description: "Spending breakdown by category" },
  {
    id: "budget-analysis",
    label: "Budget vs Actual",
    icon: "📊",
    description: "Budgeted vs actual spending per category",
  },
  {
    id: "age-of-money",
    label: "Age of Money",
    icon: "⏰",
    description: "How many days your money lasts",
  },
  { id: "custom", label: "Custom Reports", icon: "🔧", description: "Build your own reports" },
] satisfies ReadonlyArray<{ id: ReportId; label: string; icon: string; description: string }>;

const GRAPH_TYPES = [
  { value: "area", label: "Area Chart" },
  { value: "bar", label: "Bar Chart" },
  { value: "donut", label: "Donut Chart" },
  { value: "table", label: "Table" },
] as const;

export default function AdvancedReports() {
  const [activeReport, setActiveReport] = createSignal<ReportId>("net-worth");
  const fmt = useCurrency();
  const privacy = usePrivacyMode();

  // Lazy-load report data
  const [netWorthData, setNetWorthData] = createSignal<TimeSeriesPoint[]>([]);
  const [cashFlowData, setCashFlowData] = createSignal<BarGroup[]>([]);
  const [spendingData, setSpendingData] = createSignal<PieSlice[]>([]);
  const [budgetData, setBudgetData] = createSignal<BudgetPair[]>([]);
  const [ageOfMoney, setAgeOfMoney] = createSignal<number | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Custom reports state
  const [customReports, setCustomReports] = createSignal<CustomReport[]>([]);
  const [showCreateModal, setShowCreateModal] = createSignal(false);
  const [editingReport, setEditingReport] = createSignal<CustomReport | null>(null);

  // Create/edit form
  const [formName, setFormName] = createSignal("");
  const [formGraphType, setFormGraphType] = createSignal("area");
  const [formStartDate, setFormStartDate] = createSignal("");
  const [formEndDate, setFormEndDate] = createSignal("");
  const [formGroupBy, setFormGroupBy] = createSignal("");
  const [formColorScheme, setFormColorScheme] = createSignal({
    income: "#4ade80",
    expense: "#f87171",
    balance: "#60a5fa",
    background: "#1a1a2e",
  });
  const [formCondFormat, setFormCondFormat] = createSignal<
    Array<{ field: string; op: string; value: string; color: string }>
  >([]);
  const [formNumberFormat, setFormNumberFormat] = createSignal<NumberFormat | "">("");

  // Custom report data (lazy loaded per-report)
  const [customReportData, _setCustomReportData] = createSignal(
    new Map<string, CustomReportResult>(),
  );

  createEffect(() => {
    const report = activeReport();
    if (report === "custom") {
      void loadCustomReports();
    } else {
      void loadReport(report);
    }
  });

  onMount(() => {
    onCleanup(
      listenForMoneyDataChanged(() => {
        const report = activeReport();
        return report === "custom" ? undefined : loadReport(report);
      }),
    );
  });

  async function loadReport(report: ReportId) {
    setLoading(true);
    setError(null);
    try {
      switch (report) {
        case "net-worth": {
          const data = await api.reports.netWorth();
          setNetWorthData([...data.points]);
          break;
        }
        case "cash-flow": {
          const data = await api.reports.cashFlow();
          const groups: BarGroup[] = data.months.map((m) => ({
            category: m.month,
            values: [
              { label: "Income", value: m.income ?? 0, color: CHART_COLORS.income },
              { label: "Spending", value: m.expense ?? 0, color: CHART_COLORS.spending },
            ],
          }));
          setCashFlowData(groups);
          break;
        }
        case "spending": {
          const data = await api.reports.spending();
          setSpendingData([...data.categories]);
          break;
        }
        case "budget-analysis": {
          const data = await api.reports.budgetAnalysis();
          setBudgetData([...data.categories]);
          break;
        }
        case "age-of-money": {
          const data = await api.reports.ageOfMoney();
          setAgeOfMoney(data.days ?? null);
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to load report`);
    } finally {
      setLoading(false);
    }
  }

  const formatMonth = (dateStr: string) => {
    if (!dateStr || dateStr.length < 7) return dateStr;
    const [y, m] = dateStr.split("-");
    const d = new Date(Number(y), Number(m) - 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  };

  // -----------------------------------------------------------------------
  // Custom reports
  // -----------------------------------------------------------------------

  async function loadCustomReports() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.reports.custom();
      setCustomReports([...data.reports]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load custom reports");
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal() {
    setEditingReport(null);
    setFormName("");
    setFormGraphType("area");
    setFormStartDate("");
    setFormEndDate("");
    setFormGroupBy("");
    setFormColorScheme({
      income: "#4ade80",
      expense: "#f87171",
      balance: "#60a5fa",
      background: "#1a1a2e",
    });
    setFormCondFormat([]);
    setFormNumberFormat("");
    setShowCreateModal(true);
  }

  function openEditModal(report: CustomReport) {
    setEditingReport(report);
    setFormName(report.name ?? "");
    setFormGraphType(report.graphType ?? "area");
    setFormStartDate(report.startDate ?? "");
    setFormEndDate(report.endDate ?? "");
    setFormGroupBy(report.groupBy ?? "");
    try {
      const meta = report.metadata
        ? Schema.decodeUnknownSync(ReportMetadataSchema)(JSON.parse(report.metadata))
        : undefined;
      if (meta?.colors) {
        setFormColorScheme({
          income: meta.colors.income ?? "#4ade80",
          expense: meta.colors.expense ?? "#f87171",
          balance: meta.colors.balance ?? "#60a5fa",
          background: meta.colors.background ?? "#1a1a2e",
        });
      } else {
        setFormColorScheme({
          income: "#4ade80",
          expense: "#f87171",
          balance: "#60a5fa",
          background: "#1a1a2e",
        });
      }
      setFormCondFormat(meta?.condFormat ? [...meta.condFormat] : []);
      setFormNumberFormat(meta?.numberFormat ?? "");
    } catch {
      console.warn("[reports] failed to parse report metadata");
      setFormColorScheme({
        income: "#4ade80",
        expense: "#f87171",
        balance: "#60a5fa",
        background: "#1a1a2e",
      });
      setFormCondFormat([]);
      setFormNumberFormat("");
    }
    setShowCreateModal(true);
  }

  function buildMetadata(): string {
    const meta: WritableReportMetadata = { colors: formColorScheme() };
    if (formCondFormat().length > 0) meta.condFormat = formCondFormat();
    const numberFormat = formNumberFormat();
    if (numberFormat) meta.numberFormat = numberFormat;
    return JSON.stringify(meta);
  }

  function handleSaveReport() {
    const name = formName().trim();
    if (!name) return;

    if (editingReport()) {
      dispatch("update_report", {
        id: editingReport()!.id,
        fields: {
          name: formName(),
          graphType: formGraphType(),
          startDate: formStartDate() || null,
          endDate: formEndDate() || null,
          groupBy: formGroupBy() || null,
          metadata: buildMetadata(),
        },
      });
    } else {
      dispatch("create_report", {
        report: {
          name: formName(),
          graphType: formGraphType(),
          startDate: formStartDate() || null,
          endDate: formEndDate() || null,
          groupBy: formGroupBy() || null,
          conditions: "[]",
          metadata: buildMetadata(),
        },
      });
    }

    setShowCreateModal(false);
    setTimeout(() => loadCustomReports(), 300);
  }

  function handleDeleteReport(id: string) {
    dispatch("delete_report", { id });
    setTimeout(() => loadCustomReports(), 300);
  }

  async function loadCustomReportData(reportId: string) {
    try {
      const data = await api.reports.customExecute(reportId);
      _setCustomReportData((previous) => new Map(previous).set(reportId, data));
    } catch {
      console.warn("[reports] failed to load custom report data");
    }
  }

  function applyCondFormat(
    value: number,
    row: CustomReportRow,
    condFormat: ReadonlyArray<ConditionalFormat>,
  ): string | null {
    for (const rule of condFormat) {
      const matchingColumn = REPORT_COLUMNS.find((column) => column === rule.field);
      const cell = matchingColumn ? row[matchingColumn] : undefined;
      const raw =
        rule.field === "amount" || rule.field === "total"
          ? value
          : rule.field
            ? Number(cell) || formatReportCell(cell)
            : "";
      const matchValue = Number(rule.value);
      const strRaw = String(raw).toLowerCase();
      const strVal = (rule.value ?? "").toLowerCase();

      let match = false;
      switch (rule.op) {
        case "gt":
          match = Number(raw) > matchValue;
          break;
        case "lt":
          match = Number(raw) < matchValue;
          break;
        case "gte":
          match = Number(raw) >= matchValue;
          break;
        case "lte":
          match = Number(raw) <= matchValue;
          break;
        case "eq":
          match = !isNaN(Number(raw)) ? Number(raw) === matchValue : strRaw === strVal;
          break;
        case "neq":
          match = !isNaN(Number(raw)) ? Number(raw) !== matchValue : strRaw !== strVal;
          break;
        case "contains":
          match = strRaw.includes(strVal);
          break;
      }
      if (match) return rule.color;
    }
    return null;
  }

  function renderCustomReportTable(
    rows: ReadonlyArray<CustomReportRow>,
    colors: ReportMetadata["colors"],
    condFormat: ReadonlyArray<ConditionalFormat> | undefined,
    numberFormatOverride: NumberFormat | undefined,
  ) {
    if (rows.length === 0) return <div class="chart-placeholder">No data</div>;

    const firstRow = rows[0];
    const keys = REPORT_COLUMNS.filter((key) => firstRow[key] !== undefined);
    const _bg = colors?.background ?? "var(--surface)";
    const cur = fmt();
    const nf = numberFormatOverride ?? cur.numberFormat;

    function fmtAmount(cents: number): string {
      return formatCentsValue(cents, cur.code, nf);
    }

    return (
      <div class="report-table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              {keys.map((key) => (
                <th>{key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <For each={rows}>
              {(row) => {
                const amount = Number(row.total ?? row.amount ?? 0);
                const isIncome = amount > 0;
                const isExpense = amount < 0;
                const condColor = condFormat ? applyCondFormat(amount, row, condFormat) : null;
                const cellStyle = condColor
                  ? { color: condColor }
                  : isIncome
                    ? { color: colors?.income ?? "var(--positive)" }
                    : isExpense
                      ? { color: colors?.expense ?? "var(--negative)" }
                      : {};
                return (
                  <tr>
                    <For each={keys}>
                      {(key) => (
                        <td
                          style={
                            (key === "total" || key === "amount") && (isIncome || isExpense)
                              ? cellStyle
                              : {}
                          }
                          classList={{
                            "privacy-blur":
                              privacy().enabled && (key === "total" || key === "amount"),
                          }}
                        >
                          {(key === "total" || key === "amount") && row[key] !== undefined
                            ? fmtAmount(Number(row[key]))
                            : key === "cleared"
                              ? row[key]
                                ? "✓"
                                : ""
                              : key === "reconciled"
                                ? row[key]
                                  ? "🔒"
                                  : ""
                                : formatReportCell(row[key])}
                        </td>
                      )}
                    </For>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    );
  }

  function renderCustomReport(report: CustomReport) {
    const graphType = report.graphType ?? "area";
    const result = customReportData().get(report.id);
    const rows = result?.rows ?? [];
    const groupBy = result?.groupBy ?? null;
    let colors: ReportMetadata["colors"];
    let condFormat: ReadonlyArray<ConditionalFormat> | undefined;
    let numberFormat: NumberFormat | undefined;
    try {
      const meta = report.metadata
        ? Schema.decodeUnknownSync(ReportMetadataSchema)(JSON.parse(report.metadata))
        : undefined;
      colors = meta?.colors;
      condFormat = meta?.condFormat;
      numberFormat = meta?.numberFormat;
    } catch {
      console.warn("[reports] failed to parse report metadata");
    }

    if (!result) {
      return (
        <div class="chart-placeholder">
          <button class="btn btn-secondary btn-sm" onClick={() => loadCustomReportData(report.id)}>
            Load Data
          </button>
        </div>
      );
    }
    if (rows.length === 0) {
      return <div class="chart-placeholder">No matching transactions</div>;
    }

    // Table mode
    if (graphType === "table") {
      return (
        <Show when={true}>{renderCustomReportTable(rows, colors, condFormat, numberFormat)}</Show>
      );
    }

    // Area chart (time series from grouped data or individual txns)
    if (graphType === "area") {
      let points: TimeSeriesPoint[];
      if (groupBy === "month") {
        points = rows.map((row) => ({ date: row.month ?? "", value: row.total ?? 0 }));
      } else if (groupBy === "category") {
        points = rows.map((row) => ({
          date: row.category ?? "Uncategorized",
          value: row.total ?? 0,
          label: row.category ?? "Uncategorized",
        }));
      } else {
        points = rows.map((row) => ({ date: row.date ?? "", value: row.amount ?? 0 }));
      }
      return (
        <div classList={{ "privacy-blur": privacy().enabled }}>
          <AreaChart
            data={points}
            label={report.name ?? "Custom report"}
            color={colors?.balance ?? colors?.expense}
            formatX={groupBy === "month" ? formatMonth : undefined}
          />
        </div>
      );
    }

    // Bar chart
    if (graphType === "bar") {
      let groups: BarGroup[];
      if (groupBy === "month") {
        groups = rows.map((row) => ({
          category: row.month ?? "",
          values: [{ label: "Total", value: row.total ?? 0, color: colors?.balance }],
        }));
      } else if (groupBy === "category") {
        groups = rows.map((row) => ({
          category: row.category ?? "Uncategorized",
          values: [{ label: "Total", value: row.total ?? 0, color: colors?.balance }],
        }));
      } else {
        const dateGroups: Record<string, number> = {};
        for (const r of rows) {
          dateGroups[r.date ?? "?"] = (dateGroups[r.date ?? "?"] ?? 0) + (r.amount ?? 0);
        }
        groups = Object.entries(dateGroups).map(([date, val]) => ({
          category: date,
          values: [{ label: "Total", value: val, color: colors?.balance }],
        }));
      }
      return (
        <div classList={{ "privacy-blur": privacy().enabled }}>
          <BarChart
            groups={groups}
            label={report.name ?? "Custom report"}
            formatX={groupBy === "month" ? formatMonth : undefined}
          />
        </div>
      );
    }

    // Donut chart (categories only)
    if (graphType === "donut") {
      let slices: PieSlice[];
      if (groupBy === "category") {
        slices = rows.map((row) => ({
          label: row.category ?? "Uncategorized",
          value: Math.abs(row.total ?? 0),
        }));
      } else {
        const catMap: Record<string, number> = {};
        for (const r of rows) {
          const cat = r.category ?? "Uncategorized";
          catMap[cat] = (catMap[cat] ?? 0) + Math.abs(r.amount ?? 0);
        }
        slices = Object.entries(catMap).map(([label, value]) => ({ label, value }));
      }
      return (
        <div classList={{ "privacy-blur": privacy().enabled }}>
          <DonutChart slices={slices} label={report.name ?? "Custom report"} />
        </div>
      );
    }

    return <div class="chart-placeholder">Unsupported graph type</div>;
  }

  return (
    <div class="advanced-reports">
      <div class="report-tabs">
        <For each={REPORTS}>
          {(report) => (
            <button
              class="report-tab"
              classList={{ active: activeReport() === report.id }}
              onClick={() => setActiveReport(report.id)}
            >
              <span>{report.icon}</span>
              <span>{report.label}</span>
            </button>
          )}
        </For>
      </div>

      <div class="report-content">
        <Show
          when={activeReport() !== "custom"}
          fallback={
            <PageState
              loading={loading()}
              error={error()}
              onRetry={loadCustomReports}
              loadingMessage="Loading custom reports..."
            >
              <div class="page-header" style={{ "margin-bottom": "12px" }}>
                <p class="page-subtitle">Create and manage your own custom reports</p>
                <button class="btn btn-primary btn-sm" onClick={openCreateModal}>
                  + New Report
                </button>
              </div>

              <Show
                when={customReports().length > 0}
                fallback={
                  <div class="empty-state">
                    <p>No custom reports yet.</p>
                    <button class="btn btn-primary btn-sm" onClick={openCreateModal}>
                      Create your first report
                    </button>
                  </div>
                }
              >
                <div class="custom-report-list">
                  <For each={customReports()}>
                    {(report) => (
                      <div class="custom-report-card">
                        <div class="custom-report-header">
                          <div>
                            <strong>{report.name ?? "Untitled Report"}</strong>
                            <span class="custom-report-meta">
                              {report.graphType ?? "area"} &middot; {report.startDate ?? "any"} to{" "}
                              {report.endDate ?? "any"}
                            </span>
                          </div>
                          <div class="custom-report-actions">
                            <button
                              class="btn btn-ghost btn-xs"
                              onClick={() => openEditModal(report)}
                            >
                              Edit
                            </button>
                            <button
                              class="btn btn-ghost btn-xs"
                              onClick={() => {
                                if (confirm("Delete this report?")) handleDeleteReport(report.id);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div class="custom-report-body">{renderCustomReport(report)}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </PageState>
          }
        >
          <PageState
            loading={loading()}
            error={error()}
            onRetry={() => loadReport(activeReport())}
            loadingMessage="Loading report data..."
          >
            <Show when={activeReport() === "net-worth"}>
              <div class="report-card">
                <h2 class="report-title">Net Worth Over Time</h2>
                <p class="report-description">
                  Your total assets minus liabilities, tracked monthly.
                </p>
                <div classList={{ "privacy-blur": privacy().enabled }}>
                  <AreaChart data={netWorthData()} label="Net worth" formatX={formatMonth} />
                </div>
              </div>
            </Show>

            <Show when={activeReport() === "cash-flow"}>
              <div class="report-card">
                <h2 class="report-title">Cash Flow</h2>
                <p class="report-description">Income versus expenses by month.</p>
                <div classList={{ "privacy-blur": privacy().enabled }}>
                  <BarChart groups={cashFlowData()} label="Cash flow" formatX={formatMonth} />
                </div>
              </div>
            </Show>

            <Show when={activeReport() === "spending"}>
              <div class="report-card">
                <h2 class="report-title">Spending by Category</h2>
                <p class="report-description">Where your money went this period.</p>
                <div classList={{ "privacy-blur": privacy().enabled }}>
                  <DonutChart slices={spendingData()} label="Spending by category" />
                </div>
              </div>
            </Show>

            <Show when={activeReport() === "budget-analysis"}>
              <div class="report-card">
                <h2 class="report-title">Budget vs Actuals</h2>
                <p class="report-description">How each category compares to its budget.</p>
                <div classList={{ "privacy-blur": privacy().enabled }}>
                  <BudgetBar data={budgetData()} label="Budget vs actuals" maxCategories={15} />
                </div>
              </div>
            </Show>

            <Show when={activeReport() === "age-of-money"}>
              <div class="report-card" style={{ "text-align": "center" }}>
                <h2 class="report-title">Age of Money</h2>
                <p class="report-description">
                  How many days your current cash would last based on average daily spending.
                </p>
                <div class="age-display" style={{ padding: "32px" }}>
                  <Show
                    when={ageOfMoney() !== null}
                    fallback={
                      <span style={{ color: "var(--text-muted)" }}>
                        Not enough data to calculate
                      </span>
                    }
                  >
                    <span
                      class="age-number"
                      classList={{ "privacy-blur": privacy().enabled }}
                      style={{ "font-size": "3rem", "font-weight": 700 }}
                    >
                      {ageOfMoney()}
                    </span>
                    <span
                      class="age-unit"
                      style={{
                        "font-size": "1rem",
                        color: "var(--text-secondary)",
                        "margin-left": "8px",
                      }}
                    >
                      days
                    </span>
                  </Show>
                </div>
              </div>
            </Show>
          </PageState>
        </Show>
      </div>

      <Show when={showCreateModal()}>
        <div class="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>{editingReport() ? "Edit Report" : "New Custom Report"}</h2>
              <button class="modal-close" onClick={() => setShowCreateModal(false)}>
                &times;
              </button>
            </div>
            <div class="modal-body">
              <div class="form-row">
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Report Name</label>
                  <input
                    type="text"
                    placeholder="My Custom Report"
                    value={formName()}
                    onInput={(e) => setFormName(e.currentTarget.value)}
                  />
                </div>
              </div>
              <div class="form-row">
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Graph Type</label>
                  <select
                    value={formGraphType()}
                    onChange={(e) => setFormGraphType(e.currentTarget.value)}
                  >
                    <For each={GRAPH_TYPES}>
                      {(gt) => <option value={gt.value}>{gt.label}</option>}
                    </For>
                  </select>
                </div>
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Group By</label>
                  <select
                    value={formGroupBy()}
                    onChange={(e) => setFormGroupBy(e.currentTarget.value)}
                  >
                    <option value="">None (individual txns)</option>
                    <option value="month">Month</option>
                    <option value="category">Category</option>
                  </select>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Start Date</label>
                  <input
                    type="date"
                    value={formStartDate()}
                    onInput={(e) => setFormStartDate(e.currentTarget.value)}
                  />
                </div>
                <div class="form-group" style={{ flex: "1" }}>
                  <label>End Date</label>
                  <input
                    type="date"
                    value={formEndDate()}
                    onInput={(e) => setFormEndDate(e.currentTarget.value)}
                  />
                </div>
              </div>
              <div class="form-row">
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Income Color</label>
                  <div class="form-color">
                    <input
                      type="color"
                      value={formColorScheme().income}
                      onInput={(e) =>
                        setFormColorScheme({ ...formColorScheme(), income: e.currentTarget.value })
                      }
                    />
                    <code>{formColorScheme().income}</code>
                  </div>
                </div>
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Expense Color</label>
                  <div class="form-color">
                    <input
                      type="color"
                      value={formColorScheme().expense}
                      onInput={(e) =>
                        setFormColorScheme({ ...formColorScheme(), expense: e.currentTarget.value })
                      }
                    />
                    <code>{formColorScheme().expense}</code>
                  </div>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Balance Color</label>
                  <div class="form-color">
                    <input
                      type="color"
                      value={formColorScheme().balance}
                      onInput={(e) =>
                        setFormColorScheme({ ...formColorScheme(), balance: e.currentTarget.value })
                      }
                    />
                    <code>{formColorScheme().balance}</code>
                  </div>
                </div>
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Background Color</label>
                  <div class="form-color">
                    <input
                      type="color"
                      value={formColorScheme().background}
                      onInput={(e) =>
                        setFormColorScheme({
                          ...formColorScheme(),
                          background: e.currentTarget.value,
                        })
                      }
                    />
                    <code>{formColorScheme().background}</code>
                  </div>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Number Format</label>
                  <select
                    value={formNumberFormat()}
                    onChange={(e) =>
                      setFormNumberFormat(
                        Schema.decodeUnknownSync(NumberFormatFormSchema)(e.currentTarget.value),
                      )
                    }
                  >
                    <option value="">Use global setting</option>
                    <option value="comma-dot">1,234.56</option>
                    <option value="dot-comma">1.234,56</option>
                    <option value="space-dot">1 234.56</option>
                  </select>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group" style={{ flex: "1" }}>
                  <label>Conditional Formatting</label>
                  <div class="cond-format-list">
                    <For each={formCondFormat()}>
                      {(rule, index) => (
                        <div class="cond-format-row">
                          <select
                            value={rule.field}
                            onChange={(e) => {
                              const next = formCondFormat().map((r, i) =>
                                i === index() ? { ...r, field: e.currentTarget.value } : r,
                              );
                              setFormCondFormat(next);
                            }}
                          >
                            <option value="">Field</option>
                            <option value="amount">Amount</option>
                            <option value="total">Total</option>
                            <option value="category">Category</option>
                            <option value="payee">Payee</option>
                            <option value="notes">Notes</option>
                          </select>
                          <select
                            value={rule.op}
                            onChange={(e) => {
                              const next = formCondFormat().map((r, i) =>
                                i === index() ? { ...r, op: e.currentTarget.value } : r,
                              );
                              setFormCondFormat(next);
                            }}
                          >
                            <option value="">Op</option>
                            <option value="gt">{">"}</option>
                            <option value="lt">{"<"}</option>
                            <option value="gte">{">="}</option>
                            <option value="lte">{"<="}</option>
                            <option value="eq">=</option>
                            <option value="neq">≠</option>
                            <option value="contains">contains</option>
                          </select>
                          <input
                            type="text"
                            placeholder="Value"
                            value={rule.value}
                            onInput={(e) => {
                              const next = formCondFormat().map((r, i) =>
                                i === index() ? { ...r, value: e.currentTarget.value } : r,
                              );
                              setFormCondFormat(next);
                            }}
                            style="width:100px"
                          />
                          <input
                            type="color"
                            value={rule.color}
                            onInput={(e) => {
                              const next = formCondFormat().map((r, i) =>
                                i === index() ? { ...r, color: e.currentTarget.value } : r,
                              );
                              setFormCondFormat(next);
                            }}
                            style="width:36px;height:36px;padding:0"
                          />
                          <button
                            class="btn btn-ghost btn-sm"
                            onClick={() =>
                              setFormCondFormat(formCondFormat().filter((_, i) => i !== index()))
                            }
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </For>
                    <button
                      class="btn btn-ghost btn-sm"
                      onClick={() =>
                        setFormCondFormat([
                          ...formCondFormat(),
                          { field: "amount", op: "gt", value: "0", color: "#4ade80" },
                        ])
                      }
                    >
                      + Add Rule
                    </button>
                  </div>
                </div>
              </div>
              <div class="form-actions">
                <button class="btn btn-ghost" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </button>
                <button
                  class="btn btn-primary"
                  onClick={handleSaveReport}
                  disabled={!formName().trim()}
                >
                  {editingReport() ? "Update" : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
