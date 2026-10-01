/**
 * Schedules page — recurring transaction templates.
 */
import { createSignal, For, Show, createEffect, onCleanup, onMount } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { PageState } from "../components/PageState";
import { listenForMoneyDataChanged } from "../lib/data-events";
import * as Schema from "effect/Schema";
import type { SchedulesResponse } from "../domain/schemas-client";

type Schedule = SchedulesResponse["schedules"][number];
const RecurrenceConfigSchema = Schema.Struct({
  type: Schema.String,
  skipWeekend: Schema.optional(Schema.Boolean),
  weekendSolveMode: Schema.optional(Schema.Literals(["before", "after"])),
  endMode: Schema.optional(Schema.String),
  endOccurrences: Schema.optional(Schema.Number),
  endDate: Schema.optional(Schema.String),
});
type RecurrenceConfig = Schema.Schema.Type<typeof RecurrenceConfigSchema>;
interface WritableRecurrenceConfig {
  type: string;
  skipWeekend?: boolean;
  weekendSolveMode?: "before" | "after";
  endMode?: string;
  endOccurrences?: number;
  endDate?: string;
}

function parseRecurrenceConfig(rules: string): RecurrenceConfig {
  try {
    const parsed = Schema.decodeUnknownSync(Schema.Union([RecurrenceConfigSchema, Schema.String]))(
      JSON.parse(rules),
    );
    return parsed instanceof Object ? parsed : { type: parsed };
  } catch {
    return { type: rules || "monthly" };
  }
}

export default function SchedulesPage() {
  const [searchParams, setSearchParams] = useSearchParams<{ focus?: string }>();
  const df = useDateFormat();
  const fmt = useCurrency();
  const privacyBlur = usePrivacyMode();
  const [schedules, setSchedules] = createSignal<Schedule[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [showForm, setShowForm] = createSignal(false);
  const [editingSchedule, setEditingSchedule] = createSignal<Schedule | null>(null);
  const [showDiscover, setShowDiscover] = createSignal(false);
  const [lastFocusedId, setLastFocusedId] = createSignal<string | null>(null);

  createEffect(() => {
    void loadSchedules();
  });

  onMount(() => {
    onCleanup(listenForMoneyDataChanged(loadSchedules));
  });

  createEffect(() => {
    const focusId = searchParams.focus;
    const focused = schedules().find((schedule) => schedule.id === focusId);
    if (!focusId || !focused || lastFocusedId() === focusId) return;
    setLastFocusedId(focusId);
    handleEdit(focused);
  });

  async function loadSchedules() {
    setError(null);
    try {
      const data = await api.schedules();
      setSchedules([...data.schedules]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }

  function handleDelete(id: string) {
    const sched = schedules().find((s) => s.id === id);
    dispatch(
      "delete_schedule",
      { id },
      {
        undoInfo: {
          label: "Delete schedule",
          inverse: {
            commandType: "create_schedule",
            payload: {
              schedule: {
                accountId: sched?.accountId ?? null,
                payeeId: sched?.payeeId ?? null,
                categoryId: sched?.categoryId ?? null,
                name: sched?.name ?? "",
                startDate: sched?.startDate ?? "",
                amount: sched?.amount ?? 0,
                recurrenceRules: sched?.recurrenceRules ?? JSON.stringify({ type: "monthly" }),
                active: sched?.active ?? true,
                completed: sched?.completed ?? false,
                postsTransaction: sched?.postsTransaction ?? false,
                customUpcomingLength: sched?.customUpcomingLength ?? null,
                nextDate: sched?.nextDate ?? null,
              },
            },
          },
        },
      },
    );
    setSchedules((prev) => prev.filter((s) => s.id !== id));
  }

  function handlePost(scheduleId: string) {
    const { promise } = dispatch("post_schedule_transaction", { scheduleId });
    void promise
      .then(() => loadSchedules())
      .catch((err) => {
        console.warn("[schedules] post failed", err);
      });
  }

  function handleSkip(id: string) {
    const { promise } = dispatch("skip_schedule_date", { id });
    void promise
      .then(() => loadSchedules())
      .catch((err) => {
        console.warn("[schedules] skip failed", err);
      });
  }

  function handleEdit(schedule: Schedule) {
    setEditingSchedule(schedule);
    setShowForm(true);
  }

  function handleFormClose() {
    setShowForm(false);
    setEditingSchedule(null);
    if (searchParams.focus) setSearchParams({ focus: undefined }, { replace: true });
  }

  function handleSaved() {
    handleFormClose();
    void loadSchedules();
  }

  function formatRecurrenceLabel(rules: string): string {
    const cfg = parseRecurrenceConfig(rules);
    const labels = new Map<string, string>(
      Object.entries({
        daily: "Daily",
        weekly: "Weekly",
        biweekly: "Bi-weekly",
        monthly: "Monthly",
        quarterly: "Quarterly",
        yearly: "Yearly",
      }),
    );
    let label = labels.get(cfg.type) ?? cfg.type;
    if (cfg.skipWeekend) {
      label += ` (${cfg.weekendSolveMode === "before" ? "before" : "after"} weekend)`;
    }
    return label;
  }

  function formatEndConditionFormatted(rules: string, fmtDate: (d: string) => string): string {
    const cfg = parseRecurrenceConfig(rules);
    if (
      (cfg.endMode === "after_n" || cfg.endMode === "after_n_occurrences") &&
      cfg.endOccurrences
    ) {
      return ` · Ends after ${cfg.endOccurrences} occurrences`;
    }
    if (cfg.endMode === "on_date" && cfg.endDate) {
      return ` · Ends ${fmtDate(cfg.endDate)}`;
    }
    return "";
  }

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Schedules</h1>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onClick={() => setShowDiscover(true)}>
            Discover
          </button>
          <button class="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
            + Add Schedule
          </button>
        </div>
      </div>

      <Show when={showForm()}>
        <ScheduleForm
          schedule={editingSchedule() ?? undefined}
          onClose={handleFormClose}
          onSaved={handleSaved}
        />
      </Show>

      <Show when={showDiscover()}>
        <DiscoverModal
          fmt={fmt}
          df={df}
          privacyClass={privacyBlur().blurClass()}
          onClose={() => setShowDiscover(false)}
          onCreateSchedule={(candidate) => {
            setShowDiscover(false);
            dispatch(
              "create_schedule",
              {
                schedule: {
                  name: candidate.payee,
                  amount: candidate.amount || null,
                  recurrenceRules: JSON.stringify({ type: candidate.recurrenceType }),
                  startDate: new Date().toISOString().slice(0, 10),
                },
              },
              {
                undoInfo: {
                  label: "Create schedule from discovery",
                  inverse: (data) => ({
                    commandType: "delete_schedule",
                    payload: { id: requireCommandId(data) },
                  }),
                },
              },
            );
          }}
        />
      </Show>

      <PageState
        loading={loading()}
        error={error()}
        onRetry={loadSchedules}
        loadingMessage="Loading schedules..."
      >
        <Show
          when={schedules().length > 0}
          fallback={<div class="empty-state">No recurring schedules yet.</div>}
        >
          <div class="schedule-list">
            <For each={schedules()}>
              {(schedule) => (
                <div class="schedule-card">
                  <div class="schedule-info">
                    <button
                      type="button"
                      class="schedule-name schedule-name-button"
                      onClick={() => handleEdit(schedule)}
                    >
                      {schedule.name ?? "Unnamed"}
                    </button>
                    <div class="schedule-meta">
                      {schedule.recurrenceRules && formatRecurrenceLabel(schedule.recurrenceRules)}
                      {schedule.nextDate && ` · Next: ${df().formatDate(schedule.nextDate)}`}
                      {schedule.completed && ` · Completed`}
                      {schedule.recurrenceRules &&
                        formatEndConditionFormatted(schedule.recurrenceRules, (d) =>
                          df().formatDate(d),
                        )}
                    </div>
                  </div>
                  <div class="schedule-actions">
                    <button class="btn btn-sm btn-ghost" onClick={() => handlePost(schedule.id)}>
                      Post
                    </button>
                    <button class="btn btn-sm btn-ghost" onClick={() => handleSkip(schedule.id)}>
                      Skip
                    </button>
                    <button class="btn btn-sm btn-ghost" onClick={() => handleEdit(schedule)}>
                      Edit
                    </button>
                    <details class="entity-menu">
                      <summary aria-label={`More actions for ${schedule.name ?? "schedule"}`}>
                        •••
                      </summary>
                      <div class="entity-menu-popover">
                        <button
                          type="button"
                          class="danger"
                          onClick={() => handleDelete(schedule.id)}
                        >
                          Delete · Undo available
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </PageState>
    </div>
  );
}

function ScheduleForm(props: { onClose: () => void; schedule?: Schedule; onSaved?: () => void }) {
  const fmt = useCurrency();
  const isEdit = () => !!props.schedule;
  const existing = () => props.schedule;

  const config = (): RecurrenceConfig => {
    const schedule = existing();
    return schedule?.recurrenceRules
      ? parseRecurrenceConfig(schedule.recurrenceRules)
      : { type: "weekly" };
  };

  const [name, setName] = createSignal(existing()?.name ?? "");
  const initialAmount = existing()?.amount;
  const [amount, setAmount] = createSignal(
    initialAmount ? fmt().formatCentsInput(initialAmount) : "",
  );
  const [recurrence, setRecurrence] = createSignal(config().type ?? "weekly");
  const [skipWeekend, setSkipWeekend] = createSignal(config().skipWeekend ?? false);
  const [weekendSolveMode, setWeekendSolveMode] = createSignal(
    config().weekendSolveMode ?? "after",
  );
  const [endMode, setEndMode] = createSignal(config().endMode ?? "never");
  const [endOccurrences, setEndOccurrences] = createSignal(config().endOccurrences ?? 10);
  const [endDate, setEndDate] = createSignal(config().endDate ?? "");
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  let nameInput: HTMLInputElement | undefined;

  onMount(() => {
    nameInput?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving()) props.onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!name().trim()) return;

    const parsedAmount = fmt().parseInput(amount() || "0");
    if (!Number.isSafeInteger(parsedAmount)) {
      setSaveError("Enter a valid amount.");
      return;
    }
    setSaveError(null);
    setSaving(true);
    const rules: WritableRecurrenceConfig = { type: recurrence() };

    if (skipWeekend()) {
      rules.skipWeekend = true;
      rules.weekendSolveMode = weekendSolveMode();
    }
    if (endMode() !== "never") {
      rules.endMode = endMode();
      if (endMode() === "after_n_occurrences") {
        rules.endOccurrences = endOccurrences();
      }
      if (endMode() === "on_date") {
        rules.endDate = endDate();
      }
    }

    const rulesJson = JSON.stringify(rules);
    const startDate = existing()?.startDate ?? new Date().toISOString().slice(0, 10);

    let operation: Promise<void>;
    const old = existing();
    if (old) {
      operation = dispatch(
        "update_schedule",
        {
          id: old.id,
          fields: {
            name: name().trim(),
            amount: parsedAmount || null,
            recurrenceRules: rulesJson,
            startDate,
          },
        },
        {
          undoInfo: {
            label: "Update schedule",
            inverse: {
              commandType: "update_schedule",
              payload: {
                id: old.id,
                fields: {
                  name: old.name,
                  amount: old.amount ?? null,
                  recurrenceRules: old.recurrenceRules,
                  startDate: old.startDate,
                },
              },
            },
          },
        },
      ).promise;
    } else {
      operation = dispatch(
        "create_schedule",
        {
          schedule: {
            name: name().trim(),
            amount: parsedAmount || null,
            recurrenceRules: rulesJson,
            startDate,
          },
        },
        {
          undoInfo: {
            label: "Create schedule",
            inverse: (data) => ({
              commandType: "delete_schedule",
              payload: { id: requireCommandId(data) },
            }),
          },
        },
      ).promise;
    }

    try {
      await operation;
      props.onSaved?.();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not save schedule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-form-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h2 id="schedule-form-title">{isEdit() ? "Edit Schedule" : "New Schedule"}</h2>
          <button
            type="button"
            class="modal-close"
            onClick={props.onClose}
            aria-label="Close schedule form"
          >
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <Show when={saveError()}>
            <p role="alert" class="inline-save-error">
              {saveError()}
            </p>
          </Show>
          <div class="form-group">
            <label>Name</label>
            <input
              ref={(element) => {
                nameInput = element;
              }}
              type="text"
              placeholder="e.g. Monthly Rent"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              required
              autofocus
            />
          </div>
          <div class="form-group">
            <label>Amount (optional)</label>
            <input
              type="text"
              inputmode={fmt().inputMode}
              placeholder={fmt().code === "IDR" ? "0" : "0.00"}
              value={amount()}
              onInput={(e) => setAmount(e.currentTarget.value)}
            />
          </div>
          <div class="form-group">
            <label>Frequency</label>
            <select value={recurrence()} onChange={(e) => setRecurrence(e.currentTarget.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-check">
              <input
                type="checkbox"
                checked={skipWeekend()}
                onChange={(e) => setSkipWeekend(e.currentTarget.checked)}
              />
              <span>Skip weekends (move to nearest weekday)</span>
            </label>
          </div>
          <Show when={skipWeekend()}>
            <div class="form-group">
              <select
                value={weekendSolveMode()}
                onChange={(e) =>
                  setWeekendSolveMode(
                    Schema.decodeUnknownSync(Schema.Literals(["before", "after"]))(
                      e.currentTarget.value,
                    ),
                  )
                }
              >
                <option value="after">Move to Monday (after)</option>
                <option value="before">Move to Friday (before)</option>
              </select>
            </div>
          </Show>

          <div class="form-group">
            <label>End condition</label>
            <select value={endMode()} onChange={(e) => setEndMode(e.currentTarget.value)}>
              <option value="never">Never ends</option>
              <option value="after_n_occurrences">After N occurrences</option>
              <option value="on_date">On specific date</option>
            </select>
          </div>
          <Show when={endMode() === "after_n_occurrences"}>
            <div class="form-group">
              <label>Occurrences</label>
              <input
                type="number"
                min="1"
                value={endOccurrences()}
                onInput={(e) => setEndOccurrences(parseInt(e.currentTarget.value) || 1)}
              />
            </div>
          </Show>
          <Show when={endMode() === "on_date"}>
            <div class="form-group">
              <label>End date</label>
              <input
                type="date"
                value={endDate()}
                onInput={(e) => setEndDate(e.currentTarget.value)}
              />
            </div>
          </Show>

          <div class="form-actions">
            <button type="button" class="btn btn-ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={saving()}>
              {saving() ? "Saving..." : isEdit() ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DiscoverCandidate {
  payee: string;
  accountId: string;
  accountName: string;
  categoryId?: string | null;
  amount: number;
  recurrenceType: string;
  intervalDays: number;
  confidence: number;
  transactionCount: number;
  matchedTransactionCount: number;
}

function DiscoverModal(props: {
  fmt: ReturnType<typeof useCurrency>;
  df: ReturnType<typeof useDateFormat>;
  privacyClass: string;
  onClose: () => void;
  onCreateSchedule: (candidate: DiscoverCandidate) => void;
}) {
  const [candidates, setCandidates] = createSignal<DiscoverCandidate[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<Set<string>>(new Set());

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  createEffect(() => {
    void loadCandidates();
  });

  async function loadCandidates() {
    setError(null);
    try {
      const data = await api.schedulesDiscover();
      setCandidates([...(data.discovered ?? [])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to discover");
    } finally {
      setLoading(false);
    }
  }

  function handleCreate(candidate: DiscoverCandidate) {
    setCreated((prev) => new Set(prev).add(`${candidate.payee}||${candidate.accountId}`));
    props.onCreateSchedule(candidate);
  }

  function recurrenceLabel(type: string): string {
    const labels = new Map<string, string>(
      Object.entries({
        weekly: "Weekly",
        biweekly: "Bi-weekly",
        monthly: "Monthly",
        quarterly: "Quarterly",
        yearly: "Yearly",
      }),
    );
    return labels.get(type) ?? type;
  }

  function confidenceClass(conf: number): string {
    if (conf >= 80) return "confidence-high";
    if (conf >= 60) return "confidence-mid";
    return "confidence-low";
  }

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div
        class="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discover-schedules-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h2 id="discover-schedules-title">Discover Recurring Transactions</h2>
          <button
            type="button"
            class="modal-close"
            onClick={props.onClose}
            aria-label="Close recurring transaction discovery"
          >
            ✕
          </button>
        </div>
        <div class="modal-body">
          <Show when={loading()}>
            <p class="text-muted">Analyzing transaction history...</p>
          </Show>
          <Show when={error()}>
            <p class="text-danger">{error()}</p>
          </Show>
          <Show when={!loading() && !error() && candidates().length === 0}>
            <p class="text-muted">No recurring patterns detected. Add more transactions first.</p>
          </Show>
          <Show when={!loading() && !error() && candidates().length > 0}>
            <p class="text-muted" style="margin-bottom: 1rem">
              Found {candidates().length} recurring pattern{candidates().length !== 1 ? "s" : ""} in
              your transaction history.
            </p>
            <div class="discover-list">
              <For each={candidates()}>
                {(candidate) => {
                  const isCreated = () =>
                    created().has(`${candidate.payee}||${candidate.accountId}`);
                  return (
                    <div class="discover-card">
                      <div class="discover-info">
                        <div class="discover-payee">{candidate.payee}</div>
                        <div class="discover-meta">
                          {candidate.accountName && `${candidate.accountName} · `}
                          <span class={props.privacyClass}>
                            {props.fmt().formatCents(candidate.amount)}
                          </span>{" "}
                          · {recurrenceLabel(candidate.recurrenceType)}
                        </div>
                        <div class="discover-stats">
                          <span class={`confidence-badge ${confidenceClass(candidate.confidence)}`}>
                            {candidate.confidence}% confidence
                          </span>
                          <span class="text-muted">
                            {candidate.matchedTransactionCount} of {candidate.transactionCount}{" "}
                            transactions matched
                          </span>
                        </div>
                      </div>
                      <button
                        class="btn btn-sm btn-primary"
                        onClick={() => handleCreate(candidate)}
                        disabled={isCreated()}
                      >
                        {isCreated() ? "Created" : "Create Schedule"}
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
