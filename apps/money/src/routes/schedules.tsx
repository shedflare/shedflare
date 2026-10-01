import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { api } from "../lib/api";
import { dispatch } from "../lib/pending-ops";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { emitMoneyDataChanged, listenForMoneyDataChanged } from "../lib/data-events";
import { PageState } from "../components/PageState";
import MoneyDialog from "../components/MoneyDialog";
import MoneyIcon from "../components/MoneyIcon";
import CategoryBadge from "../components/CategoryBadge";
import RecurringPaymentForm from "../components/RecurringPaymentForm";
import {
  orderedPayments,
  paymentDate,
  recurrenceLabel,
  type RecurringPayment,
} from "../lib/recurring-view";
import { formatCalendarDate } from "../domain/types";
import type {
  AccountsResponse,
  CategoriesResponse,
  DiscoveredSchedule,
} from "../domain/schemas-client";

type PaymentData = {
  payments: RecurringPayment[];
  accounts: AccountsResponse["accounts"];
  categories: CategoriesResponse["categories"];
};
export default function SchedulesPage() {
  const [params, setParams] = useSearchParams<{ focus?: string }>();
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [data, setData] = createSignal<PaymentData | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [form, setForm] = createSignal<{
    payment?: RecurringPayment;
    candidate?: DiscoveredSchedule;
  } | null>(null);
  const [discover, setDiscover] = createSignal(false);
  let requestId = 0;
  async function load() {
    const request = ++requestId;
    setLoading(true);
    setError(null);
    try {
      const [payments, accounts, categories] = await Promise.all([
        api.schedules(),
        api.accounts(),
        api.categories(),
      ]);
      if (request === requestId)
        setData({
          payments: [...payments.schedules],
          accounts: accounts.accounts,
          categories: categories.categories,
        });
    } catch (caught) {
      if (request === requestId)
        setError(caught instanceof Error ? caught.message : "Could not load recurring payments");
    } finally {
      if (request === requestId) setLoading(false);
    }
  }
  onMount(() => {
    void load();
    onCleanup(listenForMoneyDataChanged(load));
  });
  onCleanup(() => {
    requestId++;
  });
  const today = formatCalendarDate(new Date());
  const active = createMemo(() =>
    orderedPayments(data()?.payments.filter((row) => row.active && !row.completed) ?? []),
  );
  const overdue = createMemo(() => active().filter((row) => (paymentDate(row) ?? today) < today));
  const upcoming = createMemo(() => active().filter((row) => (paymentDate(row) ?? today) >= today));
  const paused = createMemo(() =>
    orderedPayments(data()?.payments.filter((row) => !row.active && !row.completed) ?? []),
  );
  const finished = createMemo(() =>
    orderedPayments(data()?.payments.filter((row) => row.completed) ?? []),
  );
  const selected = createMemo(() => data()?.payments.find((row) => row.id === params.focus));
  function rows(payments: RecurringPayment[]) {
    return (
      <div class="recurring-list">
        <For each={payments}>
          {(payment) => {
            const category = () => data()?.categories.find((row) => row.id === payment.categoryId);
            return (
              <button class="recurring-row" onClick={() => setParams({ focus: payment.id })}>
                <CategoryBadge
                  name={category()?.name ?? payment.name ?? "Payment"}
                  icon={category()?.icon}
                />
                <span class="recurring-row-name">
                  <strong>{payment.name || "Recurring payment"}</strong>
                  <small>
                    {payment.completed
                      ? "Finished"
                      : !payment.active
                        ? "Paused"
                        : paymentDate(payment)
                          ? df().formatDate(paymentDate(payment)!)
                          : "Set a date"}
                  </small>
                </span>
                <span
                  class={`recurring-row-amount ${privacy().blurClass()}`}
                  classList={{ "money-in": (payment.amount ?? 0) > 0 }}
                >
                  {payment.amount === null
                    ? "Variable"
                    : `${payment.amount > 0 ? "+" : ""}${fmt().formatCents(Math.abs(payment.amount))}`}
                </span>
              </button>
            );
          }}
        </For>
      </div>
    );
  }
  return (
    <div class="page recurring-page" aria-busy={loading()}>
      <div class="page-header">
        <h1 class="page-title">Recurring</h1>
        <div class="recurring-header-actions">
          <details class="entity-menu">
            <summary aria-label="Recurring actions">
              <MoneyIcon name="more" />
            </summary>
            <div
              class="entity-menu-popover"
              onClick={() => {
                document
                  .querySelectorAll(".entity-menu[open]")
                  .forEach((menu) => menu.removeAttribute("open"));
              }}
            >
              <button disabled={!data()} onClick={() => setDiscover(true)}>
                Discover payments
              </button>
            </div>
          </details>
          <button class="btn btn-primary btn-sm" disabled={!data()} onClick={() => setForm({})}>
            <MoneyIcon name="plus" size={17} />
            Add
          </button>
        </div>
      </div>
      <PageState loading={loading() && !data()} error={error()} onRetry={load}>
        <Show when={overdue().length}>
          <section class="recurring-section">
            <h2 class="recurring-section-title overdue">Overdue</h2>
            {rows(overdue())}
          </section>
        </Show>
        <Show when={upcoming().length}>
          <section class="recurring-section">
            <h2 class="recurring-section-title">Upcoming</h2>
            {rows(upcoming())}
          </section>
        </Show>
        <Show when={!active().length}>
          <p class="quiet-empty">No upcoming payments</p>
        </Show>
        <Show when={paused().length}>
          <details class="recurring-archive">
            <summary>
              Paused <span>{paused().length}</span>
            </summary>
            {rows(paused())}
          </details>
        </Show>
        <Show when={finished().length}>
          <details class="recurring-archive">
            <summary>
              Finished <span>{finished().length}</span>
            </summary>
            {rows(finished())}
          </details>
        </Show>
      </PageState>
      <Show when={!form() && selected()?.id} keyed>
        {(id) => (
          <PaymentDetail
            payment={data()!.payments.find((row) => row.id === id)!}
            accounts={data()!.accounts}
            categories={data()!.categories}
            onClose={() => setParams({ focus: undefined }, { replace: true })}
            onEdit={(payment) => setForm({ payment })}
          />
        )}
      </Show>
      <Show when={form()} keyed>
        {(draft) => (
          <RecurringPaymentForm
            {...draft}
            accounts={data()!.accounts}
            categories={data()!.categories}
            onClose={() => {
              setForm(null);
              setParams({ focus: undefined }, { replace: true });
            }}
          />
        )}
      </Show>
      <Show when={discover()}>
        <DiscoverPayments
          onClose={() => setDiscover(false)}
          onUse={(candidate) => {
            setDiscover(false);
            setForm({ candidate });
          }}
        />
      </Show>
    </div>
  );
}

function PaymentDetail(props: {
  payment: RecurringPayment;
  accounts: AccountsResponse["accounts"];
  categories: CategoriesResponse["categories"];
  onClose: () => void;
  onEdit: (payment: RecurringPayment) => void;
}) {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const account = () => props.accounts.find((row) => row.id === props.payment.accountId);
  const category = () => props.categories.find((row) => row.id === props.payment.categoryId);
  const ready = () => !!account() && !account()?.closed && props.payment.amount !== null;
  async function act(kind: "record" | "skip" | "pause" | "archive") {
    if (busy()) return;
    const original = props.payment;
    setBusy(true);
    setError(null);
    try {
      if (kind === "record") {
        await dispatch(
          "post_schedule_transaction",
          { scheduleId: original.id },
          {
            undoInfo: {
              label: "Payment recorded",
              inverse: (data) => {
                if (!data.transactionId) throw new Error("Payment response has no transaction ID");
                return {
                  commandType: "undo_schedule_payment",
                  payload: {
                    scheduleId: original.id,
                    transactionId: data.transactionId,
                    nextDate: original.nextDate,
                    completed: original.completed,
                    recurrenceRules: original.recurrenceRules,
                  },
                };
              },
            },
          },
        ).promise;
      } else if (kind === "skip") {
        await dispatch(
          "skip_schedule_date",
          { id: original.id },
          {
            undoInfo: {
              label: "Payment skipped",
              inverse: {
                commandType: "update_schedule",
                payload: {
                  id: original.id,
                  fields: {
                    nextDate: original.nextDate,
                    completed: original.completed,
                    recurrenceRules: original.recurrenceRules,
                  },
                },
              },
            },
          },
        ).promise;
      } else {
        await dispatch(
          "update_schedule",
          {
            id: original.id,
            fields:
              kind === "archive"
                ? { active: false, completed: true }
                : { active: !original.active, completed: false },
          },
          {
            undoInfo: {
              label:
                kind === "archive"
                  ? "Payment archived"
                  : original.active
                    ? "Payment paused"
                    : "Payment resumed",
              inverse: {
                commandType: "update_schedule",
                payload: {
                  id: original.id,
                  fields: { active: original.active, completed: original.completed },
                },
              },
            },
          },
        ).promise;
      }
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update payment");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog
      title={props.payment.name || "Recurring payment"}
      drawer
      busy={busy()}
      onClose={props.onClose}
    >
      <div class="payment-detail money-form">
        <div class="payment-detail-top">
          <CategoryBadge
            name={category()?.name ?? props.payment.name ?? "Payment"}
            icon={category()?.icon}
          />
          <details class="entity-menu">
            <summary aria-label="Payment actions">
              <MoneyIcon name="more" />
            </summary>
            <div
              class="entity-menu-popover"
              onClick={() => {
                document
                  .querySelectorAll(".entity-menu[open]")
                  .forEach((menu) => menu.removeAttribute("open"));
              }}
            >
              <button disabled={busy()} onClick={() => props.onEdit(props.payment)}>
                Edit
              </button>
              <button disabled={busy()} onClick={() => void act("pause")}>
                {props.payment.completed ? "Resume" : props.payment.active ? "Pause" : "Resume"}
              </button>
              <Show when={!props.payment.completed}>
                <button disabled={busy()} onClick={() => void act("archive")}>
                  Archive
                </button>
              </Show>
            </div>
          </details>
        </div>
        <strong
          class={`payment-detail-amount ${privacy().blurClass()}`}
          classList={{ "money-in": (props.payment.amount ?? 0) > 0 }}
        >
          {props.payment.amount === null
            ? "Variable"
            : `${props.payment.amount > 0 ? "+" : ""}${fmt().formatCents(Math.abs(props.payment.amount))}`}
        </strong>
        <div class="payment-detail-date">
          <span>
            {props.payment.completed
              ? "Finished"
              : !props.payment.active
                ? "Paused"
                : paymentDate(props.payment)
                  ? df().formatDate(paymentDate(props.payment)!)
                  : "Set a date"}
          </span>
          <span>{recurrenceLabel(props.payment.recurrenceRules)}</span>
        </div>
        <div class="payment-detail-meta">
          <MoneyIcon name="accounts" size={17} />
          <span>{account()?.name ?? "Choose account"}</span>
          <Show when={category()}>
            <CategoryBadge name={category()!.name} icon={category()!.icon} small />
            <span>{category()!.name}</span>
          </Show>
        </div>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show
          when={props.payment.active && !props.payment.completed}
          fallback={
            <button
              class="btn btn-primary btn-full"
              disabled={busy()}
              onClick={() => void act("pause")}
            >
              {busy() ? "Saving…" : "Resume"}
            </button>
          }
        >
          <div class="payment-detail-actions">
            <button class="btn btn-secondary" disabled={busy()} onClick={() => void act("skip")}>
              Skip
            </button>
            <button
              class="btn btn-primary"
              disabled={busy()}
              onClick={() => (ready() ? void act("record") : props.onEdit(props.payment))}
            >
              {busy() ? "Saving…" : ready() ? "Record payment" : "Complete details"}
            </button>
          </div>
        </Show>
      </div>
    </MoneyDialog>
  );
}

function DiscoverPayments(props: {
  onClose: () => void;
  onUse: (candidate: DiscoveredSchedule) => void;
}) {
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const [rows, setRows] = createSignal<DiscoveredSchedule[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  let cancelled = false;
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.schedulesDiscover();
      if (!cancelled) setRows([...result.discovered]);
    } catch (caught) {
      if (!cancelled)
        setError(caught instanceof Error ? caught.message : "Could not discover payments");
    } finally {
      if (!cancelled) setLoading(false);
    }
  }
  onMount(() => void load());
  onCleanup(() => {
    cancelled = true;
  });
  return (
    <MoneyDialog title="Discover payments" drawer onClose={props.onClose}>
      <div class="money-form">
        <PageState loading={loading()} error={error()} onRetry={load}>
          <Show
            when={rows().length}
            fallback={<p class="quiet-empty">No recurring patterns found</p>}
          >
            <For each={rows()}>
              {(row) => (
                <div class="discovered-payment">
                  <div>
                    <strong>{row.payee}</strong>
                    <small>
                      {row.accountName} ·{" "}
                      {recurrenceLabel(JSON.stringify({ type: row.recurrenceType }))}
                    </small>
                    <span class={privacy().blurClass()}>
                      {fmt().formatCents(Math.abs(row.amount))}
                    </span>
                  </div>
                  <button class="btn btn-secondary btn-sm" onClick={() => props.onUse(row)}>
                    Use
                  </button>
                </div>
              )}
            </For>
          </Show>
        </PageState>
      </div>
    </MoneyDialog>
  );
}
