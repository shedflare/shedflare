import { createSignal } from "solid-js";
import * as Schema from "effect/Schema";
import { execute, type CommandPayload, type CommandType } from "./api";
import { emitOperationFeedback } from "./operation-feedback";
import { emitMoneyDataChanged } from "./data-events";
import type { CommandData } from "../domain/types";

export interface UndoEntry {
  label: string;
  forward: { commandType: CommandType; payload: CommandPayload };
  inverse: { commandType: CommandType; payload: CommandPayload };
}

const [undoStack, setUndoStack] = createSignal<UndoEntry[]>([]);
const [redoStack, setRedoStack] = createSignal<UndoEntry[]>([]);
const [historyBusy, setHistoryBusy] = createSignal(false);

export { undoStack, redoStack, historyBusy };

function retargetRecreatedEntry(
  entry: UndoEntry,
  resultData: CommandData,
  direction: "undo" | "redo",
): UndoEntry {
  let restoredId: string;
  try {
    restoredId = Schema.decodeUnknownSync(Schema.String)(resultData.id);
  } catch {
    return entry;
  }
  const deletion = direction === "undo" ? entry.forward : entry.inverse;
  const creation = direction === "undo" ? entry.inverse : entry.forward;
  if (
    !deletion.commandType.startsWith("delete_") ||
    !creation.commandType.startsWith("create_") ||
    !(deletion.payload instanceof Object)
  ) {
    return entry;
  }
  return {
    ...entry,
    [direction === "undo" ? "forward" : "inverse"]: {
      ...deletion,
      payload: { ...deletion.payload, id: restoredId },
    },
  };
}

async function replayCommand(command: UndoEntry["forward"]): ReturnType<typeof execute> {
  try {
    return await execute(command.commandType, command.payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}

export function push(label: string, forward: UndoEntry["forward"], inverse: UndoEntry["inverse"]) {
  setUndoStack((prev) => [...prev, { label, forward, inverse }]);
  setRedoStack([]);
}

export async function undo() {
  if (historyBusy()) return false;
  const stack = undoStack();
  if (stack.length === 0) return false;
  const entry = stack[stack.length - 1];
  setHistoryBusy(true);
  setUndoStack((prev) => prev.slice(0, -1));
  setRedoStack((prev) => [...prev, entry]);
  const result = await replayCommand(entry.inverse);
  setHistoryBusy(false);
  if (!result.ok) {
    setUndoStack((prev) => [...prev, entry]);
    setRedoStack((prev) => prev.slice(0, -1));
    emitOperationFeedback({
      kind: "error",
      message: `Undo failed: ${result.error}`,
      undoable: false,
    });
    return false;
  }
  const restoredEntry = retargetRecreatedEntry(entry, result.data, "undo");
  if (restoredEntry !== entry) {
    setRedoStack((prev) => [...prev.slice(0, -1), restoredEntry]);
  }
  emitOperationFeedback({ kind: "success", message: `${entry.label} undone`, undoable: false });
  emitMoneyDataChanged();
  return true;
}

export async function redo() {
  if (historyBusy()) return false;
  const stack = redoStack();
  if (stack.length === 0) return false;
  const entry = stack[stack.length - 1];
  setHistoryBusy(true);
  setRedoStack((prev) => prev.slice(0, -1));
  setUndoStack((prev) => [...prev, entry]);
  const result = await replayCommand(entry.forward);
  setHistoryBusy(false);
  if (!result.ok) {
    setRedoStack((prev) => [...prev, entry]);
    setUndoStack((prev) => prev.slice(0, -1));
    emitOperationFeedback({
      kind: "error",
      message: `Redo failed: ${result.error}`,
      undoable: false,
    });
    return false;
  }
  const restoredEntry = retargetRecreatedEntry(entry, result.data, "redo");
  if (restoredEntry !== entry) setUndoStack((prev) => [...prev.slice(0, -1), restoredEntry]);
  emitOperationFeedback({ kind: "success", message: `${entry.label} redone`, undoable: false });
  emitMoneyDataChanged();
  return true;
}
