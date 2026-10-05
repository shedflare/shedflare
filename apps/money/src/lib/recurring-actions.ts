import { dispatch } from "./pending-ops";
import { emitMoneyDataChanged } from "./data-events";
import { formatCalendarDate } from "../domain/types";
import type { RecurringPayment } from "./recurring-view";

export type PaymentAction = "record" | "skip" | "pause" | "archive";

/** Runs a payment action with its undo inverse and refreshes every open view on success. */
export async function runPaymentAction(original: RecurringPayment, kind: PaymentAction) {
  if (kind === "record") {
    await dispatch(
      "post_schedule_transaction",
      { scheduleId: original.id, date: formatCalendarDate(new Date()) },
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
}

/** Recording needs an open account and a fixed amount; otherwise the details must be completed. */
export function canRecordPayment(
  payment: RecurringPayment,
  accounts: readonly { id: string; closed: boolean }[],
): boolean {
  const account = accounts.find((row) => row.id === payment.accountId);
  return !!account && !account.closed && payment.amount !== null;
}
