import { createSignal, createMemo, createEffect, For, Show, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { dispatch } from "../lib/pending-ops";
import { api } from "../lib/api";
import { accountLedger } from "../lib/account-view";
import { emitMoneyDataChanged } from "../lib/data-events";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { useDateFormat } from "../lib/date-format";
import type { CommandPayloadMap } from "../domain/commands";
import type { CommandPayload, CommandType } from "../lib/api";
import { emitOperationFeedback } from "../lib/operation-feedback";

export interface TransactionRow {
  id: string;
  accountId: string;
  accountName?: string;
  date: string;
  createdAt?: string;
  amount: number;
  payee: string | null;
  categoryId: string | null;
  categoryName: string | null;
  notes: string | null;
  cleared: boolean;
  reconciled: boolean;
  isParent?: boolean;
  isChild?: boolean;
  parentId?: string | null;
  transferId?: string | null;
  scheduleId?: string | null;
  scheduleName?: string | null;
  tags?: { id: string; name: string; color: string | null }[];
}

export interface TagInfo {
  id: string;
  name: string;
  color: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
  groupName: string | null;
}

interface SplitChild {
  tempId: string;
  categoryId: string;
  amount: string;
  notes: string;
}

type TxField = "date" | "payee" | "amount" | "category" | "notes";
export type TransactionPatch = Partial<
  Pick<
    TransactionRow,
    "date" | "payee" | "amount" | "categoryId" | "categoryName" | "notes" | "cleared" | "reconciled"
  >
>;
type TransactionUpdateFields = CommandPayloadMap["update_transaction"]["fields"];
interface UndoCommand {
  commandType: CommandType;
  payload: CommandPayload;
}

interface TransactionTableProps {
  focusId?: string;
  transactions: TransactionRow[];
  categories: CategoryRow[];
  txTags: Record<string, TagInfo[]>;
  tagList: TagInfo[];
  showBalance?: boolean;
  openingBalance?: number;
  showAccount?: boolean;
  accountNames?: Record<string, string>;
  onCreateSchedule?: (tx: TransactionRow) => void;
  onTransactionPatch?: (id: string, patch: TransactionPatch) => void;
  onTransactionRemove?: (id: string) => void;
  onTransactionRestore?: (tx: TransactionRow) => void;
  onTagAdd?: (txId: string, tag: TagInfo) => void;
  onTagRemove?: (txId: string, tagId: string) => void;
  onReload?: () => void | Promise<void>;
}

export default function TransactionTable(props: TransactionTableProps) {
  const navigate = useNavigate();
  const fmt = useCurrency();
  const privacyBlur = usePrivacyMode();
  const df = useDateFormat();

  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editingField, setEditingField] = createSignal<TxField | null>(null);

  const [splitParentId, setSplitParentId] = createSignal<string | null>(null);
  const [splitChildren, setSplitChildren] = createSignal<SplitChild[]>([]);
  const [showTagPicker, setShowTagPicker] = createSignal<string | null>(null);
  const [statusPending, setStatusPending] = createSignal<Set<string>>(new Set());

  createEffect(() => {
    if (showTagPicker()) {
      const handler = () => setShowTagPicker(null);
      document.addEventListener("click", handler);
      onCleanup(() => document.removeEventListener("click", handler));
    }
  });

  const payeeNames = createMemo(() => {
    const names = new Set<string>();
    for (const tx of props.transactions) {
      if (tx.payee) names.add(tx.payee);
    }
    return [...names].sort();
  });

  const transactionsWithBalance = createMemo(() => {
    if (!props.showBalance)
      return props.transactions.map((transaction) => ({ ...transaction, balance: 0 }));
    return accountLedger(props.transactions, props.openingBalance ?? 0);
  });

  function rollbackPatch(tx: TransactionRow, patch: TransactionPatch): TransactionPatch {
    const previous: TransactionPatch = {};
    if ("date" in patch) previous.date = tx.date;
    if ("payee" in patch) previous.payee = tx.payee;
    if ("amount" in patch) previous.amount = tx.amount;
    if ("categoryId" in patch) previous.categoryId = tx.categoryId;
    if ("categoryName" in patch) previous.categoryName = tx.categoryName;
    if ("notes" in patch) previous.notes = tx.notes;
    if ("cleared" in patch) previous.cleared = tx.cleared;
    if ("reconciled" in patch) previous.reconciled = tx.reconciled;
    return previous;
  }

  function categoryNameFor(id: string | null): string | null {
    return id ? (props.categories.find((cat) => cat.id === id)?.name ?? null) : null;
  }

  function applyOptimisticPatch(
    tx: TransactionRow,
    commandFields: TransactionUpdateFields,
    optimisticPatch: TransactionPatch,
    undoLabel: string,
  ): Promise<void> {
    const { promise } = dispatch(
      "update_transaction",
      { id: tx.id, fields: commandFields },
      {
        undoInfo: { label: undoLabel, inverse: undoUpdateTx(tx, commandFields) },
      },
    );
    props.onTransactionPatch?.(tx.id, optimisticPatch);
    return promise
      .then(() => {
        if (!props.onTransactionPatch) void props.onReload?.();
      })
      .catch((err) => {
        props.onTransactionPatch?.(tx.id, rollbackPatch(tx, optimisticPatch));
        console.warn("[TransactionTable] transaction update failed", err);
      });
  }

  function startEdit(txId: string, field: TxField) {
    if (
      props.transactions.find((row) => row.id === txId)?.transferId &&
      (field === "date" || field === "amount" || field === "category")
    )
      return;
    setEditingId(txId);
    setEditingField(field);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingField(null);
  }

  function undoUpdateTx(tx: TransactionRow, fields: TransactionUpdateFields): UndoCommand {
    const oldFields: {
      -readonly [K in keyof TransactionUpdateFields]?: TransactionUpdateFields[K];
    } = {};
    if ("amount" in fields) oldFields.amount = tx.amount;
    if ("date" in fields) oldFields.date = tx.date;
    if ("payee" in fields) oldFields.payee = tx.payee;
    if ("notes" in fields) oldFields.notes = tx.notes;
    if ("categoryId" in fields) oldFields.categoryId = tx.categoryId;
    if ("cleared" in fields) oldFields.cleared = tx.cleared;
    if ("reconciled" in fields) oldFields.reconciled = tx.reconciled;
    return { commandType: "update_transaction", payload: { id: tx.id, fields: oldFields } };
  }

  function saveEdit(tx: TransactionRow, field: TxField, value: string) {
    if (field === "amount") {
      const cents = fmt().parseInput(value);
      if (!Number.isSafeInteger(cents)) {
        emitOperationFeedback({ kind: "error", message: "Enter a valid amount.", undoable: false });
        return;
      }
      if (cents !== tx.amount) {
        void applyOptimisticPatch(tx, { amount: cents }, { amount: cents }, "Update amount");
      }
    } else if (field === "date") {
      if (value !== tx.date) {
        void applyOptimisticPatch(tx, { date: value }, { date: value }, "Update date");
      }
    } else if (field === "payee") {
      if (value !== (tx.payee ?? "")) {
        const payee = value || null;
        void applyOptimisticPatch(tx, { payee }, { payee }, "Update payee");
        if (value.trim() && !tx.categoryId) {
          void fetchCategorySuggestion(tx, value.trim());
        }
      }
    } else if (field === "notes") {
      if (value !== (tx.notes ?? "")) {
        const notes = value || null;
        void applyOptimisticPatch(tx, { notes }, { notes }, "Update notes");
      }
    } else if (field === "category") {
      const catId = value || null;
      if (catId !== tx.categoryId) {
        void applyOptimisticPatch(
          tx,
          { categoryId: catId },
          { categoryId: catId, categoryName: categoryNameFor(catId) },
          "Update category",
        );
      }
    }
    cancelEdit();
  }

  async function fetchCategorySuggestion(tx: TransactionRow, payee: string) {
    try {
      const data = await api.payeeSuggestions(payee);
      if (data.suggestions.length > 0) {
        const categoryId = data.suggestions[0].category_id;
        void applyOptimisticPatch(
          tx,
          { categoryId },
          { categoryId, categoryName: categoryNameFor(categoryId) },
          "Set category from payee",
        );
      }
    } catch {
      console.warn("[TransactionTable] failed to fetch category suggestion");
    }
  }

  async function handleDelete(tx: TransactionRow) {
    if (tx.transferId) {
      try {
        const data = await api.transactions();
        const other = data.transactions.find((row) => row.id === tx.transferId);
        if (!other || other.transferId !== tx.id) throw new Error("The linked transfer is missing");
        const debit = tx.amount < 0 ? tx : other;
        const credit = tx.amount < 0 ? other : tx;
        await dispatch(
          "delete_account_transfer",
          { id: tx.id },
          {
            undoInfo: {
              label: "Transfer removed",
              inverse: {
                commandType: "create_account_transfer",
                payload: {
                  fromAccountId: debit.accountId,
                  toAccountId: credit.accountId,
                  amount: -debit.amount,
                  date: debit.date,
                  fromPayee: debit.payee,
                  toPayee: credit.payee,
                  fromNotes: debit.notes,
                  toNotes: credit.notes,
                  fromCleared: debit.cleared,
                  toCleared: credit.cleared,
                },
              },
            },
          },
        ).promise;
        emitMoneyDataChanged();
        await props.onReload?.();
      } catch (caught) {
        emitOperationFeedback({
          kind: "error",
          message: caught instanceof Error ? caught.message : "Could not remove transfer",
          undoable: false,
        });
      }
      return;
    }
    const { promise } = dispatch(
      "delete_transaction",
      { id: tx.id },
      {
        undoInfo: {
          label: "Delete transaction",
          inverse: {
            commandType: "create_transaction",
            payload: {
              row: {
                accountId: tx.accountId,
                date: tx.date,
                amount: tx.amount,
                payee: tx.payee ?? undefined,
                notes: tx.notes ?? undefined,
                categoryId: tx.categoryId ?? null,
                cleared: tx.cleared,
                reconciled: tx.reconciled,
                isParent: tx.isParent,
                isChild: tx.isChild,
                parentId: tx.parentId,
                scheduleId: tx.scheduleId,
              },
            },
          },
        },
      },
    );
    props.onTransactionRemove?.(tx.id);
    void promise.catch((err) => {
      props.onTransactionRestore?.(tx);
      console.warn("[TransactionTable] transaction delete failed", err);
    });
  }

  async function toggleCleared(tx: TransactionRow) {
    if (statusPending().has(tx.id)) return;
    const cleared = !tx.cleared;
    setStatusPending((current) => new Set(current).add(tx.id));
    try {
      await applyOptimisticPatch(
        tx,
        { cleared },
        { cleared },
        cleared ? "Marked cleared" : "Marked pending",
      );
    } finally {
      setStatusPending((current) => {
        const next = new Set(current);
        next.delete(tx.id);
        return next;
      });
    }
  }

  async function toggleReconciled(tx: TransactionRow) {
    if (statusPending().has(tx.id)) return;
    const reconciled = !tx.reconciled;
    setStatusPending((current) => new Set(current).add(tx.id));
    try {
      await applyOptimisticPatch(
        tx,
        { reconciled },
        { reconciled },
        reconciled ? "Matched to statement" : "Reconciliation undone",
      );
    } finally {
      setStatusPending((current) => {
        const next = new Set(current);
        next.delete(tx.id);
        return next;
      });
    }
  }

  function initSplit(tx: TransactionRow) {
    setSplitParentId(tx.id);
    setSplitChildren([{ tempId: crypto.randomUUID(), categoryId: "", amount: "", notes: "" }]);
  }

  function addSplitChild() {
    setSplitChildren((prev) => [
      ...prev,
      { tempId: crypto.randomUUID(), categoryId: "", amount: "", notes: "" },
    ]);
  }

  function updateSplitChild(tempId: string, field: keyof SplitChild, value: string) {
    setSplitChildren((prev) =>
      prev.map((c) => (c.tempId === tempId ? { ...c, [field]: value } : c)),
    );
  }

  function cancelSplit() {
    setSplitParentId(null);
    setSplitChildren([]);
  }

  function saveSplit() {
    const parentId = splitParentId();
    if (!parentId) return;

    const parent = props.transactions.find((t) => t.id === parentId);
    if (!parent) return;

    const children = splitChildren()
      .map((c) => {
        const cents = fmt().parseInput(c.amount);
        if (cents === 0) return null;
        return {
          accountId: parent.accountId,
          date: parent.date,
          amount: cents,
          categoryId: c.categoryId || null,
          notes: c.notes || undefined,
          payee: parent.payee || undefined,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (children.length === 0) return;

    const childSum = children.reduce((sum, c) => sum + c.amount, 0);
    if (childSum !== parent.amount) {
      emitOperationFeedback({
        kind: "error",
        message: `Split total must equal ${fmt().formatCents(parent.amount)}`,
        undoable: false,
      });
      return;
    }

    const { promise } = dispatch("split_transaction", { parentId, children });
    void promise
      .then(async () => {
        cancelSplit();
        await props.onReload?.();
      })
      .catch((err) => {
        console.warn("[TransactionTable] split failed", err);
      });
  }

  function handleAddTag(txId: string, tagId: string) {
    const tag = props.tagList.find((item) => item.id === tagId);
    const { promise } = dispatch("add_transaction_tag", { transactionId: txId, tagId });
    if (tag) props.onTagAdd?.(txId, tag);
    void promise.catch((err) => {
      props.onTagRemove?.(txId, tagId);
      console.warn("[TransactionTable] add tag failed", err);
    });
    setShowTagPicker(null);
  }

  function handleRemoveTag(txId: string, tagId: string) {
    const tag = props.txTags[txId]?.find((item) => item.id === tagId);
    const { promise } = dispatch("remove_transaction_tag", { transactionId: txId, tagId });
    props.onTagRemove?.(txId, tagId);
    void promise.catch((err) => {
      if (tag) props.onTagAdd?.(txId, tag);
      console.warn("[TransactionTable] remove tag failed", err);
    });
  }

  function formatCents(cents: number): string {
    return fmt().formatCents(cents);
  }

  return (
    <div>
      <datalist id="tx-payee-list">
        <For each={payeeNames()}>{(name) => <option value={name} />}</For>
      </datalist>

      <div class="transaction-table">
        <div class="tx-table-header" classList={{ "show-account": !!props.showAccount }}>
          <span class="tx-col-cr">Status</span>
          <span class="tx-col-date">Date</span>
          <Show when={props.showAccount}>
            <span class="tx-col-account">Account</span>
          </Show>
          <span class="tx-col-payee">Payee</span>
          <span class="tx-col-category">Category</span>
          <span class="tx-col-tags">Tags</span>
          <span class="tx-col-amount">Amount ({fmt().symbol})</span>
          <Show when={props.showBalance}>
            <span class="tx-col-balance">Balance</span>
          </Show>
          <span class="tx-col-actions" />
        </div>
        <For each={transactionsWithBalance()}>
          {(tx) => {
            const isEditing = (field: TxField) => editingId() === tx.id && editingField() === field;
            const isSplitting = splitParentId() === tx.id;

            return (
              <>
                <div
                  class="tx-row"
                  classList={{
                    focused: tx.id === props.focusId,
                    uncleared: !tx.cleared,
                    reconciled: tx.reconciled,
                    "tx-row-parent": tx.isParent,
                    "tx-row-child": tx.isChild,
                    "show-account": !!props.showAccount,
                  }}
                >
                  <span class="tx-col-cr">
                    <button
                      type="button"
                      class="btn btn-icon btn-xs"
                      classList={{ "btn-ghost": !tx.cleared, "btn-primary": tx.cleared }}
                      style={{ padding: "2px 6px", "font-size": "0.65rem" }}
                      disabled={statusPending().has(tx.id)}
                      onClick={() => void toggleCleared(tx)}
                      aria-label={tx.cleared ? "Mark uncleared" : "Mark cleared"}
                      aria-pressed={tx.cleared}
                      title={
                        tx.cleared
                          ? "Cleared by the bank · click to mark pending"
                          : "Pending at the bank · click when it clears"
                      }
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      class="btn btn-icon btn-xs"
                      classList={{
                        "btn-ghost": !tx.reconciled,
                        "btn-reconciled": tx.reconciled,
                      }}
                      style={{ padding: "2px 6px", "font-size": "0.65rem" }}
                      disabled={statusPending().has(tx.id)}
                      onClick={() => void toggleReconciled(tx)}
                      aria-label={tx.reconciled ? "Undo reconciliation" : "Mark reconciled"}
                      aria-pressed={tx.reconciled}
                      title={
                        tx.reconciled
                          ? "Matched to your statement · click to undo"
                          : "Checked against your statement · click to reconcile"
                      }
                    >
                      R
                    </button>
                  </span>

                  <span class="tx-col-date">
                    {isEditing("date") ? (
                      <input
                        type="date"
                        class="tx-inline-input"
                        value={tx.date}
                        onBlur={(e) => saveEdit(tx, "date", e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(tx, "date", e.currentTarget.value);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        autofocus
                      />
                    ) : (
                      <button
                        type="button"
                        class="tx-inline-trigger"
                        style={tx.transferId ? { cursor: "default" } : undefined}
                        disabled={!!tx.transferId}
                        onClick={() => startEdit(tx.id, "date")}
                        aria-label={`Edit date ${df().formatDate(tx.date)}`}
                      >
                        {df().formatDate(tx.date)}
                      </button>
                    )}
                  </span>

                  <Show when={props.showAccount}>
                    <span class="tx-col-account">
                      <button
                        type="button"
                        class="tx-account-link"
                        onClick={() => navigate(`/accounts/${tx.accountId}`)}
                      >
                        {props.accountNames?.[tx.accountId] ?? "—"}
                      </button>
                    </span>
                  </Show>

                  <span class="tx-col-payee">
                    <Show when={tx.scheduleId}>
                      <button
                        type="button"
                        class="schedule-badge schedule-badge-button"
                        title={`From schedule: ${tx.scheduleName ?? "Unknown"}`}
                        aria-label={`Open schedule ${tx.scheduleName ?? "Unknown"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/schedules?focus=${encodeURIComponent(tx.scheduleId ?? "")}`);
                        }}
                      >
                        ↻
                      </button>
                    </Show>
                    {isEditing("payee") ? (
                      <input
                        type="text"
                        list="tx-payee-list"
                        class="tx-inline-input"
                        value={tx.payee ?? ""}
                        onBlur={(e) => saveEdit(tx, "payee", e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(tx, "payee", e.currentTarget.value);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        autofocus
                      />
                    ) : (
                      <span classList={{ "tx-schedule-linked": !!tx.scheduleId }}>
                        <button
                          type="button"
                          class="tx-inline-trigger"
                          onClick={() => startEdit(tx.id, "payee")}
                          aria-label={`Edit payee ${tx.payee ?? "empty"}`}
                        >
                          {tx.isParent ? <em>Split</em> : (tx.payee ?? "—")}
                        </button>
                      </span>
                    )}
                  </span>

                  <span class="tx-col-category">
                    {isEditing("category") ? (
                      <select
                        class="tx-inline-select"
                        value={tx.categoryId ?? ""}
                        onBlur={(e) => saveEdit(tx, "category", e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(tx, "category", e.currentTarget.value);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        autofocus
                      >
                        <option value="">Uncategorized</option>
                        <For each={props.categories}>
                          {(cat) => (
                            <option value={cat.id}>
                              {cat.groupName ? `${cat.groupName}: ` : ""}
                              {cat.name}
                            </option>
                          )}
                        </For>
                      </select>
                    ) : (
                      <button
                        type="button"
                        class="tx-inline-trigger"
                        classList={{ "tx-split-label": tx.isParent }}
                        style={tx.transferId ? { cursor: "default" } : undefined}
                        disabled={!!tx.transferId}
                        onClick={() => startEdit(tx.id, "category")}
                        aria-label={`Edit category ${tx.categoryName ?? "Uncategorized"}`}
                      >
                        {tx.isParent
                          ? "Split"
                          : tx.transferId
                            ? "Transfer"
                            : (tx.categoryName ?? "Uncategorized")}
                      </button>
                    )}
                  </span>

                  <span class="tx-col-tags">
                    <div
                      style={{
                        display: "flex",
                        "flex-wrap": "wrap",
                        gap: "2px",
                        "align-items": "center",
                      }}
                    >
                      <For each={props.txTags[tx.id] ?? []}>
                        {(tag) => (
                          <button
                            type="button"
                            class="tag-chip-sm"
                            style={{
                              background: tag.color ?? "#4f46e5",
                              color: "#fff",
                              cursor: "pointer",
                            }}
                            onClick={() => handleRemoveTag(tx.id, tag.id)}
                            title={`Remove tag "${tag.name}"`}
                          >
                            {tag.name} ✕
                          </button>
                        )}
                      </For>
                      <button
                        class="btn btn-icon btn-xs btn-ghost"
                        style={{ "font-size": "0.65rem", padding: "1px 4px" }}
                        onClick={() => setShowTagPicker(showTagPicker() === tx.id ? null : tx.id)}
                        title="Add tag"
                      >
                        +
                      </button>
                    </div>
                    <Show when={showTagPicker() === tx.id}>
                      <div class="tag-picker-dropdown" onClick={(e) => e.stopPropagation()}>
                        <For
                          each={props.tagList.filter(
                            (t: TagInfo) =>
                              !(props.txTags[tx.id] ?? []).find((tt) => tt.id === t.id),
                          )}
                        >
                          {(tag: TagInfo) => (
                            <button
                              class="btn btn-ghost btn-xs tag-picker-option"
                              onClick={() => handleAddTag(tx.id, tag.id)}
                            >
                              <span
                                class="tag-dot-sm"
                                style={{ background: tag.color ?? "#4f46e5" }}
                              />
                              {tag.name}
                            </button>
                          )}
                        </For>
                        <Show
                          when={
                            props.tagList.filter(
                              (t: TagInfo) =>
                                !(props.txTags[tx.id] ?? []).find((tt) => tt.id === t.id),
                            ).length === 0
                          }
                        >
                          <span
                            style={{
                              color: "var(--text-muted)",
                              "font-size": "0.75rem",
                              padding: "4px",
                            }}
                          >
                            No more tags
                          </span>
                        </Show>
                      </div>
                    </Show>
                  </span>

                  <span
                    class="tx-col-amount"
                    classList={{
                      positive: (tx.amount ?? 0) > 0,
                      negative: (tx.amount ?? 0) < 0,
                      "tx-amount-parent": tx.isParent,
                    }}
                  >
                    {isEditing("amount") ? (
                      <input
                        type="text"
                        inputmode={fmt().inputMode}
                        class="tx-inline-input"
                        value={fmt().formatCentsInput(tx.amount ?? 0)}
                        onBlur={(e) => saveEdit(tx, "amount", e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(tx, "amount", e.currentTarget.value);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        autofocus
                      />
                    ) : (
                      <button
                        type="button"
                        class={`tx-inline-trigger tx-amount-trigger ${privacyBlur().blurClass()}`}
                        style={tx.transferId ? { cursor: "default" } : undefined}
                        disabled={!!tx.transferId}
                        onClick={() => startEdit(tx.id, "amount")}
                        aria-label={`Edit amount ${formatCents(tx.amount ?? 0)}`}
                      >
                        {formatCents(tx.amount ?? 0)}
                      </button>
                    )}
                  </span>

                  <Show when={props.showBalance}>
                    <span class={`tx-col-balance ${privacyBlur().blurClass()}`}>
                      {formatCents(tx.balance)}
                    </span>
                  </Show>

                  <span class="tx-col-actions">
                    <details class="tx-action-menu">
                      <summary aria-label="Transaction actions">•••</summary>
                      <div class="tx-action-popover">
                        <button
                          type="button"
                          onClick={() => initSplit(tx)}
                          disabled={!!tx.isChild || !!tx.isParent || !!tx.transferId}
                        >
                          Split transaction
                        </button>
                        <button
                          type="button"
                          onClick={() => props.onCreateSchedule?.(tx)}
                          disabled={!!tx.isChild || !!tx.isParent || !!tx.transferId}
                        >
                          Create schedule
                        </button>
                        <button type="button" class="danger" onClick={() => handleDelete(tx)}>
                          Delete · Undo available
                        </button>
                      </div>
                    </details>
                  </span>
                </div>

                <Show when={isSplitting}>
                  <div class="tx-split-form">
                    <div class="tx-split-children">
                      <For each={splitChildren()}>
                        {(child, idx) => (
                          <div class="tx-split-child">
                            <span class="tx-split-child-num">{idx() + 1}.</span>
                            <select
                              class="tx-inline-select"
                              value={child.categoryId}
                              onChange={(e) =>
                                updateSplitChild(child.tempId, "categoryId", e.currentTarget.value)
                              }
                            >
                              <option value="">Category</option>
                              <For each={props.categories}>
                                {(cat) => (
                                  <option value={cat.id}>
                                    {cat.groupName ? `${cat.groupName}: ` : ""}
                                    {cat.name}
                                  </option>
                                )}
                              </For>
                            </select>
                            <input
                              type="text"
                              inputmode={fmt().inputMode}
                              class="tx-inline-input"
                              style={{ width: "120px" }}
                              placeholder="Amount"
                              value={child.amount}
                              onInput={(e) =>
                                updateSplitChild(child.tempId, "amount", e.currentTarget.value)
                              }
                            />
                            <input
                              type="text"
                              class="tx-inline-input"
                              style={{ flex: 1 }}
                              placeholder="Notes"
                              value={child.notes}
                              onInput={(e) =>
                                updateSplitChild(child.tempId, "notes", e.currentTarget.value)
                              }
                            />
                          </div>
                        )}
                      </For>
                    </div>
                    <div class="tx-split-actions">
                      <button class="btn btn-ghost btn-xs" onClick={addSplitChild}>
                        + Add Child
                      </button>
                      <button class="btn btn-primary btn-xs" onClick={saveSplit}>
                        Save Split
                      </button>
                      <button class="btn btn-ghost btn-xs" onClick={cancelSplit}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>
              </>
            );
          }}
        </For>
      </div>
    </div>
  );
}
