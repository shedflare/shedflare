import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { canRecordPayment, runPaymentAction, type PaymentAction } from "../lib/recurring-actions";
import {
  orderedPayments,
  paymentDate,
  paymentOccurrences,
  recurrenceLabel,
  type RecurringPayment,
} from "../lib/recurring-view";
import { formatCalendarDate, monthBoundaries } from "../domain/types";
import { PageState } from "./PageState";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import CategoryBadge from "./CategoryBadge";
import RecurringPaymentForm from "./RecurringPaymentForm";
import type {
  AccountsResponse,
  CategoriesResponse,
  DiscoveredSchedule,
} from "../domain/schemas-client";

type Accounts = AccountsResponse["accounts"];
type Categories = CategoriesResponse["categories"];
type RowAction = { id: string; kind: PaymentAction } | null;

/** Recurring payments laid out against the plan month, with inline record/skip. */
export default function RecurringPanel(props: {
  month: string;
  payments: readonly RecurringPayment[];
  accounts: Accounts;
  categories: Categories;
  focusId?: string;
  onFocus: (id: string | undefined) => void;
}) {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [form, setForm] = createSignal<{
    payment?: RecurringPayment;
    candidate?: DiscoveredSchedule;
  } | null>(null);
  const [discover, setDiscover] = createSignal(false);
  const [pending, setPending] = createSignal<RowAction>(null);
  const [failure, setFailure] = createSignal<{ id: string; message: string } | null>(null);
  const today = formatCalendarDate(new Date());
  const bounds = createMemo(() => monthBoundaries(props.month));
  const active = createMemo(() =>
    orderedPayments(props.payments.filter((row) => row.active && !row.completed)),
  );
  const overdue = createMemo(() => active().filter((row) => (paymentDate(row) ?? today) < today));
  const inMonth = createMemo(() =>
    active()
      .filter((row) => (paymentDate(row) ?? today) >= today)
      .map((payment) => ({
        payment,
        dates: paymentOccurrences(
          payment,
          bounds().start > today ? bounds().start : today,
          bounds().end,
        ),
      }))
      .filter((row) => row.dates.length > 0),
  );
  const later = createMemo(() => {
    const shown = new Set([...overdue(), ...inMonth().map((row) => row.payment)].map((p) => p.id));
    return active().filter((row) => !shown.has(row.id));
  });
  const paused = createMemo(() =>
    orderedPayments(props.payments.filter((row) => !row.active && !row.completed)),
  );
  const finished = createMemo(() => orderedPayments(props.payments.filter((row) => row.completed)));
  const monthTotals = createMemo(() =>
    [...overdue().map((payment) => ({ payment, dates: [paymentDate(payment)!] })), ...inMonth()]
      .filter((row) => row.payment.amount !== null)
      .reduce(
        (totals, row) => {
          const amount = row.payment.amount! * row.dates.length;
          return amount < 0
            ? { ...totals, out: totals.out - amount }
            : { ...totals, in: totals.in + amount };
        },
        { in: 0, out: 0 },
      ),
  );
  const selected = createMemo(() => props.payments.find((row) => row.id === props.focusId));

  async function quick(payment: RecurringPayment, kind: PaymentAction) {
    if (pending()) return;
    if (kind === "record" && !canRecordPayment(payment, props.accounts)) {
      setForm({ payment });
      return;
    }
    setPending({ id: payment.id, kind });
    setFailure(null);
    try {
      await runPaymentAction(payment, kind);
    } catch (caught) {
      setFailure({
        id: payment.id,
        message: caught instanceof Error ? caught.message : "Could not update payment",
      });
    } finally {
      setPending(null);
    }
  }

  function amountLabel(payment: RecurringPayment, times = 1) {
    if (payment.amount === null) return "Variable";
    return `${payment.amount > 0 ? "+" : ""}${fmt().formatCents(Math.abs(payment.amount) * times)}`;
  }

  function row(payment: RecurringPayment, dates: readonly string[], tone?: "overdue") {
    const category = () => props.categories.find((item) => item.id === payment.categoryId);
    const account = () => props.accounts.find((item) => item.id === payment.accountId);
    const busy = () => pending()?.id === payment.id;
    const first = () => dates[0] ?? paymentDate(payment);
    return (
      <div class="rec-row" classList={{ "is-overdue": tone === "overdue" }}>
        <button type="button" class="rec-row-main" onClick={() => props.onFocus(payment.id)}>
          <span class="rec-date">
            <Show when={first()} fallback={<strong>—</strong>}>
              <small>
                {new Intl.DateTimeFormat(undefined, { month: "short" }).format(
                  new Date(`${first()}T12:00:00`),
                )}
              </small>
              <strong>{Number(first()!.slice(8, 10))}</strong>
            </Show>
          </span>
          <span class="rec-name">
            <strong>{payment.name || "Recurring payment"}</strong>
            <small>
              <Show when={tone === "overdue"} fallback={recurrenceLabel(payment.recurrenceRules)}>
                Overdue
              </Show>
              <Show when={dates.length > 1}> · {dates.length}× this month</Show>
              {" · "}
              {category()?.name ?? account()?.name ?? "No category"}
            </small>
          </span>
          <span
            class={`rec-amount ${privacy().blurClass()}`}
            classList={{ "money-in": (payment.amount ?? 0) > 0 }}
          >
            {amountLabel(payment, Math.max(1, dates.length))}
          </span>
        </button>
        <span class="rec-actions">
          <button
            type="button"
            class="btn btn-icon btn-ghost btn-sm"
            title={
              canRecordPayment(payment, props.accounts) ? "Record payment" : "Complete details"
            }
            aria-label={`Record ${payment.name || "payment"}`}
            disabled={!!pending()}
            onClick={() => void quick(payment, "record")}
          >
            <Show
              when={busy() && pending()?.kind === "record"}
              fallback={<MoneyIcon name="check" size={15} />}
            >
              …
            </Show>
          </button>
          <button
            type="button"
            class="btn btn-icon btn-ghost btn-sm"
            title="Skip this date"
            aria-label={`Skip ${payment.name || "payment"}`}
            disabled={!!pending()}
            onClick={() => void quick(payment, "skip")}
          >
            <Show
              when={busy() && pending()?.kind === "skip"}
              fallback={<MoneyIcon name="arrow" size={15} />}
            >
              …
            </Show>
          </button>
        </span>
        <Show when={failure()?.id === payment.id}>
          <p class="form-error rec-error" role="alert">
            {failure()!.message}
          </p>
        </Show>
      </div>
    );
  }

  return (
    <section class="ws-panel">
      <div class="ws-panel-heading">
        <h2>Recurring</h2>
        <div class="ws-panel-actions">
          <button type="button" class="text-button" onClick={() => setDiscover(true)}>
            Discover
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onClick={() => setForm({})}
            aria-label="Add recurring payment"
          >
            <MoneyIcon name="plus" size={15} />
            Add
          </button>
        </div>
      </div>
      <div class={`rec-summary ${privacy().blurClass()}`}>
        <span>
          Still due in {df().formatMonth(props.month).split(" ")[0]}
          <strong>{fmt().formatCents(monthTotals().out)}</strong>
        </span>
        <Show when={monthTotals().in > 0}>
          <span>
            Expected in
            <strong class="money-in">+{fmt().formatCents(monthTotals().in)}</strong>
          </span>
        </Show>
      </div>
      <Show when={overdue().length}>
        <h3 class="rec-section-title is-overdue">Overdue</h3>
        <div class="rec-list">
          <For each={overdue()}>
            {(payment) => row(payment, [paymentDate(payment)!], "overdue")}
          </For>
        </div>
      </Show>
      <h3 class="rec-section-title">Due in {df().formatMonth(props.month).split(" ")[0]}</h3>
      <Show when={inMonth().length} fallback={<p class="ws-empty">Nothing else due this month</p>}>
        <div class="rec-list">
          <For each={inMonth()}>{(entry) => row(entry.payment, entry.dates)}</For>
        </div>
      </Show>
      <Show when={later().length}>
        <details class="rec-archive">
          <summary>
            Later <span>{later().length}</span>
          </summary>
          <div class="rec-list">
            <For each={later()}>{(payment) => row(payment, [])}</For>
          </div>
        </details>
      </Show>
      <Show when={paused().length}>
        <details class="rec-archive">
          <summary>
            Paused <span>{paused().length}</span>
          </summary>
          <div class="rec-list">
            <For each={paused()}>{(payment) => row(payment, [])}</For>
          </div>
        </details>
      </Show>
      <Show when={finished().length}>
        <details class="rec-archive">
          <summary>
            Finished <span>{finished().length}</span>
          </summary>
          <div class="rec-list">
            <For each={finished()}>{(payment) => row(payment, [])}</For>
          </div>
        </details>
      </Show>
      <Show when={!form() && selected()?.id} keyed>
        {(id) => (
          <PaymentDetail
            payment={props.payments.find((item) => item.id === id)!}
            accounts={props.accounts}
            categories={props.categories}
            onClose={() => props.onFocus(undefined)}
            onEdit={(payment) => setForm({ payment })}
          />
        )}
      </Show>
      <Show when={form()} keyed>
        {(draft) => (
          <RecurringPaymentForm
            {...draft}
            accounts={props.accounts}
            categories={props.categories}
            onClose={() => {
              setForm(null);
              props.onFocus(undefined);
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
    </section>
  );
}

function PaymentDetail(props: {
  payment: RecurringPayment;
  accounts: Accounts;
  categories: Categories;
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
  const ready = () => canRecordPayment(props.payment, props.accounts);
  async function act(kind: PaymentAction) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await runPaymentAction(props.payment, kind);
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
              onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
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
