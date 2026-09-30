import {
  decodeSyncSnapshot,
  decodeComparisonGroupRow,
  decodeThreadRow,
  ComparisonGroupRow,
  TABLES,
  ThreadRow,
  type ExternalValue,
  type ComparisonGroup,
  type SyncSnapshot,
  type Thread,
} from "#/domain";
import * as Schema from "effect/Schema";
import { applyPartialSnapshot } from "./sync-adapter";

export type ThreadSummaryPage = {
  serverSeq: number;
  threads: Thread[];
  comparisonGroups: ComparisonGroup[];
  nextCursor: string | null;
};

function rowsById<T extends { id: string }>(rows: T[]) {
  const result: Record<string, T> = {};
  for (const row of rows) result[row.id] = row;
  return result;
}

const ThreadSummaryPageSchema = Schema.Struct({
  serverSeq: Schema.Number,
  threads: Schema.Array(ThreadRow),
  comparisonGroups: Schema.Array(ComparisonGroupRow),
  nextCursor: Schema.NullOr(Schema.String),
});

function decodeThreadSummaryPage(value: ExternalValue): ThreadSummaryPage {
  const page = Schema.decodeUnknownSync(ThreadSummaryPageSchema)(value);
  return {
    ...page,
    threads: page.threads.map(decodeThreadRow),
    comparisonGroups: page.comparisonGroups.map(decodeComparisonGroupRow),
  };
}

async function fetchJson(url: URL | string): Promise<ExternalValue> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`History request failed: ${response.status}`);
  }
  return response.json();
}

export async function loadOlderThreads(input: {
  workspaceId?: string | null;
  before?: string | null;
  limit?: number;
}): Promise<ThreadSummaryPage> {
  const url = new URL("/api/sync/history/threads", window.location.origin);
  if (input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId);
  if (input.before) url.searchParams.set("before", input.before);
  if (input.limit) url.searchParams.set("limit", String(input.limit));

  const body = decodeThreadSummaryPage(await fetchJson(url));

  applyPartialSnapshot({
    [TABLES.threads]: rowsById(body.threads),
    [TABLES.comparisonGroups]: rowsById(body.comparisonGroups),
  });
  return body;
}

async function loadSnapshot(url: URL): Promise<SyncSnapshot> {
  const body = await fetchJson(url);
  const snapshot = decodeSyncSnapshot(body);
  if (!snapshot) throw new Error("Invalid history snapshot response");
  applyPartialSnapshot(snapshot.tables);
  return snapshot;
}

export function loadThreadDetail(threadId: string, input: { includeTrace?: boolean } = {}) {
  const url = new URL(
    `/api/sync/history/threads/${encodeURIComponent(threadId)}`,
    window.location.origin,
  );
  url.searchParams.set("includeSearch", "true");
  if (input.includeTrace) url.searchParams.set("includeTrace", "true");
  return loadSnapshot(url);
}

export function loadMessageTrace(messageId: string) {
  const url = new URL(
    `/api/sync/history/messages/${encodeURIComponent(messageId)}/trace`,
    window.location.origin,
  );
  return loadSnapshot(url);
}
