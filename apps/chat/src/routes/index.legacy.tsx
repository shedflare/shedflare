import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  lazy,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  Suspense,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useLiveQuery } from "@tanstack/solid-db";
import { clearAuthHint, readAuthHint } from "@shedflare/auth-client/client";
import {
  DEFAULT_SEARCHES_PER_TURN,
  SEARCHES_PER_TURN_OPTIONS,
  clampSearchesPerTurn,
  compareThreadRecency,
  compareWorkspaceRecency,
  createId,
  nowIso,
  ReasoningLevel as ReasoningLevelSchema,
  resolveThreadMessagePath,
  type ExternalValue,
  type JsonObject,
} from "#/domain";
import type {
  AccountSettings,
  Attachment,
  ExtractRun,
  Message,
  MessagePart,
  ReasoningLevel,
  SearchRun,
  SearchResult,
  Thread,
  TraceRun,
  TraceSpan,
  Workspace,
} from "#/domain";
import type { Citation } from "../components/Markdown";
import type { TraceDrawerTrace } from "../components/TraceDrawerContent";
import { explainAssistantError } from "../lib/assistant-errors";
import { BUILD_INFO } from "../lib/build-info";
import { ensureThemeFont } from "../lib/theme-fonts";
import { isAllowedFile, isImageMime, uploadFile } from "../lib/upload";
import {
  workspaces as workspacesCollection,
  accountSettings as accountSettingsCollection,
  threads as threadsCollection,
  messages as messagesCollection,
  messageParts as messagePartsCollection,
  attachments as attachmentsCollection,
  searchRuns as searchRunsCollection,
  searchResults as searchResultsCollection,
  extractRuns as extractRunsCollection,
  traceRuns as traceRunsCollection,
  traceSpans as traceSpansCollection,
  comparisonGroups as comparisonGroupsCollection,
} from "../lib/collections";
import {
  createWorkspaceAction,
  archiveThreadAction,
  deleteThreadAction,
  forkThreadAction,
  archiveWorkspaceAction,
  updateThreadAction,
  updateWorkspaceAction,
  updateAccountSettingsAction,
  cancelAssistantTurnAction,
  deleteAttachmentAction,
  editUserMessageAction,
  retryMessageAction,
  sendMessageAction,
  createComparisonAction,
  resetAllData,
} from "../lib/actions";
import {
  activeWorkspaceId,
  setActiveWorkspaceId,
  activeThreadId,
  setActiveThreadId,
  setActiveThreadIdForWorkspace,
  ensureActiveSelection,
} from "../lib/ui-state";
import {
  activateWorkspaceDraftView,
  activateWorkspaceThreadView,
  consumePendingDraftAttachmentCleanup,
  ensureWorkspaceDraft,
  finalizeWorkspaceDraft,
  getWorkspaceConversationView,
  getWorkspaceDraft,
  pendingDraftAttachmentCleanupTick,
  removeWorkspaceDraftAttachment,
  updateWorkspaceDraft,
} from "../lib/draft-state";
import { start as startConnection, isConnected } from "../lib/ws-connection";
import { init as initSyncAdapter } from "../lib/sync-adapter";
import { authFetch } from "../lib/auth-fetch";
import { loadOlderThreads, loadThreadDetail } from "../lib/history";
import { debugLog } from "../lib/client-debug";
import { selectAutomaticModelId } from "../lib/model-selection";
import {
  readChatNavigationState,
  writeChatNavigationState,
  type ChatNavigationState,
} from "../lib/navigation-state";
import * as Schema from "effect/Schema";

type SessionPayload = {
  user?: {
    email?: string;
  };
};

type BootstrapPayload = {
  session: SessionPayload | null;
  exaApiKeyConfigured: boolean;
};

type ModelsPayload = {
  models: Array<{
    id: string;
    name: string;
    attachment: boolean;
    reasoning: boolean;
    toolCall: boolean;
    interleaved: {
      field: string | null;
    } | null;
    family: string;
    context: number | null;
    output: number | null;
  }>;
};

const SessionPayloadSchema = Schema.Struct({
  user: Schema.optional(Schema.Struct({ email: Schema.optional(Schema.String) })),
});
const BootstrapPayloadSchema = Schema.Struct({
  session: Schema.NullOr(SessionPayloadSchema),
  exaApiKeyConfigured: Schema.Boolean,
});
const ModelPayloadSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  toolCall: Schema.Boolean,
  interleaved: Schema.NullOr(Schema.Struct({ field: Schema.NullOr(Schema.String) })),
  family: Schema.String,
  context: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.Number),
});
const ModelsPayloadSchema = Schema.Struct({ models: Schema.Array(ModelPayloadSchema) });

function decodeBootstrapPayload(value: ExternalValue): BootstrapPayload {
  return Schema.decodeUnknownSync(BootstrapPayloadSchema)(value);
}

function decodeModelsPayload(value: ExternalValue): ModelsPayload {
  const payload = Schema.decodeUnknownSync(ModelsPayloadSchema)(value);
  return {
    models: payload.models.map((model) => ({
      ...model,
      interleaved: model.interleaved ? { ...model.interleaved } : null,
    })),
  };
}

type Theme = "night";
type AssistantActivity = {
  /**
   * Which tool produced this activity. Missing on older parts (pre-extract
   * wiring) or on non-tool activities like "Response failed"; we treat
   * missing-with-a-step as `search` for back-compat, and missing-without-a-
   * step as a generic activity.
   */
  tool: "search" | "extract" | null;
  label: string;
  state: "active" | "completed" | "failed";
  step: number | null;
  query: string | null;
  detail: string | null;
};

type ParsedTraceSpan = TraceSpan & {
  attrs: JsonObject;
  events: JsonObject[];
  children: ParsedTraceSpan[];
};

type TraceTreeView = {
  run: TraceRun;
  spans: ParsedTraceSpan[];
  attrs: JsonObject;
  copyText: string;
};

type ThreadHistoryState = {
  cursor: string | null;
  checked: boolean;
  loading: boolean;
  error: string | null;
};

type ThreadDetailLoadState = {
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

const Markdown = lazy(() => import("../components/Markdown"));
const SettingsPage = lazy(() => import("../components/SettingsPage"));
const MessageAttachments = lazy(() => import("../components/MessageAttachments"));
const TraceDrawerContent = lazy(() => import("../components/TraceDrawerContent"));

const REASONING_OPTIONS: Array<{ value: ReasoningLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function getDateGroup(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000);

  if (date >= todayStart) return "Today";
  if (date >= yesterdayStart) return "Yesterday";
  if (date >= weekStart) return "Last 7 Days";
  return "Older";
}

function groupThreadsByDate(threads: Thread[]) {
  const order = ["Today", "Yesterday", "Last 7 Days", "Older"];
  const groups: Record<string, Thread[]> = {};
  for (const thread of threads) {
    const label = getDateGroup(thread.lastMessageAt);
    (groups[label] ??= []).push(thread);
  }
  return order
    .filter((label) => groups[label]?.length)
    .map((label) => ({ label, threads: groups[label] }));
}

function formatThreadHistoryCursor(thread: Thread): string {
  return JSON.stringify({ lastMessageAt: thread.lastMessageAt, threadId: thread.id });
}

function isBusyMessageStatus(status: Message["status"] | undefined) {
  return status === "queued" || status === "pending" || status === "streaming";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat().format(tokens);
}

function getTotalTokens(message: {
  promptTokens?: number | null;
  completionTokens?: number | null;
}) {
  const promptTokens = message.promptTokens ?? null;
  const completionTokens = message.completionTokens ?? null;
  if (promptTokens == null && completionTokens == null) return null;
  return (promptTokens ?? 0) + (completionTokens ?? 0);
}

function parseThinkingTokens(part: { kind?: string; text?: string; json?: string | null }) {
  if (part.kind !== "thinking_tokens") return null;

  const fromText = part.text?.trim() ? Number(part.text.trim()) : NaN;
  if (Number.isFinite(fromText) && fromText > 0) return Math.round(fromText);

  if (!part.json?.trim()) return null;
  try {
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({ tokens: Schema.optional(Schema.Union([Schema.Number, Schema.String])) }),
    )(JSON.parse(part.json));
    const tokens = Schema.is(Schema.Number)(parsed.tokens)
      ? parsed.tokens
      : parsed.tokens?.trim()
        ? Number(parsed.tokens)
        : NaN;
    if (Number.isFinite(tokens) && tokens > 0) return Math.round(tokens);
  } catch {
    return null;
  }

  return null;
}

function parseAssistantActivity(part: { kind?: string; text?: string; json?: string | null }) {
  if (part.kind !== "activity") return null;

  const fallbackLabel = part.text?.trim() ?? "";
  if (!part.json?.trim()) {
    return fallbackLabel
      ? {
          tool: null,
          label: fallbackLabel,
          state: "active" as const,
          step: null,
          query: null,
          detail: null,
        }
      : null;
  }

  try {
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({
        tool: Schema.optional(Schema.String),
        label: Schema.optional(Schema.String),
        state: Schema.optional(Schema.String),
        step: Schema.optional(Schema.Number),
        query: Schema.optional(Schema.String),
        detail: Schema.optional(Schema.String),
      }),
    )(JSON.parse(part.json));
    const label = parsed.label?.trim() || fallbackLabel;
    if (!label) return null;

    // Back-compat for activities emitted before the tool discriminator
    // landed: a stepped activity with no `tool` field must have been search
    // (extract wasn't wired then). An unstepped activity with no tool field
    // is a top-level marker ("Response failed", budget reached).
    const rawTool = parsed.tool;
    const step = parsed.step ?? null;
    const tool: AssistantActivity["tool"] =
      rawTool === "search" || rawTool === "extract" ? rawTool : step != null ? "search" : null;

    return {
      tool,
      label,
      state: parsed.state === "completed" || parsed.state === "failed" ? parsed.state : "active",
      step,
      query: parsed.query?.trim() || null,
      detail: parsed.detail?.trim() || null,
    } satisfies AssistantActivity;
  } catch {
    return fallbackLabel
      ? {
          tool: null,
          label: fallbackLabel,
          state: "active" as const,
          step: null,
          query: null,
          detail: null,
        }
      : null;
  }
}

function parseTraceJson(value: string | null | undefined) {
  if (!value?.trim()) return {};
  try {
    const parsed = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Any))(
      JSON.parse(value),
    );
    // SAFETY: JSON.parse produces JSON values and the schema verifies the object container.
    return parsed as JsonObject;
  } catch {
    return {};
  }
}

function parseTraceEvents(value: string | null | undefined) {
  if (!value?.trim()) return [];
  try {
    const parsed = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Any)))(
      JSON.parse(value),
    );
    // SAFETY: JSON.parse produces JSON values and the schema verifies every object container.
    return [...parsed] as JsonObject[];
  } catch {
    return [];
  }
}

function formatTraceStatus(status: string) {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Running";
  }
}

function isTerminalTraceStatus(
  status: string | undefined,
): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function shortTraceId(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 14)}…`;
}

function buildTraceTree(spans: TraceSpan[], parentSpanId: string | null = null): ParsedTraceSpan[] {
  return spans
    .filter((span) => (span.parentSpanId ?? null) === parentSpanId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((span) => ({
      ...span,
      attrs: parseTraceJson(span.attrsJson),
      events: parseTraceEvents(span.eventsJson),
      children: buildTraceTree(spans, span.id),
    }));
}

type SerializedTraceSpan = {
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  attrs: JsonObject;
  events: JsonObject[];
  children: SerializedTraceSpan[];
};

function serializeTraceSpan(span: ParsedTraceSpan): SerializedTraceSpan {
  return {
    name: span.name,
    kind: span.kind,
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs: span.durationMs,
    errorCode: span.errorCode,
    errorMessage: span.errorMessage,
    attrs: span.attrs,
    events: span.events,
    children: span.children.map(serializeTraceSpan),
  };
}

function buildTraceCopyText(trace: {
  run: TraceRun;
  spans: ParsedTraceSpan[];
  attrs: JsonObject;
}): string {
  return JSON.stringify(
    {
      run: {
        traceId: trace.run.traceId,
        status: trace.run.status,
        modelId: trace.run.modelId,
        startedAt: trace.run.startedAt,
        endedAt: trace.run.endedAt,
        durationMs: trace.run.durationMs,
        errorCode: trace.run.errorCode,
        errorMessage: trace.run.errorMessage,
        attrs: trace.attrs,
      },
      spans: trace.spans.map(serializeTraceSpan),
    },
    null,
    2,
  );
}

function getInitialTheme(): Theme {
  if (globalThis.localStorage) {
    const saved = localStorage.getItem("shedflare-theme");
    if (saved === "night") return saved;
  }
  return "night";
}

function getInitialExpandReasoning(): boolean {
  if (globalThis.localStorage) {
    return localStorage.getItem("shedflare-expand-reasoning") === "1";
  }
  return false;
}

const fetchBootstrap = async () => {
  const response = await fetch("/api/bootstrap");
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || "Failed to load app bootstrap");
  }
  const payload = decodeBootstrapPayload(await response.json());
  const url = new URL(window.location.href);
  if (!payload.session) {
    // Probe contradicts the hint: drop it so it can't paint a stale shell.
    clearAuthHint();
    if (url.searchParams.get("error") !== "no_session") {
      window.location.replace("/api/auth/login?auto=1");
    }
  }
  return payload;
};

const fetchModels = async (hasSession: boolean) => {
  if (!hasSession) return null;
  const response = await authFetch("/api/models");
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || "Failed to load models");
  }
  return decodeModelsPayload(await response.json());
};

function MarkdownFallback(props: { text: string }) {
  return (
    <div class="md-content">
      <p style={{ "white-space": "pre-wrap" }}>{props.text}</p>
    </div>
  );
}

function LazyMarkdownBlock(props: { text: string; streaming?: boolean; citations?: Citation[] }) {
  return (
    <Suspense fallback={<MarkdownFallback text={props.text} />}>
      <Markdown text={props.text} streaming={props.streaming} citations={props.citations} />
    </Suspense>
  );
}

export default function Home() {
  const [bootstrap] = createResource(fetchBootstrap);
  // Seed session from the auth hint while bootstrap is in flight so a
  // known-signed-in user paints the chat shell immediately instead of the
  // "Checking session…" loader. Once bootstrap resolves it always wins.
  const hintEmail = readAuthHint();
  const session = createMemo(() =>
    bootstrap.loading && hintEmail
      ? { user: { email: hintEmail } }
      : (bootstrap()?.session ?? null),
  );
  const exaApiKeyConfigured = createMemo(() => bootstrap()?.exaApiKeyConfigured ?? false);
  const [modelsResource] = createResource(() => Boolean(session()), fetchModels);
  const models = createMemo(() => modelsResource() ?? null);

  let syncStarted = false;
  createEffect(() => {
    if (!session() || syncStarted) return;
    syncStarted = true;
    void initSyncAdapter().then(() => startConnection());
  });

  // Reactive collection data via TanStack DB live queries
  const allWorkspaces = useLiveQuery(() => workspacesCollection);
  const allAccountSettings = useLiveQuery(() => accountSettingsCollection);
  const allThreads = useLiveQuery(() => threadsCollection);
  const allMessages = useLiveQuery(() => messagesCollection);
  const allMessageParts = useLiveQuery(() => messagePartsCollection);
  const allAttachments = useLiveQuery(() => attachmentsCollection);
  const allSearchRuns = useLiveQuery(() => searchRunsCollection);
  const allSearchResults = useLiveQuery(() => searchResultsCollection);
  const allExtractRuns = useLiveQuery(() => extractRunsCollection);
  const allTraceRuns = useLiveQuery(() => traceRunsCollection);
  const allTraceSpans = useLiveQuery(() => traceSpansCollection);
  const allComparisonGroups = useLiveQuery(() => comparisonGroupsCollection);
  const [theme] = createSignal<Theme>(getInitialTheme());
  const [expandReasoningByDefault, setExpandReasoningByDefault] = createSignal<boolean>(
    getInitialExpandReasoning(),
  );
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [threadFilter, setThreadFilter] = createSignal("");
  const [showTraces, setShowTraces] = createSignal(false);
  const [headerVisible, setHeaderVisible] = createSignal(true);
  const [collapsedProgressByMessage, setCollapsedProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [didAutoCollapseProgressByMessage, setDidAutoCollapseProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [collapsedTraceByMessage, setCollapsedTraceByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [threadHistoryByWorkspace, setThreadHistoryByWorkspace] = createStore<
    Record<string, ThreadHistoryState>
  >({});
  const [threadDetailById, setThreadDetailById] = createStore<
    Record<string, ThreadDetailLoadState>
  >({});
  /**
   * Per-chip collapse state for the interleaved-layout message parts
   * (search chips, thinking chips). Keys are `${messageId}:${chipId}`.
   * Chips default to collapsed; users can click to expand details like
   * search results.
   */
  const [collapsedChipByKey, setCollapsedChipByKey] = createStore<Record<string, boolean>>({});
  const [composer, setComposer] = createStore<{
    text: string;
    modelId: string;
    reasoningLevel: ReasoningLevel;
    search: boolean;
    searchLimit: number;
    sending: boolean;
    attachments: Array<{
      localId: string;
      attachmentId: string | null;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      status: "uploading" | "ready" | "failed";
      previewUrl?: string;
    }>;
  }>({
    text: "",
    modelId: "",
    reasoningLevel: "off",
    search: false,
    searchLimit: DEFAULT_SEARCHES_PER_TURN,
    sending: false,
    attachments: [],
  });

  // Comparison mode state
  const [comparisonMode, setComparisonMode] = createSignal(false);
  const [comparisonModelIds, setComparisonModelIds] = createSignal<string[]>([]);

  const toggleComparisonModel = (modelId: string) => {
    setComparisonModelIds((prev) => {
      if (prev.includes(modelId)) return prev.filter((id) => id !== modelId);
      if (prev.length >= 3) return prev;
      return [...prev, modelId];
    });
  };

  // Active comparison tab (for mobile view)
  const [activeComparisonTab, setActiveComparisonTab] = createSignal(0);

  // Inline editing state
  const [editingThreadId, setEditingThreadId] = createSignal<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");
  const [editingUserMessageId, setEditingUserMessageId] = createSignal<string | null>(null);
  const [editingUserMessageText, setEditingUserMessageText] = createSignal("");
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] = createSignal<{
    id: string;
    name: string;
  } | null>(null);

  // Settings state
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [systemPromptDraft, setSystemPromptDraft] = createSignal("");

  // biome-ignore lint: assigned via ref attribute
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref
  let timelineRef: HTMLElement | undefined;
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref attribute
  let streamingReasoningTextRef: HTMLDivElement | undefined;
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref attribute
  let fileInputRef: HTMLInputElement | undefined;
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref attribute
  let composerInputRef: HTMLTextAreaElement | undefined;

  // Drag-and-drop state
  const [isDragging, setIsDragging] = createSignal(false);
  let dragCounter = 0;
  const removedUploadLocalIds = new Set<string>();
  const pendingUploads = new Map<string, Promise<unknown>>();

  const workspaces = createMemo(() =>
    allWorkspaces()
      .filter((workspace) => !workspace.archivedAt)
      .sort(compareWorkspaceRecency),
  );
  const allWorkspacesNoFilter = createMemo(() =>
    [...allWorkspaces()].sort(compareWorkspaceRecency),
  );
  const workspaceNameById = createMemo(() => {
    const map: Record<string, string> = {};
    for (const ws of allWorkspacesNoFilter()) {
      map[ws.id] = ws.name;
    }
    return map;
  });
  const archivedThreads = createMemo(() =>
    allThreads()
      .filter((thread): thread is Thread & { archivedAt: string } => Boolean(thread.archivedAt))
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        workspaceName: workspaceNameById()[thread.workspaceId] ?? "Unknown",
        archivedAt: thread.archivedAt,
      }))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)),
  );

  const activeWorkspace = createMemo(
    () => workspaces().find((workspace) => workspace.id === activeWorkspaceId()) ?? workspaces()[0],
  );
  const accountSettings = createMemo(
    () => allAccountSettings().find((row) => row.id === "default") ?? null,
  );
  const effectiveExpandReasoningByDefault = createMemo(
    () => accountSettings()?.expandReasoningByDefault ?? expandReasoningByDefault(),
  );
  const effectiveShowTraces = createMemo(() => accountSettings()?.showTraces ?? showTraces());
  const effectivePreferFreeSearch = createMemo(() => activeWorkspace()?.preferFreeSearch ?? false);
  const threads = createMemo(() =>
    allThreads()
      .filter((thread) => thread.workspaceId === activeWorkspace()?.id && !thread.archivedAt)
      .sort(compareThreadRecency),
  );
  const filteredThreads = createMemo(() => {
    const query = threadFilter().trim().toLowerCase();
    if (!query) return threads();
    return threads().filter((thread) => thread.title.toLowerCase().includes(query));
  });
  const activeThread = createMemo(
    () => threads().find((thread) => thread.id === activeThreadId()) ?? threads()[0],
  );
  const currentThreadHistoryState = createMemo<ThreadHistoryState>(() => {
    const workspaceId = activeWorkspace()?.id;
    return workspaceId && threadHistoryByWorkspace[workspaceId]
      ? threadHistoryByWorkspace[workspaceId]
      : { cursor: null, checked: false, loading: false, error: null };
  });
  const hasThreadHistoryButton = createMemo(
    () =>
      !threadFilter().trim() &&
      threads().length > 0 &&
      (!currentThreadHistoryState().checked || Boolean(currentThreadHistoryState().cursor)),
  );
  const activeDraft = createMemo(() => {
    const workspace = activeWorkspace();
    if (!workspace) return null;
    return getWorkspaceDraft(workspace.id);
  });
  const isDraftViewActive = createMemo(() => {
    const workspace = activeWorkspace();
    if (!workspace) return false;
    return getWorkspaceConversationView(workspace.id) === "draft" && Boolean(activeDraft());
  });
  const selectedConversationThread = createMemo(
    () => (isDraftViewActive() ? activeDraft()?.thread : activeThread()) ?? null,
  );
  const latestConversationMessageForThread = (thread: Thread | undefined) => {
    if (!thread) return null;
    return (
      resolveThreadMessagePath(
        allMessages().filter((message) => message.threadId === thread.id),
        thread.headMessageId ?? null,
      ).at(-1) ?? null
    );
  };

  const [navigationReady, setNavigationReady] = createSignal(false);
  const [navigationRevision, setNavigationRevision] = createSignal(0);
  let initialNavigationStarted = false;
  let navigationAttempt = 0;

  const applyChatNavigation = async (state: ChatNavigationState) => {
    const attempt = ++navigationAttempt;
    let workspace = state.workspaceId
      ? workspaces().find((candidate) => candidate.id === state.workspaceId)
      : undefined;
    let thread = state.threadId
      ? allThreads().find((candidate) => candidate.id === state.threadId)
      : undefined;

    // The initial snapshot contains recent thread summaries. A URL is allowed
    // to point at an older thread, so hydrate that detail before choosing the
    // fallback thread or rewriting the URL.
    if (state.threadId && !thread) {
      try {
        await loadThreadDetail(state.threadId);
      } catch {
        // An invalid/deleted URL selection falls back to the normal persisted
        // selection below and is corrected by the URL sync effect.
      }
      if (attempt !== navigationAttempt) return;
      thread = allThreads().find((candidate) => candidate.id === state.threadId);
    }

    if (thread) {
      workspace =
        workspaces().find((candidate) => candidate.id === thread.workspaceId) ?? workspace;
    }

    if (workspace) {
      setActiveWorkspaceId(workspace.id);
      if (thread?.workspaceId === workspace.id) {
        setActiveThreadIdForWorkspace(workspace.id, thread.id);
      }

      if (state.view === "draft" && getWorkspaceDraft(workspace.id)) {
        activateWorkspaceDraftView(workspace.id);
      } else {
        activateWorkspaceThreadView(workspace.id);
      }
    }

    ensureActiveSelection([...allWorkspaces()], [...allThreads()]);
  };

  // The URL is the shareable selection when present. Local storage remains the
  // fallback for the bare homepage and for workspaces without a URL yet.
  createEffect(() => {
    if (initialNavigationStarted || workspaces().length === 0) return;
    initialNavigationStarted = true;
    void applyChatNavigation(readChatNavigationState()).finally(() => {
      setNavigationReady(true);
    });
  });

  const handleNavigationPopState = () => setNavigationRevision((value) => value + 1);
  window.addEventListener("popstate", handleNavigationPopState);
  onCleanup(() => window.removeEventListener("popstate", handleNavigationPopState));

  createEffect(() => {
    const revision = navigationRevision();
    if (!navigationReady() || revision === 0) return;
    void applyChatNavigation(readChatNavigationState());
  });

  createEffect(() => {
    if (!navigationReady()) return;
    const workspace = activeWorkspace();
    if (!workspace) return;
    const draftView = isDraftViewActive();
    writeChatNavigationState({
      workspaceId: workspace.id,
      threadId: draftView ? null : (activeThread()?.id ?? null),
      view: draftView ? "draft" : "thread",
    });
  });
  const selectedThreadDetailState = createMemo(() => {
    const threadId = selectedConversationThread()?.id;
    return threadId ? threadDetailById[threadId] : null;
  });
  // Check if current thread is a comparison thread
  const isComparisonThread = createMemo(() => {
    const thread = selectedConversationThread();
    return thread?.threadType === "comparison" && thread?.comparisonGroupId;
  });

  // Get comparison group for current thread
  const currentComparisonGroup = createMemo(() => {
    const thread = selectedConversationThread();
    if (!thread?.comparisonGroupId) return null;
    return allComparisonGroups().find((group) => group.id === thread.comparisonGroupId) ?? null;
  });

  // Get sibling threads in the same comparison group
  const comparisonSiblingThreads = createMemo(() => {
    const group = currentComparisonGroup();
    if (!group) return [];
    const threadIds: string[] = (() => {
      try {
        return [
          ...Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(group.threadIds)),
        ];
      } catch {
        return [];
      }
    })();
    return threadIds
      .map((id) => allThreads().find((thread) => thread.id === id))
      .filter((thread): thread is Thread => !!thread && !thread.archivedAt);
  });
  const composerText = () => (isDraftViewActive() ? (activeDraft()?.text ?? "") : composer.text);
  const composerAttachments = () =>
    isDraftViewActive() ? (activeDraft()?.attachments ?? []) : composer.attachments;
  const composerModelId = () =>
    isDraftViewActive() ? (activeDraft()?.modelId ?? "") : composer.modelId;
  const composerReasoningLevel = () =>
    isDraftViewActive() ? (activeDraft()?.reasoningLevel ?? "off") : composer.reasoningLevel;
  const composerSearch = () =>
    isDraftViewActive() ? (activeDraft()?.search ?? false) : composer.search;
  const composerSearchLimit = () =>
    clampSearchesPerTurn(
      isDraftViewActive()
        ? (activeDraft()?.searchLimit ?? DEFAULT_SEARCHES_PER_TURN)
        : composer.searchLimit,
    );
  const setComposerTextValue = (text: string) => {
    const workspace = activeWorkspace();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        text,
        updatedAt: nowIso(),
      }));
      return;
    }
    setComposer("text", text);
  };

  const handleLoadOlderThreads = async () => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const state = currentThreadHistoryState();
    if (state.loading) return;
    const oldestThread = threads().at(-1);
    const before = state.cursor ?? (oldestThread ? formatThreadHistoryCursor(oldestThread) : null);

    setThreadHistoryByWorkspace(workspace.id, {
      cursor: state.cursor,
      checked: state.checked,
      loading: true,
      error: null,
    });
    try {
      const page = await loadOlderThreads({ workspaceId: workspace.id, before, limit: 50 });
      setThreadHistoryByWorkspace(workspace.id, {
        cursor: page.nextCursor,
        checked: true,
        loading: false,
        error: null,
      });
    } catch (error) {
      setThreadHistoryByWorkspace(workspace.id, {
        cursor: state.cursor,
        checked: state.checked,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // File upload handlers
  const handleFileSelect = async (files: FileList | null) => {
    const thread = selectedConversationThread();
    const workspace = activeWorkspace();
    const draftMode = isDraftViewActive();
    if (!files || !thread || !workspace) return;
    for (const file of Array.from(files)) {
      if (!isAllowedFile(file)) continue;
      const localId = createId("local");
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;

      const draftAttachment = {
        localId,
        attachmentId: null,
        threadId: thread.id,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        status: "uploading" as const,
        previewUrl,
      };
      if (draftMode) {
        updateWorkspaceDraft(workspace.id, (draft) => ({
          ...draft,
          attachments: [...draft.attachments, draftAttachment],
          updatedAt: nowIso(),
        }));
      } else {
        setComposer("attachments", (prev) => [...prev, draftAttachment]);
      }

      const uploadPromise = uploadFile(file, thread.id);
      pendingUploads.set(localId, uploadPromise);
      try {
        const result = await uploadPromise;
        if (removedUploadLocalIds.delete(localId)) {
          deleteAttachmentAction(result.attachment.id);
          continue;
        }
        if (draftMode) {
          updateWorkspaceDraft(workspace.id, (draft) => ({
            ...draft,
            attachments: draft.attachments.map((attachment) =>
              attachment.localId === localId
                ? {
                    ...attachment,
                    attachmentId: result.attachment.id,
                    status: "ready",
                  }
                : attachment,
            ),
            updatedAt: nowIso(),
          }));
        } else {
          setComposer("attachments", (att) => att.localId === localId, {
            attachmentId: result.attachment.id,
            status: "ready",
          });
        }
      } catch (err) {
        if (removedUploadLocalIds.delete(localId)) {
          continue;
        }
        console.error("Upload failed:", err);
        if (draftMode) {
          updateWorkspaceDraft(workspace.id, (draft) => ({
            ...draft,
            attachments: draft.attachments.map((attachment) =>
              attachment.localId === localId
                ? {
                    ...attachment,
                    status: "failed",
                  }
                : attachment,
            ),
            updatedAt: nowIso(),
          }));
        } else {
          setComposer("attachments", (att) => att.localId === localId, "status", "failed");
        }
      } finally {
        pendingUploads.delete(localId);
      }
    }
    if (fileInputRef) fileInputRef.value = "";
  };

  const removeAttachment = (localId: string) => {
    const workspace = activeWorkspace();
    const att = composerAttachments().find((attachment) => attachment.localId === localId);
    if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
    if (att?.attachmentId) {
      deleteAttachmentAction(att.attachmentId);
    } else {
      removedUploadLocalIds.add(localId);
    }
    if (workspace && isDraftViewActive()) {
      removeWorkspaceDraftAttachment(workspace.id, localId);
      return;
    }
    setComposer("attachments", (prev) =>
      prev.filter((attachment) => attachment.localId !== localId),
    );
  };

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragCounter++;
    setIsDragging(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setIsDragging(false);
    }
  };
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    setIsDragging(false);
    void handleFileSelect(e.dataTransfer?.files ?? null);
  };

  const handlePaste = (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void handleFileSelect(files);
    }
  };

  // Smart scroll: track whether user is near the bottom
  const [isNearBottom, setIsNearBottom] = createSignal(true);
  const [showScrollBtn, setShowScrollBtn] = createSignal(false);
  const [activeMinimapMarkerId, setActiveMinimapMarkerId] = createSignal<string | null>(null);
  const [hoveredMinimapMarker, setHoveredMinimapMarker] = createSignal<{
    id: string;
    top: number;
    left: number;
  } | null>(null);

  const SCROLL_THRESHOLD = 80; // px from bottom to consider "at bottom"

  let _isProgrammaticScroll = false;
  let updateActiveMinimapMarker = () => {};
  let hideMinimapCard = (_markerId?: string) => {};
  // updateActiveMinimapMarker does a DOM query per marker — coalesce scroll
  // bursts to one run per frame.
  let minimapMarkerRaf = 0;
  const scheduleActiveMinimapMarkerUpdate = () => {
    if (minimapMarkerRaf) return;
    minimapMarkerRaf = requestAnimationFrame(() => {
      minimapMarkerRaf = 0;
      updateActiveMinimapMarker();
    });
  };

  const [reasoningNearBottom, setReasoningNearBottom] = createSignal(true);

  let lastScrollTop = 0;

  const handleReasoningScroll = (e: Event) => {
    if (!(e.currentTarget instanceof HTMLElement)) return;
    const el = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setReasoningNearBottom(scrollHeight - scrollTop - clientHeight <= 40);
  };

  const handleTimelineScroll = () => {
    if (!timelineRef || _isProgrammaticScroll) return;
    const { scrollTop, scrollHeight, clientHeight } = timelineRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom <= SCROLL_THRESHOLD;
    setIsNearBottom(nearBottom);
    setShowScrollBtn(!nearBottom);
    scheduleActiveMinimapMarkerUpdate();
    hideMinimapCard();

    // Mobile header show/hide on scroll direction
    if (window.innerWidth <= 700) {
      const scrollUp = scrollTop < lastScrollTop;
      const scrollDown = scrollTop > lastScrollTop;
      const notAtTop = scrollTop > 60;

      if (scrollUp && notAtTop) {
        setHeaderVisible(true);
      } else if (scrollDown) {
        setHeaderVisible(false);
      } else if (scrollTop <= 10) {
        setHeaderVisible(true);
      }
      lastScrollTop = scrollTop;
    }
  };

  const scrollToBottom = () => {
    if (!timelineRef) return;
    _isProgrammaticScroll = true;
    timelineRef.scrollTo({ top: timelineRef.scrollHeight, behavior: "smooth" });
    setIsNearBottom(true);
    setShowScrollBtn(false);
    const markers = userMessageMarkers();
    if (markers.length > 0) {
      setActiveMinimapMarkerId(markers[markers.length - 1]!.id);
    }
    requestAnimationFrame(() => {
      _isProgrammaticScroll = false;
    });
  };

  // Apply theme to document
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", theme());
    localStorage.setItem("shedflare-theme", theme());
    ensureThemeFont(theme());
  });

  // Auto-resize composer input
  createEffect(() => {
    composerText();
    const el = composerInputRef;
    if (!el) return;
    requestAnimationFrame(() => {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    });
  });

  // Sync system prompt draft when settings opens or workspace changes
  createEffect(() => {
    if (settingsOpen()) {
      setSystemPromptDraft(activeWorkspace()?.systemPrompt ?? "");
    }
  });

  createEffect(() => {
    const workspace = activeWorkspace();
    const thread = activeThread();
    if (!workspace || !thread || isDraftViewActive()) return;

    // A workspace can have no persisted thread entry yet (for example after
    // switching to a workspace for the first time). Persist the same
    // deterministic fallback that the UI displays so a reload retains it.
    if (activeWorkspaceId() !== workspace.id) {
      setActiveWorkspaceId(workspace.id);
    }
    if (activeThreadId() !== thread.id) {
      setActiveThreadId(thread.id);
    }
  });

  let lastComposerHydrationKey: string | null = null;
  createEffect(() => {
    const workspace = activeWorkspace();
    const thread = activeThread();
    if (!workspace) return;
    if (getWorkspaceConversationView(workspace.id) === "draft" && getWorkspaceDraft(workspace.id)) {
      return;
    }

    const latestMessage = latestConversationMessageForThread(thread);
    const hydrationKey = `${workspace.id}:${thread?.id ?? "none"}:${latestMessage?.id ?? "none"}`;
    // Thread rows also change when the user deliberately changes the picker.
    // Hydrate only when the conversation identity changes so that a local
    // choice is not immediately overwritten by the old terminal message.
    if (hydrationKey === lastComposerHydrationKey) return;
    lastComposerHydrationKey = hydrationKey;

    // The terminal message is the source of truth for the last turn. This
    // prevents an older thread-level default from hiding the model that
    // produced the visible conversation after a reload.
    setComposer("modelId", latestMessage?.modelId ?? thread?.modelId ?? workspace.defaultModelId);
    setComposer(
      "reasoningLevel",
      latestMessage?.reasoningLevel ??
        thread?.reasoningLevel ??
        workspace.defaultReasoningLevel ??
        "off",
    );
    setComposer(
      "search",
      latestMessage?.searchEnabled ?? thread?.searchEnabled ?? workspace.defaultSearchMode,
    );
    setComposer(
      "searchLimit",
      clampSearchesPerTurn(thread?.searchLimit ?? workspace.defaultSearchLimit),
    );
  });

  createEffect(() => {
    const modelList = models()?.models ?? [];
    const workspace = activeWorkspace();
    if (modelList.length === 0) return;

    const selectedId = composerModelId();
    const selectedCatalogModel = modelList.find(
      (model) =>
        model.id === selectedId || model.id.split("/").at(-1) === selectedId.split("/").at(-1),
    );
    const workspaceDefault = workspace?.defaultModelId;
    const workspaceDefaultModel = modelList.find(
      (model) =>
        model.id === workspaceDefault ||
        model.id.split("/").at(-1) === workspaceDefault?.split("/").at(-1),
    );
    const fallbackId = workspaceDefaultModel?.id ?? selectAutomaticModelId(modelList);
    if (!fallbackId) return;

    if (selectedCatalogModel && selectedCatalogModel.id !== selectedId) {
      const nextModelId = selectedCatalogModel.id;
      if (workspace && isDraftViewActive()) {
        updateWorkspaceDraft(workspace.id, (draft) => ({
          ...draft,
          modelId: nextModelId,
          updatedAt: nowIso(),
        }));
      } else {
        setComposer("modelId", nextModelId);
      }
    } else if (!selectedId || selectedId === "auto") {
      if (workspace && isDraftViewActive()) {
        updateWorkspaceDraft(workspace.id, (draft) => ({
          ...draft,
          modelId: fallbackId,
          updatedAt: nowIso(),
        }));
      } else {
        setComposer("modelId", fallbackId);
      }
    }
  });

  const modelFromCatalog = (modelId: string | null | undefined) => {
    if (!modelId) return null;
    const modelList = models()?.models ?? [];
    return (
      modelList.find(
        (model) => model.id === modelId || model.id.split("/").at(-1) === modelId.split("/").at(-1),
      ) ?? null
    );
  };

  const selectedModel = createMemo(() => modelFromCatalog(composerModelId()));
  const modelInterleavedFieldFor = (modelId: string) =>
    modelFromCatalog(modelId)?.interleaved?.field?.trim() || null;
  const selectedModelSupportsReasoning = createMemo(() => Boolean(selectedModel()?.reasoning));
  const selectedModelSupportsAttachments = createMemo(() => Boolean(selectedModel()?.attachment));
  const hasImageAttachments = createMemo(() =>
    composerAttachments().some((a) => a.status !== "failed" && isImageMime(a.mimeType)),
  );
  const imageAttachmentsWarning = createMemo(
    () => hasImageAttachments() && !selectedModelSupportsAttachments(),
  );
  const effectiveComposerReasoningLevel = createMemo<ReasoningLevel>(() =>
    selectedModelSupportsReasoning() ? composerReasoningLevel() : "off",
  );

  createEffect(() => {
    pendingDraftAttachmentCleanupTick();
    for (const cleanup of consumePendingDraftAttachmentCleanup()) {
      if (cleanup.previewUrl) {
        URL.revokeObjectURL(cleanup.previewUrl);
      }
      if (cleanup.attachmentId) {
        deleteAttachmentAction(cleanup.attachmentId);
        continue;
      }
      removedUploadLocalIds.add(cleanup.localId);
    }
  });
  const messageIds = createMemo(
    () =>
      resolveThreadMessagePath(
        allMessages().filter((message) => message.threadId === selectedConversationThread()?.id),
        selectedConversationThread()?.headMessageId ?? null,
      ).map((message) => message.id),
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) },
  );
  const selectedMessageIdSet = createMemo(() => new Set(messageIds()));
  const messagesById = createMemo(() => {
    const byId = new Map<string, Message>();
    for (const message of allMessages()) {
      byId.set(message.id, message);
    }
    return byId;
  });
  const messageById = (messageId: string) => messagesById().get(messageId);
  const selectedThreadHasDetail = createMemo(() => {
    const thread = selectedConversationThread();
    if (!thread) return true;
    if (!thread.headMessageId) return true;
    return allMessages().some((message) => message.threadId === thread.id);
  });

  createEffect(() => {
    if (isDraftViewActive()) return;
    const thread = selectedConversationThread();
    if (!thread) return;
    if (selectedThreadHasDetail()) {
      const current = threadDetailById[thread.id];
      if (!current?.loaded) {
        setThreadDetailById(thread.id, {
          loading: false,
          loaded: true,
          error: null,
        });
      }
      return;
    }

    const current = threadDetailById[thread.id];
    if (current?.loading || current?.loaded) return;
    setThreadDetailById(thread.id, { loading: true, loaded: false, error: null });
    void loadThreadDetail(thread.id)
      .then(() => {
        setThreadDetailById(thread.id, { loading: false, loaded: true, error: null });
      })
      .catch((error) => {
        setThreadDetailById(thread.id, {
          loading: false,
          loaded: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
  const terminalTraceStatusByMessage = createMemo(() => {
    const byMessage = new Map<string, "completed" | "failed" | "cancelled">();
    const startedAtByMessage = new Map<string, string>();
    for (const run of allTraceRuns()) {
      if (!run.messageId || !isTerminalTraceStatus(run.status)) continue;
      const previousStartedAt = startedAtByMessage.get(run.messageId);
      if (previousStartedAt && previousStartedAt > run.startedAt) continue;
      byMessage.set(run.messageId, run.status);
      startedAtByMessage.set(run.messageId, run.startedAt);
    }
    return byMessage;
  });
  const effectiveMessageStatus = (message: Message): Message["status"] => {
    if (message.role !== "assistant" || !isBusyMessageStatus(message.status)) return message.status;
    const traceStatus = terminalTraceStatusByMessage().get(message.id);
    if (!traceStatus) return message.status;
    return traceStatus === "completed" ? "completed" : traceStatus;
  };
  const busyThreadIds = createMemo(
    () => {
      const messagesByThread = new Map<string, Message[]>();
      for (const msg of allMessages()) {
        const list = messagesByThread.get(msg.threadId) ?? [];
        list.push(msg);
        messagesByThread.set(msg.threadId, list);
      }

      const ids = new Set<string>();
      for (const thread of threads()) {
        const path = resolveThreadMessagePath(
          messagesByThread.get(thread.id) ?? [],
          thread.headMessageId ?? null,
        );
        if (path.some((msg) => isBusyMessageStatus(effectiveMessageStatus(msg)))) {
          ids.add(thread.id);
        }
      }
      return ids;
    },
    undefined,
    {
      equals: (a, b) => {
        if (a === b) return true;
        if (a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
      },
    },
  );
  const searchRunsMemo = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const resultsByRun = new Map<string, SearchResult[]>();
    const selectedRunIds = new Set<string>();

    for (const row of allSearchRuns()) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      selectedRunIds.add(row.id);
    }

    for (const row of allSearchResults()) {
      if (!selectedRunIds.has(row.searchRunId)) continue;
      const list = resultsByRun.get(row.searchRunId) ?? [];
      list.push(row);
      resultsByRun.set(row.searchRunId, list);
    }

    const byMessage = new Map<string, Array<SearchRun & { results: SearchResult[] }>>();
    for (const row of allSearchRuns()) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push({
        ...row,
        results: resultsByRun.get(row.id) ?? [],
      });
      byMessage.set(row.messageId, list);
    }

    for (const list of byMessage.values()) {
      list.sort((a, b) => a.step - b.step);
    }
    return byMessage;
  });
  /**
   * Parallel to searchRunsMemo: keys messageId → ExtractRun[] sorted by step.
   * The extract chip reads from this to render "Reading…" vs "Read … (N
   * chars)" states, and to expose final char counts after streaming.
   */
  const extractRunsMemo = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, ExtractRun[]>();
    for (const row of allExtractRuns()) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    for (const list of byMessage.values()) {
      list.sort((a, b) => a.step - b.step);
    }
    return byMessage;
  });
  /** Flat, ordered list of citations per message (matches [1],[2]… numbering the model uses). */
  const citationsForMessage = (messageId: string): Citation[] => {
    const runs = searchRunsMemo().get(messageId);
    if (!runs?.length) return [];
    return runs.flatMap((run) =>
      run.results.map((r) => ({
        url: r.url,
        title: r.title,
        domain: r.domain,
        snippet: r.snippet,
      })),
    );
  };
  const thinkingTokensByMessage = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, { seq: number; tokens: number }>();
    for (const row of allMessageParts()) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      const tokens = parseThinkingTokens(row);
      if (tokens == null) continue;
      const current = byMessage.get(row.messageId);
      if (!current || row.seq > current.seq) {
        byMessage.set(row.messageId, { seq: row.seq, tokens });
      }
    }
    return new Map(
      Array.from(byMessage.entries()).map(([messageId, value]) => [messageId, value.tokens]),
    );
  });
  const assistantActivities = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, Array<AssistantActivity & { seq: number }>>();
    for (const row of allMessageParts()) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      const activity = parseAssistantActivity(row);
      if (!activity) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push({
        ...activity,
        seq: row.seq,
      });
      byMessage.set(row.messageId, list);
    }

    for (const list of byMessage.values()) {
      list.sort((a, b) => a.seq - b.seq);
    }
    return byMessage;
  });
  /** All message parts (any kind) grouped by messageId, sorted by seq. */
  const messagePartsByMessage = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, MessagePart[]>();
    for (const row of allMessageParts()) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    for (const list of byMessage.values()) {
      list.sort((a, b) => a.seq - b.seq);
    }
    return byMessage;
  });
  const messagePartsForMessage = (messageId: string) =>
    messagePartsByMessage().get(messageId) ?? [];
  /**
   * A message uses the new interleaved (T3-style) layout if it has at least
   * one `text` message_part. The server emits an empty `text` part at the
   * start of every new streaming turn as a format marker, so this flips
   * true as soon as streaming begins. Legacy messages (before this
   * refactor) never have text parts and fall through to the grouped-
   * activity layout.
   */
  const isInterleavedMessage = (messageId: string) =>
    messagePartsForMessage(messageId).some((part) => part.kind === "text");

  /**
   * Items that make up the interleaved timeline for an assistant message.
   * Produced by walking `message_parts` in seq order and grouping adjacent
   * text chunks / same-step search activities.
   */
  type TimelineItem =
    | { kind: "markdown"; text: string; streaming: boolean; key: string }
    | {
        kind: "search";
        step: number;
        query: string;
        status: "active" | "completed" | "failed";
        resultCount: number;
        detail: string | null;
        key: string;
      }
    | {
        kind: "extract";
        step: number;
        /** URL the model asked to extract. Falls back to the activity's URL
         *  if the ExtractRun row hasn't landed yet. */
        url: string;
        /** Hostname extracted from `url`, for the compact chip label. */
        host: string;
        status: "active" | "completed" | "failed";
        charCount: number;
        originalLength: number | null;
        truncated: boolean;
        detail: string | null;
        key: string;
      }
    | { kind: "thinking"; tokens: number; key: string }
    | {
        kind: "reasoning";
        /** Concatenated text across consecutive `reasoning` parts. */
        text: string;
        /** True while the model is still streaming reasoning for this
         *  segment (i.e., the segment has not been closed by a
         *  subsequent text/tool part and the message is not finished). */
        streaming: boolean;
        /** Stable key derived from the first part's seq so the DOM
         *  node is preserved across streaming updates. */
        key: string;
      }
    | { kind: "failure"; key: string };

  const markdownTimelineItem = (item: TimelineItem) => (item.kind === "markdown" ? item : null);
  const searchTimelineItem = (item: TimelineItem) => (item.kind === "search" ? item : null);
  const extractTimelineItem = (item: TimelineItem) => (item.kind === "extract" ? item : null);
  const reasoningTimelineItem = (item: TimelineItem) => (item.kind === "reasoning" ? item : null);
  const thinkingTimelineItem = (item: TimelineItem) => (item.kind === "thinking" ? item : null);

  const assistantTimelineByMessage = createMemo(() => {
    const byMessage = new Map<string, TimelineItem[]>();
    const searchRunsByMsg = searchRunsMemo();
    const extractRunsByMsg = extractRunsMemo();

    for (const [messageId, parts] of messagePartsByMessage()) {
      const items: TimelineItem[] = [];
      let pendingText = "";
      let pendingTextSeq = -1;
      /** Accumulator for a run of consecutive `reasoning` parts. We
       *  collapse them into a single collapsible chip so the UI shows
       *  one "Reasoning" pill per segment rather than one per chunk. */
      let pendingReasoning = "";
      let pendingReasoningSeq = -1;
      /** When a message has any real `reasoning` parts, we suppress
       *  the token-count-only `thinking_tokens` summary chip — the
       *  text-bearing Reasoning chip already communicates that the
       *  model thought about the answer. The token count chip remains
       *  for legacy messages (and providers) that don't surface the
       *  underlying reasoning text. */
      const hasReasoningParts = parts.some((part) => part.kind === "reasoning");

      const flushText = (streaming: boolean) => {
        if (!pendingText) return;
        items.push({
          kind: "markdown",
          text: pendingText,
          streaming,
          key: `text:${pendingTextSeq}`,
        });
        pendingText = "";
        pendingTextSeq = -1;
      };

      const flushReasoning = (streaming: boolean) => {
        if (!pendingReasoning) return;
        items.push({
          kind: "reasoning",
          text: pendingReasoning,
          streaming,
          key: `reasoning:${pendingReasoningSeq}`,
        });
        pendingReasoning = "";
        pendingReasoningSeq = -1;
      };

      /** Track the latest activity seen for each search step so we can
       *  collapse (Searching…, Found X results) into a single chip. */
      const renderedSearchSteps = new Set<number>();
      /** Parallel tracker for extract steps — search and extract share the
       *  same step-number space from the model's POV (each tool starts at 1
       *  independently) so we key their chips separately. */
      const renderedExtractSteps = new Set<number>();

      for (const part of parts) {
        if (part.kind === "text") {
          // Text closes any open reasoning segment before it.
          flushReasoning(false);
          if (pendingTextSeq < 0) pendingTextSeq = part.seq;
          pendingText += part.text;
          continue;
        }

        if (part.kind === "reasoning") {
          // Reasoning closes any open text run before it so the
          // reasoning chip renders at the correct seq position.
          flushText(false);
          if (pendingReasoningSeq < 0) pendingReasoningSeq = part.seq;
          pendingReasoning += part.text;
          continue;
        }

        if (part.kind === "activity") {
          const activity = parseAssistantActivity(part);
          if (!activity) continue;

          // Suppress the lifecycle chips in the interleaved layout —
          // streaming text itself is sufficient feedback.
          if (activity.label === "Response streaming") continue;
          if (activity.label === "Response complete") continue;

          // Top-level failure activity emitted by the stream consumer's
          // failMessage and the sync-engine's runAssistantTurn catch.
          // Render at most one failure card per message — both paths can
          // emit a "Response failed" activity when a stream ends in error,
          // and the card reads its text from message.errorMessage anyway.
          if (activity.label === "Response failed") {
            flushReasoning(false);
            flushText(false);
            if (!items.some((item) => item.kind === "failure")) {
              items.push({ kind: "failure", key: `failure:${part.seq}` });
            }
            continue;
          }

          if (activity.step != null) {
            // For a given tool step we may see multiple activities
            // (active → completed, or active → failed). Only emit the
            // chip once; its live status and result count are read from
            // the run row, which reflects the latest state.
            flushReasoning(false);
            flushText(false);

            if (activity.tool === "extract") {
              if (renderedExtractSteps.has(activity.step)) continue;
              renderedExtractSteps.add(activity.step);
              const run = (extractRunsByMsg.get(messageId) ?? []).find(
                (r) => r.step === activity.step,
              );
              const url = run?.url ?? "";
              let host = "";
              if (url) {
                try {
                  host = new URL(url).hostname;
                } catch {
                  host = url;
                }
              }
              items.push({
                kind: "extract",
                step: activity.step,
                url,
                host,
                status: run ? run.status : activity.state,
                charCount: run?.charCount ?? 0,
                originalLength: run?.originalLength ?? null,
                truncated: run?.truncated ?? false,
                detail: activity.detail ?? run?.errorMessage ?? null,
                key: `extract:${activity.step}`,
              });
              continue;
            }

            // Default to search — covers explicit `tool: "search"` and the
            // back-compat path (stepped activity with no tool field).
            if (renderedSearchSteps.has(activity.step)) continue;
            renderedSearchSteps.add(activity.step);
            const run = (searchRunsByMsg.get(messageId) ?? []).find(
              (r) => r.step === activity.step,
            );
            items.push({
              kind: "search",
              step: activity.step,
              query: activity.query ?? run?.query ?? "",
              status: run ? run.status : activity.state,
              resultCount: run?.resultCount ?? 0,
              detail: activity.detail,
              key: `search:${activity.step}`,
            });
            continue;
          }

          // Activity with state="failed" but no step — treat as a top-
          // level failure marker (e.g. budget reached). Dedupe across a
          // message as above.
          if (activity.state === "failed") {
            flushReasoning(false);
            flushText(false);
            if (!items.some((item) => item.kind === "failure")) {
              items.push({ kind: "failure", key: `failure:${part.seq}` });
            }
            continue;
          }

          // Anything else: skip silently. Streaming text is the primary
          // feedback channel in the interleaved layout.
          continue;
        }

        if (part.kind === "thinking_tokens") {
          // Legacy summary pill: skip when the message already carries
          // real reasoning text to avoid a duplicate "Reasoning" chip.
          if (hasReasoningParts) continue;
          const tokens = parseThinkingTokens(part);
          if (tokens == null) continue;
          flushReasoning(false);
          flushText(false);
          items.push({ kind: "thinking", tokens, key: `thinking:${part.seq}` });
          continue;
        }
      }

      // Anything beyond the last committed text part is "live" streaming
      // tail. We compute how much text has been committed as parts and
      // show the remainder as a trailing markdown block.
      const message = messagesById().get(messageId);
      if (message?.role === "assistant") {
        const committedLength = parts
          .filter((part) => part.kind === "text")
          .reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
        const fullText = message.text ?? "";
        const tail = fullText.slice(committedLength);
        if (tail) {
          // Text tail closes an in-flight reasoning segment — the model
          // has moved from thinking to answering.
          flushReasoning(false);
          pendingText += tail;
          if (pendingTextSeq < 0) pendingTextSeq = Number.MAX_SAFE_INTEGER;
        }
        const status = effectiveMessageStatus(message);
        const streaming = status === "streaming" || status === "pending" || status === "queued";
        // If reasoning is still open and the message is mid-stream,
        // leave the chip in its streaming state so the user sees live
        // updates. Once the status flips to completed/failed it closes.
        flushReasoning(streaming && !pendingText && !items.some((it) => it.kind === "markdown"));
        flushText(streaming);
      } else {
        flushReasoning(false);
        flushText(false);
      }

      byMessage.set(messageId, items);
    }
    return byMessage;
  });

  const assistantTimeline = (messageId: string) =>
    assistantTimelineByMessage().get(messageId) ?? [];
  const searchResultsForStep = (messageId: string, step: number) => {
    const runs = searchRunsMemo().get(messageId) ?? [];
    const run = runs.find((r) => r.step === step);
    if (!run) return null;
    let offset = 0;
    for (const r of runs) {
      if (r.step < step) offset += r.results.length;
    }
    return { run, startIndex: offset + 1 };
  };
  const chipCollapseKey = (messageId: string, key: string) => `${messageId}:${key}`;
  const isChipCollapsed = (messageId: string, key: string) =>
    collapsedChipByKey[chipCollapseKey(messageId, key)] ?? true;
  const toggleChipCollapse = (messageId: string, key: string) => {
    setCollapsedChipByKey(chipCollapseKey(messageId, key), !isChipCollapsed(messageId, key));
  };
  /**
   * Reasoning chips follow a different default than search chips: while
   * the model is actively streaming thoughts we auto-expand so the user
   * can follow along (like t3-chat). Once the user explicitly toggles
   * the chip we honor that choice forever after, including after
   * streaming completes.
   */
  const isReasoningCollapsed = (messageId: string, key: string, streaming: boolean) => {
    const explicit = collapsedChipByKey[chipCollapseKey(messageId, key)];
    if (explicit !== undefined) return explicit;
    if (effectiveExpandReasoningByDefault()) return false;
    return !streaming;
  };
  const toggleReasoningCollapse = (messageId: string, key: string, streaming: boolean) => {
    setCollapsedChipByKey(
      chipCollapseKey(messageId, key),
      !isReasoningCollapsed(messageId, key, streaming),
    );
  };

  const expandedStreamingReasoningFingerprint = createMemo(() => {
    const messageId = messageIds().find((id) => {
      const msg = messageById(id);
      if (!msg || msg.role !== "assistant") return false;
      const status = effectiveMessageStatus(msg);
      return status === "streaming" || status === "pending" || status === "queued";
    });
    if (!messageId) return "";
    const reasoning = assistantTimeline(messageId).find(
      (item): item is Extract<TimelineItem, { kind: "reasoning" }> =>
        item.kind === "reasoning" &&
        item.streaming &&
        !isReasoningCollapsed(messageId, item.key, item.streaming),
    );
    return reasoning ? `${messageId}:${reasoning.key}:${reasoning.text.length}` : "";
  });

  // Auto-scroll only when user is already near the bottom.
  // Fingerprint isolates the scroll trigger so the effect doesn't re-run
  // on every unrelated message or activity change.
  const scrollFingerprint = createMemo(() => {
    const ids = messageIds();
    const lastId = ids[ids.length - 1];
    if (!lastId) return "";
    const msg = messageById(lastId);
    if (!msg) return "";
    const parts = msg.role === "assistant" ? messagePartsForMessage(lastId) : [];
    const partsKey = parts.map((p) => `${p.id}:${p.seq}:${p.kind}`).join(",");
    return `${msg.id}:${msg.status}:${msg.text?.length ?? 0}|${partsKey}`;
  });
  createEffect(() => {
    scrollFingerprint();
    expandedStreamingReasoningFingerprint();
    requestAnimationFrame(() => {
      if (streamingReasoningTextRef && reasoningNearBottom()) {
        streamingReasoningTextRef.scrollTop = streamingReasoningTextRef.scrollHeight;
      }
      if (timelineRef && isNearBottom()) {
        _isProgrammaticScroll = true;
        timelineRef.scrollTop = timelineRef.scrollHeight;
        _isProgrammaticScroll = false;
      }
    });
  });

  const traceRunsByMessage = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, TraceRun[]>();
    for (const row of allTraceRuns()) {
      if (!row.messageId || !selectedMessageIds.has(row.messageId)) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    for (const list of byMessage.values()) {
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    return byMessage;
  });

  const thinkingTokens = (messageId: string) => thinkingTokensByMessage().get(messageId) ?? null;
  const activitiesForMessage = (messageId: string) => assistantActivities().get(messageId) ?? [];
  const isWaitingForVisibleAnswer = (message: Message) => {
    const status = effectiveMessageStatus(message);
    return (
      message.role === "assistant" &&
      (status === "queued" || status === "pending" || status === "streaming") &&
      !message.text?.trim()
    );
  };
  const allTimelineItemsFinished = (items: TimelineItem[]) =>
    items.length > 0 &&
    items.every((item) => {
      if (item.kind === "search" || item.kind === "extract") return item.status !== "active";
      if (item.kind === "reasoning" || item.kind === "markdown") return !item.streaming;
      return true;
    });
  const hasAssistantPrelude = (message: Message) =>
    message.role === "assistant" &&
    !isInterleavedMessage(message.id) &&
    (activitiesForMessage(message.id).length > 0 ||
      isWaitingForVisibleAnswer(message) ||
      thinkingTokens(message.id) != null ||
      (effectiveShowTraces() && traceRunsForMessage(message.id).length > 0));
  const hasAssistantStats = (message: Message) =>
    message.role === "assistant" &&
    (thinkingTokens(message.id) != null ||
      message.promptTokens != null ||
      message.ttftMs != null ||
      message.durationMs != null ||
      message.completionTokens != null);
  const hasAssistantAnswerCard = (message: Message) =>
    message.role === "assistant" &&
    !isInterleavedMessage(message.id) &&
    (Boolean(message.text?.trim()) ||
      effectiveMessageStatus(message) === "failed" ||
      (searchRunsMemo().get(message.id)?.length ?? 0) > 0 ||
      (extractRunsMemo().get(message.id)?.length ?? 0) > 0 ||
      hasAssistantStats(message));
  /**
   * True when an assistant message should render with the new interleaved
   * T3-style layout (text + inline activity chips in seq order). Controls
   * which rendering branch runs inside `renderMessage`.
   */
  const hasAssistantInterleavedBody = (message: Message) =>
    message.role === "assistant" && isInterleavedMessage(message.id);
  const thinkingLabel = (messageId: string) => {
    const tokens = thinkingTokens(messageId);
    return tokens != null ? `${formatTokenCount(tokens)} thinking tokens` : "Generating…";
  };
  const isAssistantPreludeCollapsed = (messageId: string) =>
    collapsedProgressByMessage[messageId] ?? false;
  const toggleAssistantPrelude = (messageId: string) =>
    setCollapsedProgressByMessage(messageId, !isAssistantPreludeCollapsed(messageId));
  const assistantPreludeSummary = (message: Message) => {
    const parts: string[] = [];
    const activities = activitiesForMessage(message.id);
    const tokens = thinkingTokens(message.id);

    if (activities.length > 0) {
      parts.push(`${activities.length} step${activities.length === 1 ? "" : "s"}`);
    }
    if (tokens != null) {
      parts.push(`${formatTokenCount(tokens)} thinking tokens`);
    }
    if (effectiveShowTraces() && traceRunsForMessage(message.id).length > 0) {
      parts.push(`trace ${traceRunsForMessage(message.id).length}`);
    }
    if (isWaitingForVisibleAnswer(message)) {
      parts.push("live");
    }

    return parts.join(" • ") || "Live model activity";
  };
  const assistantError = (message: Message) =>
    explainAssistantError({
      errorCode: message.errorCode,
      errorMessage: message.errorMessage,
    });
  const assistantProgressFailureSummary = (message: Message, activity: AssistantActivity) => {
    if (
      activity.state !== "failed" ||
      activity.label !== "Response failed" ||
      message.status !== "failed"
    ) {
      return null;
    }
    return assistantError(message).summary;
  };
  const isTraceCollapsed = (messageId: string) => collapsedTraceByMessage[messageId] ?? true;
  const toggleTraceDrawer = (messageId: string) =>
    setCollapsedTraceByMessage(messageId, !isTraceCollapsed(messageId));
  const traceRunsForMessage = (messageId: string) => traceRunsByMessage().get(messageId) ?? [];
  const openTraceMessageIdSet = createMemo(() => {
    if (!effectiveShowTraces()) return new Set<string>();

    const openIds = new Set<string>();
    for (const messageId of messageIds()) {
      if (!isTraceCollapsed(messageId) && traceRunsForMessage(messageId).length > 0) {
        openIds.add(messageId);
      }
    }
    return openIds;
  });
  const traceSpansByRun = createMemo(() => {
    const openMessageIds = openTraceMessageIdSet();
    if (openMessageIds.size === 0) return new Map<string, TraceSpan[]>();

    const openRunIds = new Set<string>();
    for (const messageId of openMessageIds) {
      for (const run of traceRunsForMessage(messageId)) {
        openRunIds.add(run.id);
      }
    }

    const byRun = new Map<string, TraceSpan[]>();
    for (const row of allTraceSpans()) {
      if (!row.traceRunId || !openRunIds.has(row.traceRunId)) continue;
      const list = byRun.get(row.traceRunId) ?? [];
      list.push(row);
      byRun.set(row.traceRunId, list);
    }
    for (const list of byRun.values()) {
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    return byRun;
  });
  const traceTreesByMessage = createMemo(() => {
    const trees = new Map<string, TraceTreeView[]>();
    for (const messageId of openTraceMessageIdSet()) {
      const runs = traceRunsByMessage().get(messageId) ?? [];
      trees.set(
        messageId,
        runs.map((run) => {
          const spans = buildTraceTree(traceSpansByRun().get(run.id) ?? []);
          const attrs = parseTraceJson(run.attrsJson);
          return {
            run,
            spans,
            attrs,
            copyText: buildTraceCopyText({ run, spans, attrs }),
          };
        }),
      );
    }
    return trees;
  });
  const traceTreesForMessage = (messageId: string) => traceTreesByMessage().get(messageId) ?? [];
  const traceSummaryForMessage = (messageId: string) => {
    const firstRun = traceRunsForMessage(messageId)[0];
    return firstRun
      ? `${formatTraceStatus(firstRun.status)} • ${shortTraceId(firstRun.traceId)}`
      : "Developer trace";
  };
  const traceDrawerDataForMessage = (messageId: string): TraceDrawerTrace[] =>
    traceTreesForMessage(messageId).map((trace) => ({
      traceId: trace.run.traceId,
      status: trace.run.status,
      modelId: trace.run.modelId,
      durationMs: trace.run.durationMs ?? null,
      errorMessage: trace.run.errorMessage,
      attrs: trace.attrs,
      spans: trace.spans,
      copyText: trace.copyText,
    }));

  // Auto-collapse assistant prelude once text arrives.
  // Fingerprint isolates the trigger so the effect doesn't re-run
  // on every streaming delta or unrelated activity.
  const autoCollapseFingerprint = createMemo(() => {
    const ids: string[] = [];
    for (const messageId of messageIds()) {
      const message = messageById(messageId);
      if (!message) continue;
      if (
        message.role !== "assistant" ||
        !hasAssistantPrelude(message) ||
        !message.text?.trim() ||
        didAutoCollapseProgressByMessage[message.id]
      ) {
        continue;
      }
      ids.push(message.id);
    }
    return ids.join(",");
  });
  createEffect(() => {
    autoCollapseFingerprint();
    for (const messageId of messageIds()) {
      const message = messageById(messageId);
      if (!message) continue;
      if (
        message.role !== "assistant" ||
        !hasAssistantPrelude(message) ||
        !message.text?.trim() ||
        didAutoCollapseProgressByMessage[message.id]
      ) {
        continue;
      }
      setCollapsedProgressByMessage(message.id, true);
      setDidAutoCollapseProgressByMessage(message.id, true);
    }
  });

  // Pre-index attachments by messageId so filtering is O(1) per message
  const attachmentsByMessage = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, Attachment[]>();
    for (const att of allAttachments()) {
      if (att.status === "failed" || !att.messageId || !selectedMessageIds.has(att.messageId)) {
        continue;
      }
      const list = byMessage.get(att.messageId) ?? [];
      list.push(att);
      byMessage.set(att.messageId, list);
    }
    return byMessage;
  });

  const userAttachments = (messageId: string) => attachmentsByMessage().get(messageId) ?? [];
  const userImageAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => isImageMime(attachment.mimeType));
  const userFileAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => !isImageMime(attachment.mimeType));

  const previewText = (text: string | null | undefined, fallback: string) => {
    const trimmed = text?.trim();
    if (!trimmed) return fallback;
    return trimmed.replace(/\s+/g, " ").slice(0, 120);
  };

  const userMessageMarkers = createMemo(() => {
    const ids = messageIds();
    const markers: Array<{ id: string; label: string; preview: string }> = [];
    for (let index = 0; index < ids.length; index++) {
      const message = messageById(ids[index]!);
      if (!message || message.role !== "user") continue;
      const label = previewText(message.text, "Attachment message");
      const reply = ids
        .slice(index + 1)
        .map((id) => messageById(id))
        .find((candidate) => candidate?.role === "assistant");
      const preview = previewText(reply?.text, label);
      markers.push({ id: message.id, label, preview });
    }
    return markers;
  });

  const hoveredMinimapCard = createMemo(() => {
    const hovered = hoveredMinimapMarker();
    if (!hovered) return null;
    const marker = userMessageMarkers().find((entry) => entry.id === hovered.id);
    if (!marker) return null;
    return { ...marker, top: hovered.top, left: hovered.left };
  });

  const showMinimapCard = (markerId: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHoveredMinimapMarker({
      id: markerId,
      top: rect.top + rect.height / 2,
      left: rect.right + 10,
    });
  };

  hideMinimapCard = (markerId?: string) => {
    setHoveredMinimapMarker((current) => {
      if (!current) return null;
      if (markerId && current.id !== markerId) return current;
      return null;
    });
  };

  updateActiveMinimapMarker = () => {
    const markers = userMessageMarkers();
    if (!timelineRef || markers.length === 0) {
      setActiveMinimapMarkerId(null);
      return;
    }

    const timelineRect = timelineRef.getBoundingClientRect();
    const focusY = timelineRect.top + Math.min(120, timelineRect.height * 0.28);
    let bestId = markers[markers.length - 1]!.id;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const marker of markers) {
      const target = timelineRef.querySelector<HTMLElement>(`[data-message-id="${marker.id}"]`);
      if (!target) continue;
      const distance = Math.abs(target.getBoundingClientRect().top - focusY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = marker.id;
      }
    }

    setActiveMinimapMarkerId(bestId);
  };

  // Track messageIds() only: it has stable equality, so this fires when a
  // message is added/removed but not on every streaming token. Reading
  // userMessageMarkers() here would re-run on every message text update.
  createEffect(() => {
    messageIds();
    queueMicrotask(updateActiveMinimapMarker);
  });

  createEffect(() => {
    const onResize = () => {
      updateActiveMinimapMarker();
      hideMinimapCard();
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });

  const scrollToMessage = (messageId: string) => {
    const target = timelineRef?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!target) return;
    setActiveMinimapMarkerId(messageId);
    hideMinimapCard();
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const renderMessage = (messageId: string) => {
    const message = () => messageById(messageId);

    return (
      <Show when={message()}>
        {(message) =>
          (() => {
            const status = () => effectiveMessageStatus(message());
            return (
              <article
                data-message-id={message().id}
                classList={{
                  msg: true,
                  assistant: message().role === "assistant",
                  user: message().role === "user",
                }}
              >
                <div class="msg-meta">
                  <span class="msg-role">{message().role === "assistant" ? "AI" : "You"}</span>
                  <Show when={status() && status() !== "completed"}>
                    <span class="chat-marker chat-marker-inline msg-status">
                      <span class="chat-marker-dot" aria-hidden="true" />
                      <span>{status()}</span>
                    </span>
                  </Show>
                </div>
                <Show
                  when={message().role === "assistant"}
                  fallback={
                    <div class="msg-user-row">
                      <div class="msg-user-actions">
                        <button
                          type="button"
                          class="msg-action-btn"
                          aria-label="Edit and regenerate from this point"
                          title="Edit and regenerate from this point"
                          disabled={isSelectedThreadBusy()}
                          onClick={() => startEditingUserMessage(message())}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="msg-action-btn"
                          aria-label="Retry from this point with original settings"
                          title="Retry from this point with original settings"
                          disabled={isSelectedThreadBusy()}
                          onClick={() => retryMessage(message())}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                          >
                            <polyline points="1 4 1 10 7 10" />
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="msg-action-btn"
                          aria-label="Fork thread from here"
                          title="Fork thread from this message"
                          onClick={() =>
                            forkThreadAction({
                              sourceThreadId: message().threadId,
                              sourceMessageId: message().id,
                              workspaceId: activeWorkspace()?.id ?? message().threadId,
                            })
                          }
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                          >
                            <line x1="6" y1="3" x2="6" y2="15" />
                            <circle cx="18" cy="6" r="3" />
                            <circle cx="6" cy="21" r="3" />
                            <line x1="15" y1="9" x2="9" y2="17" />
                          </svg>
                        </button>
                      </div>
                      <div class="msg-user-stack">
                        <Show when={userImageAttachments(message().id).length > 0}>
                          <Suspense fallback={null}>
                            <MessageAttachments
                              images={userImageAttachments(message().id)}
                              files={[]}
                            />
                          </Suspense>
                        </Show>
                        <Show
                          when={editingUserMessageId() === message().id}
                          fallback={
                            <Show when={message().text?.trim()}>
                              <div class="msg-user-body">
                                <p>{message().text}</p>
                              </div>
                            </Show>
                          }
                        >
                          <div class="msg-edit-form">
                            <textarea
                              value={editingUserMessageText()}
                              onInput={(e) => setEditingUserMessageText(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.isComposing) return;
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelEditingUserMessage();
                                  return;
                                }
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  commitUserMessageEdit(message());
                                }
                              }}
                            />
                            <div class="msg-edit-actions">
                              <button type="button" onClick={cancelEditingUserMessage}>
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => commitUserMessageEdit(message())}
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        </Show>
                        <Show when={userFileAttachments(message().id).length > 0}>
                          <Suspense fallback={null}>
                            <MessageAttachments
                              images={[]}
                              files={userFileAttachments(message().id)}
                            />
                          </Suspense>
                        </Show>
                      </div>
                    </div>
                  }
                >
                  <Show when={hasAssistantInterleavedBody(message())}>
                    <div class="assistant-interleaved-body">
                      <Show
                        when={
                          isWaitingForVisibleAnswer(message()) &&
                          (assistantTimeline(message().id).length === 0 ||
                            allTimelineItemsFinished(assistantTimeline(message().id)))
                        }
                      >
                        <div class="chat-marker thinking-indicator">
                          <span class="thinking-spinner" />
                          <span>Generating…</span>
                        </div>
                      </Show>
                      <Index each={assistantTimeline(message().id)}>
                        {(row) => (
                          <Show when={row()}>
                            {(item) => (
                              <Switch>
                                <Match when={markdownTimelineItem(item())}>
                                  {(data) => {
                                    const cites = () => citationsForMessage(message().id);
                                    return (
                                      <Show
                                        when={data().streaming}
                                        fallback={
                                          <LazyMarkdownBlock
                                            text={data().text}
                                            citations={cites()}
                                          />
                                        }
                                      >
                                        <LazyMarkdownBlock
                                          text={data().text}
                                          streaming
                                          citations={cites()}
                                        />
                                      </Show>
                                    );
                                  }}
                                </Match>
                                <Match when={searchTimelineItem(item())}>
                                  {(data) => {
                                    const collapsed = () =>
                                      isChipCollapsed(message().id, data().key);
                                    const resultsData = () =>
                                      searchResultsForStep(message().id, data().step);
                                    const hasResults = () =>
                                      (resultsData()?.run.results.length ?? 0) > 0;
                                    const runMode = () => resultsData()?.run.mode;
                                    const rawPreview = () => {
                                      if (runMode() !== "mcp") return "";
                                      return resultsData()?.run.previewText ?? "";
                                    };
                                    const hasRawPreview = () => rawPreview().length > 0;
                                    const statusLabel = () => {
                                      if (data().status === "failed") return "Search failed";
                                      if (data().status === "active") return "Searching the web";
                                      return "Searched the web";
                                    };
                                    const countLabel = () => {
                                      const count =
                                        resultsData()?.run.results.length ?? data().resultCount;
                                      if (!count) return null;
                                      return `${count} result${count === 1 ? "" : "s"}`;
                                    };
                                    return (
                                      <div
                                        classList={{
                                          "assistant-chip": true,
                                          "assistant-chip-search": true,
                                          "is-active": data().status === "active",
                                          "is-failed": data().status === "failed",
                                        }}
                                      >
                                        <button
                                          type="button"
                                          class="assistant-chip-toggle"
                                          aria-expanded={!collapsed()}
                                          onClick={() =>
                                            toggleChipCollapse(message().id, data().key)
                                          }
                                          disabled={
                                            !hasResults() &&
                                            !hasRawPreview() &&
                                            data().status !== "failed"
                                          }
                                        >
                                          <span class="assistant-chip-icon" aria-hidden="true">
                                            <Show
                                              when={data().status === "active"}
                                              fallback={
                                                <svg
                                                  width="12"
                                                  height="12"
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                  stroke="currentColor"
                                                  stroke-width="2"
                                                  stroke-linecap="round"
                                                  stroke-linejoin="round"
                                                >
                                                  <circle cx="11" cy="11" r="8" />
                                                  <path d="m21 21-4.3-4.3" />
                                                </svg>
                                              }
                                            >
                                              <span class="thinking-spinner" />
                                            </Show>
                                          </span>
                                          <span class="assistant-chip-label">{statusLabel()}</span>
                                          <Show when={runMode() === "mcp"}>
                                            <span
                                              class="assistant-chip-badge"
                                              title="Search ran through Exa's free public endpoint — returns raw text, no ranked link results."
                                            >
                                              raw text
                                            </span>
                                          </Show>
                                          <Show when={data().query}>
                                            <span class="assistant-chip-detail">
                                              "{data().query}"
                                            </span>
                                          </Show>
                                          <Show when={countLabel()}>
                                            {(label) => (
                                              <span class="assistant-chip-meta">{label()}</span>
                                            )}
                                          </Show>
                                          <Show
                                            when={
                                              hasResults() ||
                                              hasRawPreview() ||
                                              data().status === "failed"
                                            }
                                          >
                                            <span
                                              classList={{
                                                "assistant-chip-chevron": true,
                                                "is-collapsed": collapsed(),
                                              }}
                                              aria-hidden="true"
                                            >
                                              ▾
                                            </span>
                                          </Show>
                                        </button>
                                        <Show
                                          when={!collapsed() && hasRawPreview() && !hasResults()}
                                        >
                                          <div class="search-raw-preview">{rawPreview()}</div>
                                        </Show>
                                        <Show when={!collapsed() && hasResults()}>
                                          <Show when={resultsData()}>
                                            {(d) => (
                                              <div class="search-results-inline">
                                                <Index each={d().run.results}>
                                                  {(result, idx) => (
                                                    <a
                                                      class="search-result-link"
                                                      href={result().url}
                                                      target="_blank"
                                                      rel="noreferrer"
                                                    >
                                                      <span class="search-result-num">
                                                        {d().startIndex + idx}
                                                      </span>
                                                      <span class="search-result-title">
                                                        {result().title}
                                                      </span>
                                                      <span class="search-result-domain">
                                                        {result().domain}
                                                      </span>
                                                    </a>
                                                  )}
                                                </Index>
                                              </div>
                                            )}
                                          </Show>
                                        </Show>
                                        <Show
                                          when={
                                            !collapsed() &&
                                            data().status === "failed" &&
                                            data().detail
                                          }
                                        >
                                          <div class="assistant-chip-error">{data().detail}</div>
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </Match>
                                <Match when={extractTimelineItem(item())}>
                                  {(data) => {
                                    const collapsed = () =>
                                      isChipCollapsed(message().id, data().key);
                                    const hasDetail = () =>
                                      Boolean(data().url) ||
                                      (data().status === "failed" && Boolean(data().detail));
                                    const statusLabel = () => {
                                      if (data().status === "failed") return "Read failed";
                                      if (data().status === "active") return "Reading page";
                                      return "Read page";
                                    };
                                    const metaLabel = () => {
                                      if (data().status !== "completed") return null;
                                      const chars = data().originalLength ?? data().charCount;
                                      if (!chars) return null;
                                      return data().truncated
                                        ? `${chars.toLocaleString()} chars (truncated)`
                                        : `${chars.toLocaleString()} chars`;
                                    };
                                    return (
                                      <div
                                        classList={{
                                          "assistant-chip": true,
                                          "assistant-chip-search": true,
                                          "assistant-chip-extract": true,
                                          "is-active": data().status === "active",
                                          "is-failed": data().status === "failed",
                                        }}
                                      >
                                        <button
                                          type="button"
                                          class="assistant-chip-toggle"
                                          aria-expanded={!collapsed()}
                                          onClick={() =>
                                            toggleChipCollapse(message().id, data().key)
                                          }
                                          disabled={!hasDetail()}
                                        >
                                          <span class="assistant-chip-icon" aria-hidden="true">
                                            <Show
                                              when={data().status === "active"}
                                              fallback={
                                                <svg
                                                  width="12"
                                                  height="12"
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                  stroke="currentColor"
                                                  stroke-width="2"
                                                  stroke-linecap="round"
                                                  stroke-linejoin="round"
                                                >
                                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                  <path d="M14 2v6h6" />
                                                  <path d="M16 13H8" />
                                                  <path d="M16 17H8" />
                                                  <path d="M10 9H8" />
                                                </svg>
                                              }
                                            >
                                              <span class="thinking-spinner" />
                                            </Show>
                                          </span>
                                          <span class="assistant-chip-label">{statusLabel()}</span>
                                          <Show when={data().host}>
                                            <span class="assistant-chip-detail">{data().host}</span>
                                          </Show>
                                          <Show when={metaLabel()}>
                                            {(label) => (
                                              <span class="assistant-chip-meta">{label()}</span>
                                            )}
                                          </Show>
                                          <Show when={hasDetail()}>
                                            <span
                                              classList={{
                                                "assistant-chip-chevron": true,
                                                "is-collapsed": collapsed(),
                                              }}
                                              aria-hidden="true"
                                            >
                                              ▾
                                            </span>
                                          </Show>
                                        </button>
                                        <Show when={!collapsed() && data().url}>
                                          <div class="search-results-inline">
                                            <a
                                              class="search-result-link"
                                              href={data().url}
                                              target="_blank"
                                              rel="noreferrer"
                                            >
                                              <span class="search-result-title">{data().url}</span>
                                            </a>
                                          </div>
                                        </Show>
                                        <Show
                                          when={
                                            !collapsed() &&
                                            data().status === "failed" &&
                                            data().detail
                                          }
                                        >
                                          <div class="assistant-chip-error">{data().detail}</div>
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </Match>
                                <Match when={reasoningTimelineItem(item())}>
                                  {(data) => {
                                    const collapsed = () =>
                                      isReasoningCollapsed(
                                        message().id,
                                        data().key,
                                        data().streaming,
                                      );
                                    return (
                                      <div
                                        classList={{
                                          "assistant-chip": true,
                                          "assistant-chip-reasoning": true,
                                          "is-active": data().streaming,
                                        }}
                                      >
                                        <button
                                          type="button"
                                          class="assistant-chip-toggle"
                                          aria-expanded={!collapsed()}
                                          onClick={() =>
                                            toggleReasoningCollapse(
                                              message().id,
                                              data().key,
                                              data().streaming,
                                            )
                                          }
                                        >
                                          <span class="assistant-chip-icon" aria-hidden="true">
                                            <Show
                                              when={data().streaming}
                                              fallback={
                                                <svg
                                                  width="12"
                                                  height="12"
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                  stroke="currentColor"
                                                  stroke-width="2"
                                                  stroke-linecap="round"
                                                  stroke-linejoin="round"
                                                >
                                                  <path d="M12 2a4.5 4.5 0 0 0-4.5 4.5c0 .9.27 1.75.73 2.46A4.5 4.5 0 0 0 8 17.5V19a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1.5a4.5 4.5 0 0 0-.23-8.54A4.5 4.5 0 0 0 16.5 6.5 4.5 4.5 0 0 0 12 2Z" />
                                                  <path d="M12 2v19" />
                                                  <path d="M9 7h.01" />
                                                  <path d="M15 7h.01" />
                                                </svg>
                                              }
                                            >
                                              <span class="thinking-spinner" />
                                            </Show>
                                          </span>
                                          <span class="assistant-chip-label">Reasoning</span>
                                          <span
                                            classList={{
                                              "assistant-chip-chevron": true,
                                              "is-collapsed": collapsed(),
                                            }}
                                            aria-hidden="true"
                                          >
                                            ▾
                                          </span>
                                        </button>
                                        <Show when={!collapsed()}>
                                          <div
                                            class="assistant-chip-reasoning-text"
                                            ref={
                                              data().streaming
                                                ? (el) => (streamingReasoningTextRef = el)
                                                : undefined
                                            }
                                            onScroll={
                                              data().streaming ? handleReasoningScroll : undefined
                                            }
                                          >
                                            {data().text}
                                            <Show when={data().streaming}>
                                              <span
                                                class="assistant-chip-reasoning-caret"
                                                aria-hidden="true"
                                              />
                                            </Show>
                                          </div>
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </Match>
                                <Match when={thinkingTimelineItem(item())}>
                                  {(data) => (
                                    <div class="assistant-chip assistant-chip-thinking">
                                      <span class="assistant-chip-icon" aria-hidden="true">
                                        <svg
                                          width="12"
                                          height="12"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          stroke-width="2"
                                          stroke-linecap="round"
                                          stroke-linejoin="round"
                                        >
                                          <path d="M9.663 17h4.673M12 3v1M5.64 5.64l.71.71M3 12h1M20 12h1M18.36 5.64l-.71.71M12 18a6 6 0 0 0 3.5-10.9A6 6 0 0 0 8.5 7.1 6 6 0 0 0 12 18Z" />
                                        </svg>
                                      </span>
                                      <span class="assistant-chip-label">Reasoning</span>
                                      <span class="assistant-chip-meta">
                                        {formatTokenCount(data().tokens)} tokens
                                      </span>
                                    </div>
                                  )}
                                </Match>
                                <Match when={item().kind === "failure"}>
                                  <div class="assistant-error-card" role="alert">
                                    <div class="assistant-error-title">
                                      {assistantError(message()).title}
                                    </div>
                                    <div class="assistant-error-summary">
                                      {assistantError(message()).summary}
                                    </div>
                                    <p class="assistant-error-explanation">
                                      {assistantError(message()).explanation}
                                    </p>
                                    <details class="assistant-error-details">
                                      <summary>Technical details</summary>
                                      <pre>{assistantError(message()).details}</pre>
                                    </details>
                                  </div>
                                </Match>
                              </Switch>
                            )}
                          </Show>
                        )}
                      </Index>
                      <Show when={hasAssistantStats(message())}>
                        <div class="msg-stats">
                          <Show when={thinkingTokens(message().id)}>
                            <span>
                              {formatTokenCount(thinkingTokens(message().id)!)} thinking tokens
                            </span>
                          </Show>
                          <Show when={getTotalTokens(message()) != null}>
                            <span>{formatTokenCount(getTotalTokens(message())!)} total tokens</span>
                          </Show>
                          <Show when={message().promptTokens != null}>
                            <span>{formatTokenCount(message().promptTokens!)} prompt</span>
                          </Show>
                          <Show when={message().completionTokens != null}>
                            <span>{formatTokenCount(message().completionTokens!)} output</span>
                          </Show>
                          <Show when={message().ttftMs != null}>
                            <span>TTFT {message().ttftMs}ms</span>
                          </Show>
                          <Show when={message().durationMs != null}>
                            <span>{formatDuration(message().durationMs!)}</span>
                          </Show>
                          <Show
                            when={
                              message().completionTokens != null &&
                              message().durationMs != null &&
                              message().durationMs! > 0
                            }
                          >
                            <span>
                              {(
                                (message().completionTokens! / message().durationMs!) *
                                1000
                              ).toFixed(1)}{" "}
                              tok/s
                            </span>
                          </Show>
                          <Show when={message().modelId}>
                            <span class="msg-stats-model">{message().modelId}</span>
                          </Show>
                          <button
                            type="button"
                            class="msg-action-btn fork-btn"
                            aria-label="Fork thread from here"
                            title="Fork thread from this message"
                            onClick={() =>
                              forkThreadAction({
                                sourceThreadId: message().threadId,
                                sourceMessageId: message().id,
                                workspaceId: activeWorkspace()?.id ?? message().threadId,
                              })
                            }
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <line x1="6" y1="3" x2="6" y2="15" />
                              <circle cx="18" cy="6" r="3" />
                              <circle cx="6" cy="21" r="3" />
                              <line x1="15" y1="9" x2="9" y2="17" />
                            </svg>
                          </button>
                        </div>
                      </Show>
                      <Show
                        when={effectiveShowTraces() && traceRunsForMessage(message().id).length > 0}
                      >
                        <div class="trace-shell">
                          <button
                            type="button"
                            class="trace-toggle"
                            aria-expanded={!isTraceCollapsed(message().id)}
                            aria-controls={`trace-drawer-${message().id}`}
                            onClick={() => toggleTraceDrawer(message().id)}
                          >
                            <span class="trace-toggle-copy">
                              <span class="trace-toggle-label">Trace</span>
                              <span class="trace-toggle-meta">
                                {traceSummaryForMessage(message().id)}
                              </span>
                            </span>
                            <span
                              classList={{
                                "assistant-progress-toggle-chevron": true,
                                "is-collapsed": isTraceCollapsed(message().id),
                              }}
                              aria-hidden="true"
                            >
                              ▾
                            </span>
                          </button>
                          <Show when={!isTraceCollapsed(message().id)}>
                            <div class="trace-drawer" id={`trace-drawer-${message().id}`}>
                              <Suspense fallback={null}>
                                <TraceDrawerContent
                                  traces={traceDrawerDataForMessage(message().id)}
                                  formatDuration={formatDuration}
                                  formatTraceStatus={formatTraceStatus}
                                  shortTraceId={shortTraceId}
                                />
                              </Suspense>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <Show when={hasAssistantPrelude(message())}>
                    <div class="assistant-progress-shell">
                      <button
                        type="button"
                        class="assistant-progress-toggle"
                        aria-expanded={!isAssistantPreludeCollapsed(message().id)}
                        aria-controls={`assistant-progress-${message().id}`}
                        onClick={() => toggleAssistantPrelude(message().id)}
                      >
                        <span class="assistant-progress-toggle-copy">
                          <span class="assistant-progress-toggle-label">Model activity</span>
                          <span class="assistant-progress-toggle-meta">
                            {assistantPreludeSummary(message())}
                          </span>
                        </span>
                        <span
                          classList={{
                            "assistant-progress-toggle-chevron": true,
                            "is-collapsed": isAssistantPreludeCollapsed(message().id),
                          }}
                          aria-hidden="true"
                        >
                          ▾
                        </span>
                      </button>
                      <Show when={!isAssistantPreludeCollapsed(message().id)}>
                        <div
                          class="assistant-progress-stack"
                          id={`assistant-progress-${message().id}`}
                        >
                          <Show when={activitiesForMessage(message().id).length > 0}>
                            <div class="assistant-progress">
                              <Index each={activitiesForMessage(message().id)}>
                                {(activity) => {
                                  const searchRunResults = () => {
                                    if (activity().state !== "completed" || activity().step == null)
                                      return null;
                                    const runs = searchRunsMemo().get(message().id) ?? [];
                                    const run = runs.find((r) => r.step === activity().step);
                                    if (!run || run.results.length === 0) return null;
                                    let offset = 0;
                                    for (const r of runs) {
                                      if (r.step < run.step) offset += r.results.length;
                                    }
                                    return { results: run.results, startIndex: offset + 1 };
                                  };

                                  return (
                                    <div
                                      classList={{
                                        "assistant-progress-item": true,
                                        "is-active": activity().state === "active",
                                        "is-failed": activity().state === "failed",
                                      }}
                                    >
                                      <span class="assistant-progress-marker" aria-hidden="true" />
                                      <div class="assistant-progress-copy">
                                        <span>{activity().label}</span>
                                        <Show
                                          when={assistantProgressFailureSummary(
                                            message(),
                                            activity(),
                                          )}
                                        >
                                          {(summary) => (
                                            <span class="assistant-progress-detail">
                                              {summary()}
                                            </span>
                                          )}
                                        </Show>
                                        <Show when={searchRunResults()}>
                                          {(data) => (
                                            <div class="search-results-inline">
                                              <Index each={data().results}>
                                                {(result, idx) => (
                                                  <a
                                                    class="search-result-link"
                                                    href={result().url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                  >
                                                    <span class="search-result-num">
                                                      {data().startIndex + idx}
                                                    </span>
                                                    <span class="search-result-title">
                                                      {result().title}
                                                    </span>
                                                    <span class="search-result-domain">
                                                      {result().domain}
                                                    </span>
                                                  </a>
                                                )}
                                              </Index>
                                            </div>
                                          )}
                                        </Show>
                                      </div>
                                    </div>
                                  );
                                }}
                              </Index>
                            </div>
                          </Show>
                          <Show
                            when={
                              isWaitingForVisibleAnswer(message()) ||
                              thinkingTokens(message().id) != null
                            }
                          >
                            <div
                              classList={{
                                "thinking-indicator": true,
                                "is-complete":
                                  !isWaitingForVisibleAnswer(message()) &&
                                  thinkingTokens(message().id) != null,
                              }}
                            >
                              <Show
                                when={isWaitingForVisibleAnswer(message())}
                                fallback={
                                  <span
                                    class="assistant-progress-marker thinking-indicator-marker"
                                    aria-hidden="true"
                                  />
                                }
                              >
                                <span class="thinking-spinner" />
                              </Show>
                              <span>{thinkingLabel(message().id)}</span>
                            </div>
                          </Show>
                          <Show
                            when={
                              effectiveShowTraces() && traceRunsForMessage(message().id).length > 0
                            }
                          >
                            <div class="trace-shell">
                              <button
                                type="button"
                                class="trace-toggle"
                                aria-expanded={!isTraceCollapsed(message().id)}
                                aria-controls={`trace-drawer-${message().id}`}
                                onClick={() => toggleTraceDrawer(message().id)}
                              >
                                <span class="trace-toggle-copy">
                                  <span class="trace-toggle-label">Trace</span>
                                  <span class="trace-toggle-meta">
                                    {traceSummaryForMessage(message().id)}
                                  </span>
                                </span>
                                <span
                                  classList={{
                                    "assistant-progress-toggle-chevron": true,
                                    "is-collapsed": isTraceCollapsed(message().id),
                                  }}
                                  aria-hidden="true"
                                >
                                  ▾
                                </span>
                              </button>
                              <Show when={!isTraceCollapsed(message().id)}>
                                <div class="trace-drawer" id={`trace-drawer-${message().id}`}>
                                  <Suspense fallback={null}>
                                    <TraceDrawerContent
                                      traces={traceDrawerDataForMessage(message().id)}
                                      formatDuration={formatDuration}
                                      formatTraceStatus={formatTraceStatus}
                                      shortTraceId={shortTraceId}
                                    />
                                  </Suspense>
                                </div>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <Show when={hasAssistantAnswerCard(message())}>
                    <div class="assistant-answer-card">
                      <Show when={message().text?.trim()}>
                        {(() => {
                          const cites = () => citationsForMessage(message().id);
                          return (
                            <Show
                              when={effectiveMessageStatus(message()) === "streaming"}
                              fallback={
                                <LazyMarkdownBlock text={message().text} citations={cites()} />
                              }
                            >
                              <LazyMarkdownBlock
                                text={message().text}
                                streaming
                                citations={cites()}
                              />
                            </Show>
                          );
                        })()}
                      </Show>
                      <Show when={effectiveMessageStatus(message()) === "failed"}>
                        <div class="assistant-error-card" role="alert">
                          <div class="assistant-error-title">{assistantError(message()).title}</div>
                          <div class="assistant-error-summary">
                            {assistantError(message()).summary}
                          </div>
                          <p class="assistant-error-explanation">
                            {assistantError(message()).explanation}
                          </p>
                          <details class="assistant-error-details">
                            <summary>Technical details</summary>
                            <pre>{assistantError(message()).details}</pre>
                          </details>
                        </div>
                      </Show>
                      <Show when={hasAssistantStats(message())}>
                        <div class="msg-stats">
                          <Show when={thinkingTokens(message().id)}>
                            <span>
                              {formatTokenCount(thinkingTokens(message().id)!)} thinking tokens
                            </span>
                          </Show>
                          <Show when={getTotalTokens(message()) != null}>
                            <span>{formatTokenCount(getTotalTokens(message())!)} total tokens</span>
                          </Show>
                          <Show when={message().promptTokens != null}>
                            <span>{formatTokenCount(message().promptTokens!)} prompt</span>
                          </Show>
                          <Show when={message().completionTokens != null}>
                            <span>{formatTokenCount(message().completionTokens!)} output</span>
                          </Show>
                          <Show when={message().ttftMs != null}>
                            <span>TTFT {message().ttftMs}ms</span>
                          </Show>
                          <Show when={message().durationMs != null}>
                            <span>{formatDuration(message().durationMs!)}</span>
                          </Show>
                          <Show
                            when={
                              message().completionTokens != null &&
                              message().durationMs != null &&
                              message().durationMs! > 0
                            }
                          >
                            <span>
                              {(
                                (message().completionTokens! / message().durationMs!) *
                                1000
                              ).toFixed(1)}{" "}
                              tok/s
                            </span>
                          </Show>
                          <Show when={message().modelId}>
                            <span class="msg-stats-model">{message().modelId}</span>
                          </Show>
                          <button
                            type="button"
                            class="msg-action-btn fork-btn"
                            aria-label="Fork thread from here"
                            title="Fork thread from this message"
                            onClick={() =>
                              forkThreadAction({
                                sourceThreadId: message().threadId,
                                sourceMessageId: message().id,
                                workspaceId: activeWorkspace()?.id ?? message().threadId,
                              })
                            }
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <line x1="6" y1="3" x2="6" y2="15" />
                              <circle cx="18" cy="6" r="3" />
                              <circle cx="6" cy="21" r="3" />
                              <line x1="15" y1="9" x2="9" y2="17" />
                            </svg>
                          </button>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </article>
            );
          })()
        }
      </Show>
    );
  };

  const createNewWorkspace = async () => {
    createWorkspaceAction(`Workspace ${workspaces().length + 1}`, {
      defaultModelId: composerModelId() || models()?.models?.[0]?.id || "auto",
      defaultReasoningLevel: composerReasoningLevel(),
      defaultSearchMode: composerSearch(),
      defaultSearchLimit: composerSearchLimit(),
    });
  };

  const createNewThread = async () => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    ensureWorkspaceDraft({
      workspace,
      modelId: composerModelId() || workspace.defaultModelId || models()?.models?.[0]?.id || "auto",
      reasoningLevel: composerReasoningLevel(),
      search: composerSearch(),
      searchLimit: composerSearchLimit(),
    });
    activateWorkspaceDraftView(workspace.id);
    setSidebarOpen(false);
  };

  const deleteThread = async (threadId: string) => {
    archiveThreadAction(threadId);
  };

  const requestWorkspaceDelete = (workspaceId: string, workspaceName: string) => {
    if (workspaces().length <= 1) return;
    setWorkspaceDeleteTarget({ id: workspaceId, name: workspaceName });
  };

  const closeWorkspaceDeleteModal = () => {
    setWorkspaceDeleteTarget(null);
  };

  const confirmWorkspaceDelete = () => {
    const target = workspaceDeleteTarget();
    if (!target) return;
    if (editingWorkspaceId() === target.id) {
      setEditingWorkspaceId(null);
      setEditValue("");
    }
    archiveWorkspaceAction(target.id);
    setWorkspaceDeleteTarget(null);
  };

  // Inline rename helpers
  const startEditingThread = (threadId: string, currentTitle: string) => {
    setEditingThreadId(threadId);
    setEditValue(currentTitle);
  };

  const commitThreadRename = (threadId: string) => {
    const newTitle = editValue().trim();
    setEditingThreadId(null);
    if (!newTitle || newTitle === "") return;
    const row = threadsCollection.get(threadId);
    if (!row || row.title === newTitle) return;
    updateThreadAction({ ...row, title: newTitle, updatedAt: nowIso() });
  };

  const startEditingWorkspace = (workspaceId: string, currentName: string) => {
    setEditingWorkspaceId(workspaceId);
    setEditValue(currentName);
  };

  const commitWorkspaceRename = (workspaceId: string) => {
    const newName = editValue().trim();
    setEditingWorkspaceId(null);
    if (!newName || newName === "") return;
    const row = workspacesCollection.get(workspaceId);
    if (!row || row.name === newName) return;
    updateWorkspaceAction({ ...row, name: newName, updatedAt: nowIso() });
  };

  const saveSystemPrompt = () => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const row = workspacesCollection.get(workspace.id);
    if (!row) return;
    updateWorkspaceAction({
      ...row,
      systemPrompt: systemPromptDraft(),
      updatedAt: nowIso(),
    });
    setSettingsOpen(false);
  };

  const updateWorkspacePreferences = (
    changes: Partial<
      Pick<
        Workspace,
        | "defaultModelId"
        | "defaultReasoningLevel"
        | "defaultSearchMode"
        | "defaultSearchLimit"
        | "preferFreeSearch"
      >
    >,
  ) => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const current = workspacesCollection.get(workspace.id);
    updateWorkspaceAction({
      ...(current ?? workspace),
      ...changes,
      updatedAt: nowIso(),
    });
  };

  const updateAccountSettings = (changes: Partial<AccountSettings>) => {
    const settings = accountSettings();
    if (!settings) return;
    updateAccountSettingsAction({
      ...settings,
      ...changes,
      updatedAt: nowIso(),
    });
  };

  const currentActiveThread = () => {
    const thread = activeThread();
    return thread ? (threadsCollection.get(thread.id) ?? thread) : null;
  };

  const handleExpandReasoningSettingChange = (checked: boolean) => {
    setExpandReasoningByDefault(checked);
    updateAccountSettings({ expandReasoningByDefault: checked });
  };

  const handleShowTracesSettingChange = (checked: boolean) => {
    setShowTraces(checked);
    updateAccountSettings({ showTraces: checked });
  };

  const handlePreferFreeSearchSettingChange = (checked: boolean) => {
    updateWorkspacePreferences({ preferFreeSearch: checked });
  };

  const handleTitleGenerationModelChange = (modelId: string | null) => {
    const model = modelId ? (models()?.models ?? []).find((item) => item.id === modelId) : null;
    updateAccountSettings({
      titleGenerationModelId: modelId,
      titleGenerationModelInterleavedField: model?.interleaved?.field?.trim() || null,
    });
  };

  const handleModelChange = (modelId: string) => {
    const workspace = activeWorkspace();
    const thread = currentActiveThread();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        modelId,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("modelId", modelId);
      if (thread) {
        updateThreadAction({ ...thread, modelId, updatedAt: nowIso() });
      }
    }
    // Keep new threads aligned with the last deliberate model choice while
    // preserving explicit model overrides on existing threads.
    updateWorkspacePreferences({ defaultModelId: modelId });
  };

  const handleSearchChange = (search: boolean) => {
    const workspace = activeWorkspace();
    const thread = currentActiveThread();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        search,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("search", search);
      if (thread) {
        updateThreadAction({ ...thread, searchEnabled: search, updatedAt: nowIso() });
      }
    }
    updateWorkspacePreferences({ defaultSearchMode: search });
  };

  const handleSearchLimitChange = (value: number) => {
    const searchLimit = clampSearchesPerTurn(value);
    const workspace = activeWorkspace();
    const thread = currentActiveThread();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        search: true,
        searchLimit,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("search", true);
      setComposer("searchLimit", searchLimit);
      if (thread) {
        updateThreadAction({ ...thread, searchEnabled: true, searchLimit, updatedAt: nowIso() });
      }
    }
    updateWorkspacePreferences({ defaultSearchMode: true, defaultSearchLimit: searchLimit });
  };

  const handleReasoningChange = (reasoningLevel: ReasoningLevel) => {
    const workspace = activeWorkspace();
    const thread = currentActiveThread();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        reasoningLevel,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("reasoningLevel", reasoningLevel);
      // Save to current thread for per-thread persistence
      if (thread) {
        updateThreadAction({ ...thread, reasoningLevel, updatedAt: nowIso() });
      }
    }
    updateWorkspacePreferences({ defaultReasoningLevel: reasoningLevel });
  };

  const handleReasoningToggle = () => {
    handleReasoningChange(effectiveComposerReasoningLevel() === "off" ? "low" : "off");
  };

  const isSelectedThreadBusy = createMemo(() => {
    const thread = selectedConversationThread();
    return thread ? busyThreadIds().has(thread.id) : false;
  });

  /**
   * The assistant message currently streaming in the selected thread, if any.
   * Used to target the Stop button at the right message id.
   */
  const streamingAssistantMessageId = createMemo(() => {
    const thread = selectedConversationThread();
    if (!thread) return null;
    for (const id of messageIds()) {
      const msg = messageById(id);
      if (!msg || msg.role !== "assistant") continue;
      const status = effectiveMessageStatus(msg);
      if (status === "streaming" || status === "pending" || status === "queued") {
        return msg.id;
      }
    }
    return null;
  });

  const cancelActiveResponse = () => {
    const messageId = streamingAssistantMessageId();
    if (!messageId) return;
    cancelAssistantTurnAction(messageId);
  };

  const startEditingUserMessage = (msg: Message) => {
    if (isSelectedThreadBusy()) return;
    setEditingUserMessageId(msg.id);
    setEditingUserMessageText(msg.text);
  };

  const cancelEditingUserMessage = () => {
    setEditingUserMessageId(null);
    setEditingUserMessageText("");
  };

  const commitUserMessageEdit = (msg: Message) => {
    const thread = selectedConversationThread();
    const text = editingUserMessageText().trim();
    cancelEditingUserMessage();
    if (!thread || !text || text === msg.text.trim()) return;
    const modelId =
      msg.modelId || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id || "auto";
    const attachmentIds = userAttachments(msg.id)
      .filter((attachment) => attachment.status === "ready")
      .map((attachment) => attachment.id);
    editUserMessageAction({
      thread,
      sourceMessage: msg,
      text,
      modelId,
      modelInterleavedField: modelInterleavedFieldFor(modelId),
      reasoningLevel: msg.reasoningLevel ?? "off",
      search: Boolean(msg.searchEnabled),
      searchLimit: composerSearchLimit(),
      preferFreeSearch: effectivePreferFreeSearch(),
      attachmentIds,
    });
  };

  const retryMessage = (msg: Message) => {
    const thread = selectedConversationThread();
    if (!thread || !msg.text?.trim() || isSelectedThreadBusy()) return;
    const modelId =
      composerModelId() || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id || "auto";
    retryMessageAction({
      thread,
      userMessage: msg,
      modelId,
      modelInterleavedField: modelInterleavedFieldFor(modelId),
      reasoningLevel: effectiveComposerReasoningLevel(),
      search: composerSearch(),
      searchLimit: composerSearchLimit(),
      preferFreeSearch: effectivePreferFreeSearch(),
    });
  };

  const sendMessage = async () => {
    const thread = selectedConversationThread();
    const workspace = activeWorkspace();
    const draftMode = isDraftViewActive();
    debugLog("send", "attempt", {
      activeThread: thread,
      activeWorkspace: workspace,
      text: composerText().trim(),
      attachments: composerAttachments().length,
      sending: composer.sending,
      workspacesCount: workspaces().length,
      threadsCount: threads().length,
    });
    if (
      !thread ||
      !isConnected() ||
      isSelectedThreadBusy() ||
      (!composerText().trim() && composerAttachments().length === 0) ||
      composer.sending
    ) {
      debugLog("send", "blocked", {
        noThread: !thread,
        noConnection: !isConnected(),
        threadBusy: isSelectedThreadBusy(),
        noContent: !composerText().trim() && composerAttachments().length === 0,
        alreadySending: composer.sending,
      });
      return;
    }

    // Wait for any in-progress uploads before sending
    const uploading = composerAttachments().filter((a) => a.status === "uploading");
    if (uploading.length > 0) {
      setComposer("sending", true);
      const promises = uploading
        .map((a) => pendingUploads.get(a.localId))
        .filter((p): p is Promise<unknown> => !!p);
      await Promise.allSettled(promises);
    }

    setComposer("sending", true);
    try {
      const text = composerText().trim();
      const modelId =
        composerModelId() || workspace?.defaultModelId || models()?.models?.[0]?.id || "auto";
      const attachmentIds = composerAttachments()
        .filter((a) => {
          if (a.status !== "ready" || !a.attachmentId) return false;
          // If the model doesn't support images, skip image attachments
          // so the request doesn't fail. Text/file attachments still work.
          if (!selectedModelSupportsAttachments() && isImageMime(a.mimeType)) return false;
          return true;
        })
        .map((a) => a.attachmentId!);

      // Comparison mode: create multiple threads and fan out
      if (comparisonMode() && comparisonModelIds().length >= 2 && draftMode && workspace) {
        const selectedModelIds = comparisonModelIds();
        const allModels = models()?.models ?? [];
        const interleavedFields = selectedModelIds.map(
          (id) => allModels.find((m) => m.id === id)?.interleaved?.field?.trim() || null,
        );
        createComparisonAction({
          workspace,
          text,
          modelIds: selectedModelIds,
          modelInterleavedFields: interleavedFields,
          reasoningLevel: effectiveComposerReasoningLevel(),
          search: composerSearch(),
          searchLimit: composerSearchLimit(),
          preferFreeSearch: effectivePreferFreeSearch(),
          attachmentIds,
        });
        setComparisonMode(false);
        setComparisonModelIds([]);
      } else {
        sendMessageAction({
          thread,
          text,
          modelId,
          modelInterleavedField: modelInterleavedFieldFor(modelId),
          reasoningLevel: effectiveComposerReasoningLevel(),
          search: composerSearch(),
          searchLimit: composerSearchLimit(),
          preferFreeSearch: effectivePreferFreeSearch(),
          attachmentIds,
        });
      }
      for (const att of composerAttachments()) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      if (draftMode && workspace) {
        finalizeWorkspaceDraft(workspace.id);
        activateWorkspaceThreadView(workspace.id);
        setActiveThreadId(thread.id);
      } else {
        setComposer("text", "");
        setComposer("attachments", []);
      }
    } finally {
      setComposer("sending", false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const ComposerOptions = () => (
    <>
      <Show when={selectedModelSupportsReasoning()}>
        <label class="composer-reasoning-select" title="Reasoning level">
          <button
            type="button"
            classList={{
              "composer-action-btn": true,
              "is-active": effectiveComposerReasoningLevel() !== "off",
            }}
            title={
              effectiveComposerReasoningLevel() === "off"
                ? "Turn reasoning on"
                : "Turn reasoning off"
            }
            aria-label={
              effectiveComposerReasoningLevel() === "off"
                ? "Turn reasoning on"
                : "Turn reasoning off"
            }
            aria-pressed={effectiveComposerReasoningLevel() !== "off"}
            onClick={handleReasoningToggle}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 2a4.5 4.5 0 0 0-4.5 4.5c0 .9.27 1.75.73 2.46A4.5 4.5 0 0 0 8 17.5V19a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1.5a4.5 4.5 0 0 0-.23-8.54A4.5 4.5 0 0 0 16.5 6.5 4.5 4.5 0 0 0 12 2Z" />
              <path d="M12 2v19" />
              <path d="M9 7h.01" />
              <path d="M15 7h.01" />
            </svg>
          </button>
          <select
            value={composerReasoningLevel()}
            aria-label="Reasoning level"
            onChange={(event) =>
              handleReasoningChange(
                Schema.decodeUnknownSync(ReasoningLevelSchema)(event.currentTarget.value),
              )
            }
          >
            <For each={REASONING_OPTIONS}>
              {(option) => <option value={option.value}>{option.label}</option>}
            </For>
          </select>
        </label>
      </Show>
    </>
  );

  return (
    <>
      <Show when={session()}>
        <div class="shell">
          <Show when={sidebarOpen()}>
            <div class="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
          </Show>
          <aside classList={{ sidebar: true, open: sidebarOpen() }}>
            <div class="sidebar-top">
              <div class="brand">
                <span class="brand-mark">shedflare</span>
                <div style="min-width:0">
                  <h1>shedflare.chat</h1>
                  <p class="brand-email">{session()?.user?.email}</p>
                </div>
              </div>
              <div class="sidebar-actions">
                <button class="btn btn-primary" onClick={createNewThread}>
                  + Chat
                </button>
                <button class="btn" onClick={createNewWorkspace}>
                  + Space
                </button>
              </div>
            </div>

            <div class="sidebar-scroll">
              <p class="section-label">Workspaces</p>
              <For each={workspaces()}>
                {(workspace) => (
                  <div
                    classList={{
                      "nav-item": true,
                      active: workspace.id === activeWorkspace()?.id,
                    }}
                    onClick={() => {
                      if (editingWorkspaceId() === workspace.id) return;
                      setActiveWorkspaceId(workspace.id);
                      // The active thread resolves automatically from the
                      // per-workspace store; fall back to the most recent thread
                      // if no selection is recorded for this workspace.
                      setSidebarOpen(false);
                    }}
                  >
                    <Show
                      when={editingWorkspaceId() === workspace.id}
                      fallback={
                        <div class="nav-item-row">
                          <strong>{workspace.name}</strong>
                          <div class="nav-item-actions">
                            <button
                              class="action-btn"
                              title="Rename workspace"
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditingWorkspace(workspace.id, workspace.name);
                              }}
                            >
                              ✎
                            </button>
                            <Show when={workspaces().length > 1}>
                              <button
                                class="action-btn action-btn-danger"
                                title="Delete workspace"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestWorkspaceDelete(workspace.id, workspace.name);
                                }}
                              >
                                ×
                              </button>
                            </Show>
                          </div>
                        </div>
                      }
                    >
                      <input
                        class="inline-edit"
                        value={editValue()}
                        onInput={(e) => setEditValue(e.currentTarget.value)}
                        onBlur={() => commitWorkspaceRename(workspace.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitWorkspaceRename(workspace.id);
                          if (e.key === "Escape") setEditingWorkspaceId(null);
                        }}
                        ref={(el) => requestAnimationFrame(() => el.focus())}
                      />
                    </Show>
                  </div>
                )}
              </For>

              <div class="sidebar-section-divider" />

              <div class="thread-filter-wrap">
                <input
                  class="thread-filter"
                  type="search"
                  placeholder="Search threads"
                  value={threadFilter()}
                  onInput={(e) => setThreadFilter(e.currentTarget.value)}
                />
              </div>

              <Show
                when={filteredThreads().length > 0}
                fallback={
                  <Show when={threadFilter().trim()}>
                    <div class="sidebar-empty">No matching threads</div>
                  </Show>
                }
              >
                <For each={groupThreadsByDate(filteredThreads())}>
                  {(group) => (
                    <>
                      <p class="section-label">{group.label}</p>
                      <For each={group.threads}>
                        {(thread) => (
                          <div
                            title={thread.title}
                            classList={{
                              "nav-item": true,
                              active: !isDraftViewActive() && thread.id === activeThread()?.id,
                            }}
                            onClick={() => {
                              if (editingThreadId() === thread.id) return;
                              activateWorkspaceThreadView(thread.workspaceId);
                              setActiveThreadId(thread.id);
                              setSettingsOpen(false);
                              setSidebarOpen(false);
                            }}
                          >
                            <Show
                              when={editingThreadId() === thread.id}
                              fallback={
                                <div class="nav-item-row">
                                  <Show when={busyThreadIds().has(thread.id)}>
                                    <span class="thread-spinner" />
                                  </Show>
                                  <Show when={thread.forkedFromThreadId}>
                                    <span
                                      class="fork-badge"
                                      title="Forked from another thread"
                                      aria-label="Forked thread"
                                    >
                                      ⑂
                                    </span>
                                  </Show>
                                  <Show when={thread.threadType === "comparison"}>
                                    <span
                                      class="comparison-badge"
                                      title="Comparison thread"
                                      aria-label="Comparison thread"
                                    >
                                      ⧉
                                    </span>
                                  </Show>
                                  <strong>{thread.title}</strong>
                                  <div class="nav-item-actions">
                                    <span
                                      class="action-btn"
                                      title="Rename thread"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        startEditingThread(thread.id, thread.title);
                                      }}
                                    >
                                      ✎
                                    </span>
                                    <span
                                      class="action-btn action-btn-danger"
                                      title="Delete thread"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void deleteThread(thread.id);
                                      }}
                                    >
                                      ×
                                    </span>
                                  </div>
                                </div>
                              }
                            >
                              <input
                                class="inline-edit"
                                value={editValue()}
                                onInput={(e) => setEditValue(e.currentTarget.value)}
                                onBlur={() => commitThreadRename(thread.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitThreadRename(thread.id);
                                  if (e.key === "Escape") setEditingThreadId(null);
                                }}
                                ref={(el) => requestAnimationFrame(() => el.focus())}
                              />
                            </Show>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>
              <Show when={hasThreadHistoryButton()}>
                <button
                  class="load-older-threads-btn"
                  disabled={currentThreadHistoryState().loading}
                  onClick={() => void handleLoadOlderThreads()}
                >
                  {currentThreadHistoryState().loading
                    ? "Loading older threads..."
                    : "Load older threads"}
                </button>
              </Show>
              <Show when={currentThreadHistoryState().error}>
                {(error) => <div class="sidebar-error">{error()}</div>}
              </Show>
            </div>

            <div class="sidebar-footer">
              <div class="sidebar-footer-controls">
                <button
                  classList={{ "theme-btn": true, active: settingsOpen() }}
                  onClick={() => {
                    setSettingsOpen(!settingsOpen());
                    setSidebarOpen(false);
                  }}
                  title="Settings"
                >
                  Settings
                </button>
              </div>
              <div class="sidebar-version" title={BUILD_INFO.tooltip}>
                {BUILD_INFO.label}
              </div>
            </div>
          </aside>

          <main class="main-pane">
            <Show
              when={!settingsOpen()}
              fallback={
                <Suspense fallback={null}>
                  <SettingsPage
                    workspaceName={activeWorkspace()?.name}
                    systemPromptDraft={systemPromptDraft()}
                    onSystemPromptInput={setSystemPromptDraft}
                    onBack={() => setSettingsOpen(false)}
                    onCancel={() => setSettingsOpen(false)}
                    onSave={saveSystemPrompt}
                    expandReasoningByDefault={effectiveExpandReasoningByDefault()}
                    onExpandReasoningChange={handleExpandReasoningSettingChange}
                    preferFreeSearch={effectivePreferFreeSearch()}
                    onPreferFreeSearchChange={handlePreferFreeSearchSettingChange}
                    exaApiKeyConfigured={exaApiKeyConfigured()}
                    showTraces={effectiveShowTraces()}
                    onShowTracesChange={handleShowTracesSettingChange}
                    models={models()?.models ?? []}
                    titleGenerationModelId={accountSettings()?.titleGenerationModelId ?? null}
                    onTitleGenerationModelChange={handleTitleGenerationModelChange}
                    onResetAllData={() => {
                      if (confirm("Delete ALL data? This cannot be undone.")) {
                        resetAllData();
                      }
                    }}
                    archivedThreads={archivedThreads()}
                    onDeleteThreadPermanently={(threadId) => {
                      deleteThreadAction(threadId);
                    }}
                  />
                </Suspense>
              }
            >
              <Show when={!headerVisible()}>
                <button class="menu-btn-floating" onClick={() => setSidebarOpen(true)} title="Menu">
                  ☰
                </button>
              </Show>
              <header class="thread-header" classList={{ "is-hidden": !headerVisible() }}>
                <button class="menu-btn" onClick={() => setSidebarOpen(true)}>
                  ☰
                </button>
                <span class="workspace-label">{activeWorkspace()?.name}</span>
                <h2>{selectedConversationThread()?.title ?? "New Chat"}</h2>
                <Show when={activeWorkspace()?.systemPrompt}>
                  <span class="system-prompt" title={activeWorkspace()?.systemPrompt}>
                    {activeWorkspace()?.systemPrompt}
                  </span>
                </Show>
              </header>

              <Show
                when={isComparisonThread()}
                fallback={
                  <div class="timeline-shell">
                    <Show when={userMessageMarkers().length > 1}>
                      <nav class="message-minimap" aria-label="User messages in this thread">
                        <For each={userMessageMarkers()}>
                          {(marker) => (
                            <button
                              type="button"
                              class="message-minimap-marker"
                              classList={{
                                "is-active": activeMinimapMarkerId() === marker.id,
                              }}
                              aria-label={`Scroll to: ${marker.label}`}
                              aria-current={
                                activeMinimapMarkerId() === marker.id ? "location" : undefined
                              }
                              onClick={() => scrollToMessage(marker.id)}
                              onMouseEnter={(event) =>
                                showMinimapCard(marker.id, event.currentTarget)
                              }
                              onMouseLeave={() => hideMinimapCard(marker.id)}
                              onFocus={(event) => showMinimapCard(marker.id, event.currentTarget)}
                              onBlur={() => hideMinimapCard(marker.id)}
                            >
                              <span class="message-minimap-tick" aria-hidden="true" />
                            </button>
                          )}
                        </For>
                      </nav>
                      <Show when={hoveredMinimapCard()}>
                        {(card) => (
                          <div
                            class="message-minimap-card is-visible"
                            style={{
                              top: `${card().top}px`,
                              left: `${card().left}px`,
                            }}
                            role="tooltip"
                          >
                            <strong>{card().label}</strong>
                            <span>{card().preview}</span>
                          </div>
                        )}
                      </Show>
                    </Show>
                    <section
                      class="timeline"
                      classList={{ "is-scrollable-away": showScrollBtn() }}
                      ref={timelineRef}
                      onScroll={handleTimelineScroll}
                    >
                      <Show
                        when={!selectedThreadDetailState()?.loading}
                        fallback={
                          <div class="chat-marker chat-marker-separator timeline-loading">
                            <span>Loading thread history...</span>
                          </div>
                        }
                      >
                        <For each={messageIds()}>{renderMessage}</For>
                      </Show>
                      <Show when={selectedThreadDetailState()?.error}>
                        {(error) => (
                          <div class="chat-marker chat-marker-border timeline-error">{error()}</div>
                        )}
                      </Show>
                      <div class="timeline-anchor" classList={{ active: isNearBottom() }} />
                    </section>
                  </div>
                }
              >
                <div class="comparison-view">
                  <div class="comparison-tabs">
                    <For each={comparisonSiblingThreads()}>
                      {(sibling, index) => (
                        <button
                          classList={{
                            "comparison-tab": true,
                            "is-active": activeComparisonTab() === index(),
                          }}
                          onClick={() => {
                            setActiveComparisonTab(index());
                            setActiveThreadId(sibling.id);
                          }}
                        >
                          {sibling.modelId ?? `Model ${index() + 1}`}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="comparison-columns">
                    <For each={comparisonSiblingThreads()}>
                      {(sibling, index) => {
                        const siblingMessageIds = createMemo(() =>
                          resolveThreadMessagePath(
                            allMessages().filter((m) => m.threadId === sibling.id),
                            sibling.headMessageId ?? null,
                          ).map((m) => m.id),
                        );
                        return (
                          <div
                            classList={{
                              "comparison-column": true,
                              "is-active": activeComparisonTab() === index(),
                            }}
                          >
                            <div class="comparison-column-header">
                              <span class="comparison-column-model">
                                {sibling.modelId ?? `Model ${index() + 1}`}
                              </span>
                              <button
                                type="button"
                                class="msg-action-btn fork-btn"
                                aria-label="Fork this comparison thread"
                                title="Fork as standalone thread"
                                onClick={() =>
                                  forkThreadAction({
                                    sourceThreadId: sibling.id,
                                    sourceMessageId: sibling.headMessageId ?? "",
                                    workspaceId: activeWorkspace()?.id ?? sibling.id,
                                  })
                                }
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="2"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  aria-hidden="true"
                                >
                                  <line x1="6" y1="3" x2="6" y2="15" />
                                  <circle cx="18" cy="6" r="3" />
                                  <circle cx="6" cy="21" r="3" />
                                  <line x1="15" y1="9" x2="9" y2="17" />
                                </svg>
                              </button>
                            </div>
                            <div class="comparison-column-timeline">
                              <For each={siblingMessageIds()}>{renderMessage}</For>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={!isConnected()}>
                <div class="connection-banner">Connecting…</div>
              </Show>

              <footer
                class="composer"
                classList={{ "composer-dragging": isDragging() }}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <button
                  type="button"
                  class="scroll-to-bottom"
                  classList={{ "is-active": showScrollBtn() }}
                  disabled={!showScrollBtn()}
                  aria-hidden={!showScrollBtn()}
                  tabIndex={showScrollBtn() ? 0 : -1}
                  onClick={scrollToBottom}
                  title="Scroll to bottom"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M8 3v10M4 9l4 4 4-4"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span class="sr-only">Scroll to bottom</span>
                </button>

                <Show when={imageAttachmentsWarning()}>
                  <div class="composer-warning">
                    <span class="composer-warning-icon">⚠</span>
                    <span>
                      {selectedModel()?.name ?? "This model"} doesn't support image uploads.{" "}
                      <button
                        type="button"
                        class="composer-warning-link"
                        onClick={() => {
                          const compatible = (models()?.models ?? []).find(
                            (m) => m.attachment && m.id !== composerModelId(),
                          );
                          if (compatible) handleModelChange(compatible.id);
                        }}
                      >
                        Switch to a compatible model
                      </button>{" "}
                      or remove the images.
                    </span>
                  </div>
                </Show>
                <Show when={composerAttachments().length > 0}>
                  <div class="attachment-strip">
                    <For each={composerAttachments()}>
                      {(att) => (
                        <div
                          class="attachment-card composer-attachment-card"
                          classList={{
                            "attachment-card-uploading": att.status === "uploading",
                            "attachment-card-failed": att.status === "failed",
                          }}
                        >
                          <Show
                            when={att.previewUrl}
                            fallback={
                              <span class="attachment-media">
                                <span class="attachment-ext">
                                  {att.fileName.split(".").pop()?.toUpperCase().slice(0, 4) ||
                                    "FILE"}
                                </span>
                              </span>
                            }
                          >
                            <span class="attachment-media attachment-media-image">
                              <img src={att.previewUrl} alt="" />
                            </span>
                          </Show>
                          <span class="attachment-content">
                            <span class="attachment-title">{att.fileName}</span>
                            <span class="attachment-description">
                              {att.status === "uploading"
                                ? "Uploading"
                                : att.status === "failed"
                                  ? "Upload failed"
                                  : "Ready"}
                            </span>
                          </span>
                          <Show when={att.status === "uploading"}>
                            <span class="attachment-spinner" />
                          </Show>
                          <button
                            type="button"
                            class="attachment-action"
                            onClick={() => removeAttachment(att.localId)}
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <textarea
                  ref={composerInputRef!}
                  class="composer-input"
                  value={composerText()}
                  onInput={(event) => {
                    setComposerTextValue(event.currentTarget.value);
                    const el = event.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 160) + "px";
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    composerAttachments().length > 0 ? "Add a message (optional)..." : "Message..."
                  }
                  rows={1}
                />
                <div class="composer-row">
                  <input
                    ref={fileInputRef!}
                    type="file"
                    multiple
                    accept="image/*,text/*,.json,.csv,.pdf"
                    style={{ display: "none" }}
                    onChange={(e) => handleFileSelect(e.currentTarget.files)}
                  />
                  <div class="composer-context-controls">
                    <Show
                      when={comparisonMode() && isDraftViewActive()}
                      fallback={
                        <select
                          class="composer-model"
                          value={composerModelId()}
                          onChange={(event) => handleModelChange(event.currentTarget.value)}
                        >
                          <Show when={composerModelId() && !selectedModel()}>
                            <option value={composerModelId()}>
                              {composerModelId()} (unavailable)
                            </option>
                          </Show>
                          <For each={models()?.models ?? []}>
                            {(model) => <option value={model.id}>{model.name}</option>}
                          </For>
                        </select>
                      }
                    >
                      <div class="comparison-model-picker">
                        <For each={models()?.models ?? []}>
                          {(model) => (
                            <label
                              classList={{
                                "comparison-model-chip": true,
                                "is-selected": comparisonModelIds().includes(model.id),
                                "is-disabled":
                                  !comparisonModelIds().includes(model.id) &&
                                  comparisonModelIds().length >= 3,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={comparisonModelIds().includes(model.id)}
                                disabled={
                                  !comparisonModelIds().includes(model.id) &&
                                  comparisonModelIds().length >= 3
                                }
                                onChange={() => toggleComparisonModel(model.id)}
                              />
                              {model.name}
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={isDraftViewActive()}>
                      <button
                        type="button"
                        class="composer-action-btn comparison-toggle"
                        classList={{ "is-active": comparisonMode() }}
                        title={
                          comparisonMode()
                            ? "Disable comparison mode"
                            : "Compare 2-3 models side-by-side"
                        }
                        onClick={() => {
                          setComparisonMode(!comparisonMode());
                          if (!comparisonMode()) {
                            setComparisonModelIds(
                              composerModelId()
                                ? [composerModelId()]
                                : [models()?.models?.[0]?.id ?? ""].filter(Boolean),
                            );
                          } else {
                            setComparisonModelIds([]);
                          }
                        }}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <rect x="3" y="3" width="7" height="18" rx="1" />
                          <rect x="14" y="3" width="7" height="18" rx="1" />
                        </svg>
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="composer-action-btn"
                      classList={{ "is-active": composerSearch() }}
                      title={
                        composerSearch()
                          ? `Disable search (up to ${composerSearchLimit()} searches)`
                          : `Enable search (up to ${composerSearchLimit()} searches)`
                      }
                      onClick={() => handleSearchChange(!composerSearch())}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                    </button>
                    <select
                      class="composer-search-limit"
                      value={composerSearchLimit()}
                      aria-label="Searches per response"
                      title={`Allow up to ${composerSearchLimit()} searches per response`}
                      onChange={(event) =>
                        handleSearchLimitChange(Number(event.currentTarget.value))
                      }
                    >
                      <For each={SEARCHES_PER_TURN_OPTIONS}>
                        {(value) => <option value={value}>{value}</option>}
                      </For>
                    </select>
                    <ComposerOptions />
                  </div>
                  <div class="composer-actions">
                    <button
                      class="attach-btn"
                      onClick={() => fileInputRef?.click()}
                      title="Attach files"
                    >
                      +
                    </button>
                    <Show
                      when={isSelectedThreadBusy() && streamingAssistantMessageId()}
                      fallback={
                        <button
                          type="button"
                          class="composer-send-btn"
                          disabled={!isConnected() || composer.sending}
                          onClick={sendMessage}
                          title={
                            !isConnected() ? "Connecting…" : composer.sending ? "Sending…" : "Send"
                          }
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <line x1="22" y1="2" x2="11" y2="13" />
                            <polygon points="22 2 15 22 11 13 2 9 22 2" />
                          </svg>
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="composer-stop-btn"
                        aria-label="Stop response"
                        title="Stop response"
                        onClick={cancelActiveResponse}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          stroke="none"
                        >
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                      </button>
                    </Show>
                  </div>
                </div>
              </footer>
            </Show>
          </main>
          <Show when={workspaceDeleteTarget()}>
            {(target) => (
              <div class="modal-backdrop" onClick={closeWorkspaceDeleteModal}>
                <div
                  class="modal-card"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="workspace-delete-title"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 id="workspace-delete-title">Delete workspace?</h3>
                  <p class="modal-copy">
                    <strong>{target().name}</strong> will be removed from your sidebar. This action
                    cannot be undone.
                  </p>
                  <div class="modal-actions">
                    <button class="btn" onClick={closeWorkspaceDeleteModal}>
                      Cancel
                    </button>
                    <button class="btn btn-danger" onClick={confirmWorkspaceDelete}>
                      Delete workspace
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <Show when={bootstrap.loading && !hintEmail}>
        <div class="app-loader">
          <div class="session-overlay-card">
            <div class="session-spinner" />
            <h1 class="session-title">Shedflare Chat</h1>
            <p>Checking session…</p>
          </div>
        </div>
      </Show>

      <Show when={!bootstrap.loading && !session()}>
        <div class="session-overlay">
          <div class="session-overlay-card">
            <p class="eyebrow" style="margin-bottom:4px">
              Personal deployment
            </p>
            <h1 class="session-title">shedflare chat</h1>
            <p>Sign in to continue.</p>
            <p class="app-version" title={BUILD_INFO.tooltip}>
              {BUILD_INFO.label}
            </p>
            <a
              class="btn btn-primary"
              href="/api/auth/login"
              onClick={(event) => {
                event.preventDefault();
                window.location.assign("/api/auth/login");
              }}
              style="text-align:center;text-decoration:none;margin-top:4px"
            >
              Sign in with Google
            </a>
          </div>
        </div>
      </Show>
    </>
  );
}
