import {
  SYNC_PROTOCOL_VERSION,
  createId,
  decodeSyncServerEnvelope,
  type ExternalValue,
  type JsonObject,
  type SyncClientEnvelope,
  type SyncServerEnvelope,
} from "#/domain";
import { createSignal } from "solid-js";
import * as pendingOps from "./pending-ops";
import { debugLog } from "./client-debug";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Persistent client identity & sync cursor
// ---------------------------------------------------------------------------

const CLIENT_ID_KEY = "shedflare.clientId";
const LAST_SERVER_SEQ_KEY = "shedflare.lastServerSeq";

function rawByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

const DebugFrameSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  eventType: Schema.optional(Schema.String),
  serverSeq: Schema.optional(Schema.Number),
  eventId: Schema.optional(Schema.String),
  opId: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.Struct({
      messageId: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      delta: Schema.optional(Schema.String),
    }),
  ),
});

function decodeDebugFrame(value: ExternalValue) {
  try {
    return Schema.decodeUnknownSync(DebugFrameSchema)(value);
  } catch {
    return null;
  }
}

function frameDebugSummary(value: ExternalValue) {
  const frame = decodeDebugFrame(value);
  if (!frame) return { envelopeType: "invalid" };
  return {
    envelopeType: frame.type ?? null,
    eventType: frame.eventType ?? null,
    serverSeq: frame.serverSeq ?? null,
    eventId: frame.eventId ?? null,
    opId: frame.opId ?? null,
    messageId: frame.payload?.messageId ?? null,
    textLength: frame.payload?.text?.length ?? null,
    deltaLength: frame.payload?.delta?.length ?? null,
  };
}

function shouldLogFrame(value: ExternalValue) {
  const frame = decodeDebugFrame(value);
  if (!frame || frame.type !== "event" || frame.eventType !== "message_delta") return true;
  return frame.serverSeq !== undefined && frame.serverSeq % 25 === 0;
}

function readStoredString(key: string, fallback: string) {
  if (!globalThis.localStorage) return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return Schema.decodeUnknownSync(Schema.String)(JSON.parse(raw));
  } catch {
    console.warn("[ws] failed to parse localStorage value for", key);
    return fallback;
  }
}

function readStoredNumber(key: string, fallback: number) {
  if (!globalThis.localStorage) return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return Schema.decodeUnknownSync(Schema.Number)(JSON.parse(raw));
  } catch {
    console.warn("[ws] failed to parse localStorage value for", key);
    return fallback;
  }
}

const clientId = readStoredString(CLIENT_ID_KEY, createId("client"));
if (globalThis.localStorage) {
  localStorage.setItem(CLIENT_ID_KEY, JSON.stringify(clientId));
}

let lastServerSeq = readStoredNumber(LAST_SERVER_SEQ_KEY, 0);

export function getLastServerSeq() {
  return lastServerSeq;
}

export function setLastServerSeq(seq: number) {
  lastServerSeq = seq;
  if (globalThis.localStorage) {
    localStorage.setItem(LAST_SERVER_SEQ_KEY, JSON.stringify(seq));
  }
}

// ---------------------------------------------------------------------------
// Envelope callback — set by sync-adapter
// ---------------------------------------------------------------------------

let onEnvelopes: ((envelopes: SyncServerEnvelope[]) => void) | null = null;

export function setOnEnvelopes(fn: (envelopes: SyncServerEnvelope[]) => void) {
  onEnvelopes = fn;
}

// ---------------------------------------------------------------------------
// Envelope batching (RAF)
// ---------------------------------------------------------------------------

let incomingQueue: SyncServerEnvelope[] = [];
let flushScheduled = false;

function enqueueEnvelope(envelope: SyncServerEnvelope) {
  incomingQueue.push(envelope);
  if (flushScheduled) return;
  flushScheduled = true;

  if (globalThis.window) {
    window.requestAnimationFrame(flush);
    return;
  }
  queueMicrotask(flush);
}

function flush() {
  flushScheduled = false;
  if (incomingQueue.length === 0) return;
  const batch = incomingQueue.splice(0);
  onEnvelopes?.(batch);

  // If more envelopes arrived during processing, schedule again
  if (incomingQueue.length > 0 && !flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flush);
  }
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;
let started = false;

const [isConnected, setIsConnected] = createSignal(false);
export { isConnected };

function syncLog(message: string, details?: JsonObject) {
  debugLog("ws", message, details);
}

function send(message: SyncClientEnvelope) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function connect() {
  if (!globalThis.window) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  syncLog("connect", { clientId, lastServerSeq });
  const ws = new WebSocket(`${protocol}//${location.host}/api/sync/ws`);
  socket = ws;

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    setIsConnected(true);
    syncLog("open", { pendingOps: pendingOps.unackedOpIds().length });
    send({
      type: "hello",
      clientId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      lastServerSeq,
      unackedOpIds: pendingOps.unackedOpIds(),
    });
  });

  ws.addEventListener("message", ({ data }) => {
    const raw = String(data);
    let parsed: ExternalValue;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn("[ws] malformed sync frame", {
        rawBytes: rawByteLength(raw),
        preview: raw.slice(0, 300),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (shouldLogFrame(parsed)) {
      debugLog("ws", "frame_received", {
        ...frameDebugSummary(parsed),
        rawBytes: rawByteLength(raw),
        lastServerSeq,
      });
    }

    try {
      const envelope = decodeSyncServerEnvelope(parsed);
      if (envelope) {
        enqueueEnvelope(envelope);
        return;
      }
      console.warn("[ws] sync frame decode returned null", {
        ...frameDebugSummary(parsed),
        rawBytes: rawByteLength(raw),
      });
    } catch (error) {
      console.warn("[ws] sync frame decode failed", {
        ...frameDebugSummary(parsed),
        rawBytes: rawByteLength(raw),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ws.addEventListener("close", (event) => {
    const details = {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      lastServerSeq,
      queuedFrames: incomingQueue.length,
      pendingOps: pendingOps.unackedOpIds(),
    } satisfies JsonObject;
    syncLog("close", details);
    if (!event.wasClean && event.code !== 1000 && event.code !== 1001) {
      console.warn("[ws] unexpected close", details);
    }
    setIsConnected(false);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    syncLog("error");
    setIsConnected(false);
  });
}

function scheduleReconnect() {
  if (!globalThis.window) return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt++);
  reconnectTimer = window.setTimeout(() => {
    connect();
  }, delay);
}

/** Called once from UI onMount. */
export function start() {
  if (started || !globalThis.window) return;
  started = true;
  pendingOps.setSendFn(send);
  connect();
}
