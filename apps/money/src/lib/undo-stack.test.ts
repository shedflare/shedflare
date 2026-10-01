import { describe, expect, test, beforeEach, vi } from "vite-plus/test";
import { redoStack, undoStack, push, undo, redo, historyBusy } from "./undo-stack";
import * as Schema from "effect/Schema";

interface MockCommandData {
  transactionId?: string;
  id?: string;
}
const RequestBodySchema = Schema.Struct({ commandType: Schema.String, payload: Schema.Unknown });
let recordedRequestBody: string | null = null;

function mockFetchOk(data: MockCommandData = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      recordedRequestBody = Schema.decodeUnknownSync(Schema.String)(init?.body);
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    }),
  );
}

function mockFetchError(error: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      recordedRequestBody = Schema.decodeUnknownSync(Schema.String)(init?.body);
      return new Response(JSON.stringify({ ok: false, error }), { status: 200 });
    }),
  );
}

function fetchBody() {
  if (!recordedRequestBody) throw new Error("no fetch call recorded");
  return Schema.decodeUnknownSync(RequestBodySchema)(JSON.parse(recordedRequestBody));
}

describe("undo-stack", () => {
  test("recording a payment can undo again after redo creates a different transaction", async () => {
    push(
      "Payment recorded",
      { commandType: "post_schedule_transaction", payload: { scheduleId: "payment" } },
      {
        commandType: "undo_schedule_payment",
        payload: {
          scheduleId: "payment",
          transactionId: "original",
          nextDate: "2026-10-01",
          completed: false,
          recurrenceRules: "monthly",
        },
      },
    );
    mockFetchOk();
    expect(await undo()).toBe(true);
    mockFetchOk({ id: "payment", transactionId: "recreated-payment" });
    expect(await redo()).toBe(true);
    mockFetchOk();
    expect(await undo()).toBe(true);
    expect(fetchBody()).toMatchObject({
      commandType: "undo_schedule_payment",
      payload: {
        scheduleId: "payment",
        transactionId: "recreated-payment",
        nextDate: "2026-10-01",
      },
    });
  });
  test("connection failures preserve undo and redo for retry, including recreated transaction IDs", async () => {
    push(
      "Add expense",
      { commandType: "create_transaction", payload: {} },
      { commandType: "delete_transaction", payload: { id: "original" } },
    );
    const length = undoStack().length;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Connection failed");
      }),
    );
    expect(await undo()).toBe(false);
    expect(undoStack()).toHaveLength(length);
    mockFetchOk();
    expect(await undo()).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Connection failed");
      }),
    );
    expect(await redo()).toBe(false);
    expect(undoStack()).toHaveLength(length - 1);
    mockFetchOk({ id: "recreated" });
    expect(await redo()).toBe(true);
    mockFetchOk();
    expect(await undo()).toBe(true);
    expect(fetchBody()).toEqual({
      commandType: "delete_transaction",
      payload: { id: "recreated" },
    });
  });

  test("blocks overlapping history requests while the first is saving", async () => {
    push(
      "Move money",
      { commandType: "transfer_budget", payload: {} },
      { commandType: "transfer_budget", payload: {} },
    );
    let release: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const saving = undo();
    expect(historyBusy()).toBe(true);
    expect(await redo()).toBe(false);
    expect(await undo()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (!release) throw new Error("History request was not started");
    release(new Response(JSON.stringify({ ok: true, data: {} })));
    expect(await saving).toBe(true);
    expect(historyBusy()).toBe(false);
  });
  beforeEach(() => {
    recordedRequestBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
  });

  test("push appends an entry and clears the redo stack", () => {
    const undoBefore = undoStack().length;
    const redoBefore = redoStack().length;
    push("label", { commandType: "a", payload: { n: 1 } }, { commandType: "b", payload: {} });
    expect(undoStack().length).toBe(undoBefore + 1);
    expect(undoStack().at(-1)?.label).toBe("label");
    // push always clears redo
    expect(redoStack().length).toBeLessThanOrEqual(redoBefore);
  });

  test("undo executes the inverse command and pushes to redo", async () => {
    mockFetchOk({ id: "x" });
    push(
      "create→delete",
      { commandType: "create_x", payload: { a: 1 } },
      {
        commandType: "delete_x",
        payload: { id: "x" },
      },
    );
    const undoBefore = undoStack().length;
    const redoBefore = redoStack().length;
    const ok = await undo();
    expect(ok).toBe(true);
    expect(undoStack().length).toBe(undoBefore - 1);
    expect(redoStack().length).toBe(redoBefore + 1);
    expect(fetchBody().commandType).toBe("delete_x");
  });

  test("undo returns false and restores the entry when the inverse fails", async () => {
    mockFetchError("oops");
    push(
      "label",
      { commandType: "create_x", payload: {} },
      {
        commandType: "delete_x",
        payload: {},
      },
    );
    const undoBefore = undoStack().length;
    const redoBefore = redoStack().length;
    const ok = await undo();
    expect(ok).toBe(false);
    expect(undoStack().length).toBe(undoBefore);
    expect(redoStack().length).toBe(redoBefore);
  });

  test("redo executes the forward command and pushes back to undo", async () => {
    mockFetchOk();
    push(
      "label",
      { commandType: "create_x", payload: { a: 1 } },
      {
        commandType: "delete_x",
        payload: {},
      },
    );
    await undo();
    const undoBefore = undoStack().length;
    const redoBefore = redoStack().length;
    const ok = await redo();
    expect(ok).toBe(true);
    expect(redoStack().length).toBe(redoBefore - 1);
    expect(undoStack().length).toBe(undoBefore + 1);
    expect(fetchBody().commandType).toBe("create_x");
  });

  test("redo returns false and restores the entry when the forward fails", async () => {
    mockFetchError("boom");
    push(
      "label",
      { commandType: "create_x", payload: {} },
      {
        commandType: "delete_x",
        payload: {},
      },
    );
    mockFetchOk();
    await undo();
    // now switch to failing fetch
    mockFetchError("boom");
    const undoBefore = undoStack().length;
    const redoBefore = redoStack().length;
    const ok = await redo();
    expect(ok).toBe(false);
    expect(redoStack().length).toBe(redoBefore);
    expect(undoStack().length).toBe(undoBefore);
  });
});
