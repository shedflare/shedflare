/* oxlint-disable anti-slop */
import { createEffect, createMemo, createResource, createSignal, For, Show, lazy, Suspense, onCleanup, onMount } from "solid-js";
import { fetchServerSentEvents, useChat, indexedDBPersistence } from "@tanstack/ai-solid";
import { clearAuthHint, readAuthHint } from "@shedflare/auth-client/client";
import { ensureThemeFont } from "../lib/theme-fonts";
import { BUILD_INFO } from "../lib/build-info";
import * as Schema from "effect/Schema";

const Markdown = lazy(() => import("../components/Markdown"));

type SessionPayload = { user?: { email?: string } };
type BootstrapPayload = { session: SessionPayload | null; exaApiKeyConfigured: boolean };
type ModelsPayload = {
  models: Array<{
    id: string;
    name: string;
    attachment: boolean;
    reasoning: boolean;
    toolCall: boolean;
    interleaved: { field: string | null } | null;
    family: string;
    context: number | null;
    output: number | null;
  }>;
};

const SessionPayloadSchema = Schema.Struct({ user: Schema.optional(Schema.Struct({ email: Schema.optional(Schema.String) })) });
const BootstrapPayloadSchema = Schema.Struct({ session: Schema.NullOr(SessionPayloadSchema), exaApiKeyConfigured: Schema.optional(Schema.Boolean) });
const ModelPayloadSchema = Schema.Struct({
  id: Schema.String, name: Schema.String, attachment: Schema.Boolean, reasoning: Schema.Boolean, toolCall: Schema.Boolean,
  interleaved: Schema.NullOr(Schema.Struct({ field: Schema.NullOr(Schema.String) })), family: Schema.String, context: Schema.NullOr(Schema.Number), output: Schema.NullOr(Schema.Number),
});
const ModelsPayloadSchema = Schema.Struct({ models: Schema.Array(ModelPayloadSchema) });

function decodeBootstrap(v: unknown): BootstrapPayload {
  const raw = Schema.decodeUnknownSync(BootstrapPayloadSchema)(v) as { session: SessionPayload | null; exaApiKeyConfigured?: boolean };
  return { session: raw.session, exaApiKeyConfigured: raw.exaApiKeyConfigured ?? false };
}
function decodeModels(v: unknown): ModelsPayload {
  const p = Schema.decodeUnknownSync(ModelsPayloadSchema)(v) as ModelsPayload;
  return { models: p.models.map(m => ({ ...m, interleaved: m.interleaved ? { ...m.interleaved } : null })) };
}

const fetchBootstrap = async () => {
  const r = await fetch("/api/bootstrap");
  if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
  const p = decodeBootstrap(await r.json());
  const url = new URL(window.location.href);
  if (!p.session) {
    clearAuthHint();
    if (url.searchParams.get("error") !== "no_session") window.location.replace("/api/auth/login?auto=1");
  }
  return p;
};
const fetchModels = async (hasSession: boolean) => {
  if (!hasSession) return null;
  const r = await fetch("/api/models");
  if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
  return decodeModels(await r.json());
};

function getInitialTheme(): "night" {
  return "night";
}

// --- One layer above TanStack persistence: workspaces group threads ---
type WorkspaceSummary = { id: string; name: string; updatedAt: string };
type ThreadSummary = { id: string; title: string; workspaceId: string; updatedAt: string };
const WORKSPACES_KEY = "shedflare.headless.workspaces";
const THREADS_KEY = "shedflare.headless.threads";
const ACTIVE_WS_KEY = "shedflare.headless.activeWorkspaceId";
const ACTIVE_THREAD_KEY = "shedflare.headless.activeThreadId";
function loadWorkspaces(): WorkspaceSummary[] {
  try { const raw = localStorage.getItem(WORKSPACES_KEY); return raw ? JSON.parse(raw) as WorkspaceSummary[] : []; } catch { return []; }
}
function saveWorkspaces(list: WorkspaceSummary[]) { try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list)); } catch {} }
function loadThreads(): ThreadSummary[] {
  try { const raw = localStorage.getItem(THREADS_KEY); return raw ? JSON.parse(raw) as ThreadSummary[] : []; } catch { return []; }
}
function saveThreads(list: ThreadSummary[]) { try { localStorage.setItem(THREADS_KEY, JSON.stringify(list)); } catch {} }
function loadActiveWs(): string | null { try { return localStorage.getItem(ACTIVE_WS_KEY); } catch { return null; } }
function loadActiveId(): string | null { try { return localStorage.getItem(ACTIVE_THREAD_KEY); } catch { return null; } }
function saveActiveWs(id: string) { try { localStorage.setItem(ACTIVE_WS_KEY, id); } catch {} }
function saveActiveId(id: string) { try { localStorage.setItem(ACTIVE_THREAD_KEY, id); } catch {} }

export default function Home() {
  const [bootstrap] = createResource(fetchBootstrap);
  const hintEmail = readAuthHint();
  const session = createMemo(() => bootstrap.loading && hintEmail ? { user: { email: hintEmail } } : (bootstrap()?.session ?? null));
  const [modelsResource] = createResource(() => Boolean(session()), fetchModels);
  const models = createMemo(() => modelsResource() ?? null);

  // theme
  const [theme] = createSignal<"night">(getInitialTheme());
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", theme());
    ensureThemeFont(theme());
  });

  // sidebar workspaces + threads (one layer above TanStack ai_threads)
  const initialWorkspaces = loadWorkspaces();
  const defaultWsId = `ws_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const [workspaces, setWorkspaces] = createSignal<WorkspaceSummary[]>(
    initialWorkspaces.length ? initialWorkspaces : [{ id: defaultWsId, name: "Personal", updatedAt: new Date().toISOString() }],
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>(loadActiveWs() ?? workspaces()[0].id);
  const activeWorkspace = createMemo(() => workspaces().find(w => w.id === activeWorkspaceId()) ?? workspaces()[0]!);

  const initialThreads = loadThreads();
  const migratedThreads = initialThreads.map(t =>
    // SAFETY: old threads pre-workspace migration have no workspaceId – attach to active workspace
    (t as unknown as { workspaceId?: string }).workspaceId ? t : { ...t, workspaceId: activeWorkspaceId() },
  );
  const initialActive = loadActiveId() ?? migratedThreads.find(t => t.workspaceId === activeWorkspaceId())?.id ?? `thd_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const [threads, setThreads] = createSignal<ThreadSummary[]>(
    migratedThreads.length ? migratedThreads : [{ id: initialActive, title: "New Chat", workspaceId: activeWorkspaceId(), updatedAt: new Date().toISOString() }],
  );
  const [activeThreadId, setActiveThreadId] = createSignal<string>(initialActive);
  const activeThread = createMemo(() => threads().find(t => t.id === activeThreadId()) ?? threads().find(t => t.workspaceId === activeWorkspaceId()) ?? threads()[0]!);

  // persist workspaces/threads
  createEffect(() => { saveWorkspaces(workspaces()); });
  createEffect(() => { saveActiveWs(activeWorkspaceId()); });
  createEffect(() => { saveThreads(threads()); });
  createEffect(() => { saveActiveId(activeThreadId()); });

  // ensure active exists
  createEffect(() => {
    if (!threads().some(t => t.id === activeThreadId())) {
      const first = threads()[0];
      if (first) setActiveThreadId(first.id);
    }
  });

  // composer controls (headless forwardedProps)
  const [composerText, setComposerText] = createSignal("");
  const [modelId, setModelId] = createSignal<string>("");
  const [reasoningLevel, setReasoningLevel] = createSignal<"off"|"low"|"medium"|"high">("off");
  const [searchEnabled, setSearchEnabled] = createSignal(false);

  // hydrate modelId from catalog
  createEffect(() => {
    const list = models()?.models ?? [];
    if (!list.length) return;
    const cur = modelId();
    if (cur && list.some(m => m.id === cur)) return;
    // prefer first model or auto-like
    const fallback = list.find(m => m.id.includes("auto"))?.id ?? list[0].id;
    setModelId(fallback);
  });

  const selectedModel = createMemo(() => models()?.models.find(m => m.id === modelId()) ?? null);
  const supportsReasoning = createMemo(() => Boolean(selectedModel()?.reasoning));

  // create chat client per thread (headless)
  // We use a wrapper component ChatPane keyed by threadId so useChat remounts cleanly.
  const [threadFilter, setThreadFilter] = createSignal("");

  const filteredThreads = createMemo(() => {
    const q = threadFilter().trim().toLowerCase();
    const ws = activeWorkspaceId();
    const inWs = threads().filter(t => t.workspaceId === ws);
    if (!q) return inWs;
    return inWs.filter(t => t.title.toLowerCase().includes(q));
  });

  function createWorkspace() {
    const id = `ws_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const now = new Date().toISOString();
    setWorkspaces(prev => [{ id, name: `Workspace ${prev.length + 1}`, updatedAt: now }, ...prev]);
    setActiveWorkspaceId(id);
    // auto-create first thread in new workspace
    const tid = `thd_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    setThreads(prev => [{ id: tid, title: "New Chat", workspaceId: id, updatedAt: now }, ...prev]);
    setActiveThreadId(tid);
  }

  function deleteWorkspace(id: string) {
    if (workspaces().length <= 1) return;
    const nextWs = workspaces().filter(w => w.id !== id);
    setWorkspaces(nextWs);
    const remainingThreads = threads().filter(t => t.workspaceId !== id);
    const nextThreads = remainingThreads.length ? remainingThreads : [{ id: `thd_${crypto.randomUUID().replace(/-/g, "").slice(0,12)}`, title: "New Chat", workspaceId: nextWs[0].id, updatedAt: new Date().toISOString() }];
    setThreads(nextThreads);
    if (activeWorkspaceId() === id) {
      setActiveWorkspaceId(nextWs[0].id);
      setActiveThreadId(nextThreads.find(t => t.workspaceId === nextWs[0].id)?.id ?? nextThreads[0].id);
    }
  }

  function createNewThread() {
    const id = `thd_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();
    setThreads(prev => [{ id, title: "New Chat", workspaceId: activeWorkspaceId(), updatedAt: now }, ...prev]);
    setActiveThreadId(id);
  }

  function deleteThread(id: string) {
    const ws = activeWorkspaceId();
    const inWs = threads().filter(t => t.workspaceId === ws);
    const next = threads().filter(t => t.id !== id);
    const fallback = next.find(t => t.workspaceId === ws) ?? { id: `thd_${crypto.randomUUID().replace(/-/g, "").slice(0,12)}`, title: "New Chat", workspaceId: ws, updatedAt: new Date().toISOString() };
    const finalNext = inWs.length <= 1 ? [...next, fallback].filter((v, i, a) => a.findIndex(x => x.id === v.id) === i) : next;
    setThreads(finalNext);
    if (activeThreadId() === id) setActiveThreadId(fallback.id);
  }

  const bootstrapLoading = createMemo(() => bootstrap.loading && !hintEmail);
  // eslint-disable-next-line no-unassigned-vars
  let timelineRef: HTMLDivElement | undefined;
  let composerRef: HTMLTextAreaElement | undefined;

  // auto-resize composer
  createEffect(() => {
    composerText();
    const el = composerRef;
    if (!el) return;
    requestAnimationFrame(() => { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; });
  });

  return (
    <Show when={!bootstrapLoading()} fallback={<div class="app-loader"><div class="session-spinner" /></div>}>
      <Show when={session()} fallback={
        <div class="session-overlay">
          <div class="session-overlay-card">
            <div class="session-spinner" />
            <h2 class="session-title">Checking session…</h2>
            <p>Redirecting to login.</p>
          </div>
        </div>
      }>
        <div class="shell" data-theme="night">
          {/* Sidebar – branded, keeps app.css. Workspaces = one layer above ai_threads */}
          <aside class="sidebar">
            <div class="sidebar-top">
              <div class="brand">
                <div class="brand-mark">SF</div>
                <div>
                  <h1>shedflare chat</h1>
                  <div class="brand-email">{session()?.user?.email ?? ""}</div>
                </div>
              </div>
              <div class="sidebar-actions">
                <button class="btn" onClick={createWorkspace} title="New workspace">+ Ws</button>
                <button class="btn btn-primary" onClick={createNewThread}>New chat</button>
              </div>
            </div>
            <div class="thread-filter-wrap" style={{ display: "flex", gap: "6px" }}>
              <select class="thread-filter" style={{ flex: 1 }} value={activeWorkspaceId()} onChange={e => {
                const id = e.currentTarget.value;
                setActiveWorkspaceId(id);
                const first = threads().find(t => t.workspaceId === id);
                if (first) setActiveThreadId(first.id);
              }}>
                <For each={workspaces()}>{w => <option value={w.id}>{w.name}</option>}</For>
              </select>
              <button class="action-btn action-btn-danger" title="Delete workspace" onClick={() => deleteWorkspace(activeWorkspaceId())}>×</button>
            </div>
            <div class="thread-filter-wrap">
              <input class="thread-filter" placeholder="Filter chats…" value={threadFilter()} onInput={e => setThreadFilter(e.currentTarget.value)} />
            </div>
            <div class="sidebar-scroll">
              <div class="section-label">{activeWorkspace()?.name ?? "Chats"} • {filteredThreads().length}</div>
              <For each={filteredThreads()}>
                {t => (
                  <div class={`nav-item ${t.id === activeThreadId() ? "active" : ""}`} role="button" tabIndex={0} onClick={() => setActiveThreadId(t.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveThreadId(t.id); } }}>
                    <div class="nav-item-row">
                      <strong>{t.title}</strong>
                      <span class="fork-badge">{new Date(t.updatedAt).toLocaleDateString()}</span>
                    </div>
                    <div class="nav-item-actions">
                      <button class="action-btn action-btn-danger" onClick={e => { e.stopPropagation(); deleteThread(t.id); }}>×</button>
                    </div>
                  </div>
                )}
              </For>
              <Show when={filteredThreads().length === 0}><div class="sidebar-empty">No chats match.</div></Show>
            </div>
            <div class="sidebar-footer">
              <div class="sidebar-version">v{BUILD_INFO.version}</div>
              <div class="sidebar-footer-controls">
                <button class="theme-btn active">night</button>
                <button class="btn" onClick={() => window.location.href = "/api/auth/logout"}>Logout</button>
              </div>
            </div>
          </aside>

          {/* Main – headless chat */}
          <main class="main-pane">
            <div class="thread-header">
              <h2>{activeThread()?.title ?? "New Chat"}</h2>
              <span class="workspace-label">{activeWorkspace()?.name ?? "Personal"} • {modelId() || "auto"}</span>
              <span class="system-prompt">{searchEnabled() ? "search on" : "search off"} • {reasoningLevel()}</span>
            </div>

            {/* Headless Chat Pane keyed by threadId */}
            <Show when={activeThreadId()} keyed>
              {tid => <HeadlessChatPane threadId={tid} models={models()} modelId={modelId()} reasoningLevel={reasoningLevel()} searchEnabled={searchEnabled()} onTitleUpdate={(title) => {
                setThreads(prev => prev.map(t => t.id === tid ? { ...t, title, updatedAt: new Date().toISOString() } : t));
              }} composerText={composerText()} setComposerText={setComposerText} composerRef={el => { composerRef = el; }} timelineRef={el => { timelineRef = el; }} />}
            </Show>

            {/* Composer – headless, keeps styling via .composer */}
            <HeadlessComposer
              text={composerText()} setText={setComposerText}
              modelId={modelId()} setModelId={setModelId}
              reasoningLevel={reasoningLevel()} setReasoningLevel={setReasoningLevel}
              searchEnabled={searchEnabled()} setSearchEnabled={setSearchEnabled}
              models={models()}
              supportsReasoning={supportsReasoning()}
              composerRef={el => { composerRef = el; }}
              onSend={(text) => {
                // handled inside HeadlessChatPane via exposed send? We forward via custom event
                window.dispatchEvent(new CustomEvent("shedflare:send", { detail: { threadId: activeThreadId(), text } }));
              }}
            />
          </main>
        </div>
      </Show>
    </Show>
  );
}

// --- Headless composer (styling preserved) ---
function HeadlessComposer(props: {
  text: string; setText: (v: string) => void;
  modelId: string; setModelId: (v: string) => void;
  reasoningLevel: "off"|"low"|"medium"|"high"; setReasoningLevel: (v: "off"|"low"|"medium"|"high") => void;
  searchEnabled: boolean; setSearchEnabled: (v: boolean) => void;
  models: ModelsPayload | null;
  supportsReasoning: boolean;
  composerRef: (el: HTMLTextAreaElement) => void;
  onSend: (text: string) => void;
}) {
  const canSend = createMemo(() => props.text.trim().length > 0);
  return (
    <div class="composer">
      <div class="composer-row">
        <select class="composer-model" value={props.modelId} onChange={e => props.setModelId(e.currentTarget.value)}>
          <For each={props.models?.models ?? []}>{m => <option value={m.id}>{m.name}</option>}</For>
        </select>
        <Show when={props.supportsReasoning}>
          <label class="composer-reasoning-select">
            <select value={props.reasoningLevel} onChange={e => props.setReasoningLevel(e.currentTarget.value as never)}>
              <option value="off">Reason off</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </Show>
        <button class={`composer-action-btn ${props.searchEnabled ? "is-active" : ""}`} onClick={() => props.setSearchEnabled(!props.searchEnabled)} title="Toggle search">⌕</button>
      </div>
      <div class="composer-row">
        <textarea
          ref={props.composerRef}
          class="composer-input"
          placeholder="Ask anything…"
          value={props.text}
          onInput={e => props.setText(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canSend()) { props.onSend(props.text); props.setText(""); } }
          }}
          rows={1}
        />
        <button class="composer-send-btn" disabled={!canSend()} onClick={() => { if (canSend()) { props.onSend(props.text); props.setText(""); } }}>↑</button>
      </div>
      <div class="composer-note">Headless via <code>@tanstack/ai-solid</code> • <code>fetchServerSentEvents('/api/chat')</code> • styling via <code>app.css</code> tokens</div>
    </div>
  );
}

// --- Headless chat pane – the core @tanstack/ai-solid usage + TanStack persistence (client durability) ---
function HeadlessChatPane(props: {
  threadId: string;
  models: ModelsPayload | null;
  modelId: string;
  reasoningLevel: "off"|"low"|"medium"|"high";
  searchEnabled: boolean;
  onTitleUpdate: (t: string) => void;
  composerText: string; setComposerText: (v: string) => void;
  composerRef: (el: HTMLTextAreaElement) => void;
  timelineRef: (el: HTMLDivElement) => void;
}) {
  // Headless: useChat with SSE, no default UI
  // TanStack persistence (client) keeps transcript across reloads per threadId;
  // server hydration (api/chat GET) stays empty for now – add withPersistence there for multi-device.
  // Workspace grouping above is the "one layer above" you mentioned.
  const chat = useChat({
    connection: fetchServerSentEvents("/api/chat"),
    threadId: props.threadId,
    // SAFETY: indexedDBPersistence is per-thread (keyPrefix + threadId), handles SSR fallback as StorageUnavailableError
    persistence: indexedDBPersistence({ keyPrefix: "shedflare:" }) as never,
  } as never);

  // keep title in sync with first user message
  createEffect(() => {
    const msgs = chat.messages;
    // Solid: chat.messages is Accessor; need call
    const list = (chat as unknown as { messages: () => Array<{ role: string; parts: Array<{ type: string; content?: string }> }> }).messages();
    const firstUser = list.find(m => m.role === "user");
    const txt = firstUser?.parts.find(p => p.type === "text")?.content?.trim().slice(0, 48);
    if (txt) props.onTitleUpdate(txt);
  });

  // listen for composer send events
  const onSend = (e: Event) => {
    const ce = e as CustomEvent<{ threadId: string; text: string }>;
    if (ce.detail.threadId !== props.threadId) return;
    const text = ce.detail.text.trim();
    if (!text) return;
    // forward model/reasoning/search as body for server's forwardedProps
    void (chat as unknown as { sendMessage: (c: string, o?: unknown) => Promise<void> }).sendMessage(text, {
      body: { modelId: props.modelId, reasoningLevel: props.reasoningLevel, search: props.searchEnabled }
    } as never);
  };
  onMount(() => window.addEventListener("shedflare:send", onSend));
  onCleanup(() => window.removeEventListener("shedflare:send", onSend));

  // auto-scroll
  let tRef: HTMLDivElement | undefined;
  createEffect(() => {
    // track messages length
    const len = (chat as unknown as { messages: () => unknown[] }).messages().length;
    // also track last part content for streaming scroll
    const _ = len;
    if (tRef) {
      requestAnimationFrame(() => { if (tRef) tRef.scrollTop = tRef.scrollHeight; });
    }
  });

  const isStreaming = createMemo(() => (chat as unknown as { isLoading: () => boolean }).isLoading());

  return (
    <div class="timeline-shell" style={{ flex: 1, display: "flex", "flex-direction": "column", "min-height": 0 }}>
      <div ref={el => { tRef = el; props.timelineRef(el); }} class="timeline">
        <Show when={(chat as unknown as { messages: () => unknown[] }).messages().length === 0}>
          <div class="timeline-loading">Start a conversation — headless UI, your styling.</div>
        </Show>
        <For each={(chat as unknown as { messages: () => Array<{ id: string; role: string; parts: Array<{ type: string; content?: string; id?: string; name?: string; arguments?: string; state?: string; input?: unknown; output?: unknown }> }> }).messages()}>
          {message => (
            <div class={`msg ${message.role}`}>
              <Show when={message.role === "user"} fallback={
                <div class="assistant-interleaved-body">
                  <For each={message.parts}>
                    {part => (
                      <Show when={part.type === "text"} fallback={
                        <Show when={part.type === "thinking"} fallback={
                          <Show when={part.type === "tool-call"} fallback={
                            <span class="assistant-chip"><span class="assistant-chip-label">{part.type}</span></span>
                          }>
                            <div class="assistant-chip">
                              <span class="assistant-chip-label">{(part as { name?: string }).name ?? "tool"}</span>
                              <span class="assistant-chip-detail">{(part as { arguments?: string }).arguments?.slice(0, 80) ?? ""}</span>
                            </div>
                          </Show>
                        }>
                          <div class="assistant-chip assistant-chip-reasoning">
                            <span class="assistant-chip-label">Thinking</span>
                            <div class="assistant-chip-reasoning-text">{part.content}</div>
                          </div>
                        </Show>
                      }>
                        <div class="assistant-answer-card md-content">
                          <Suspense fallback={<p style={{ "white-space": "pre-wrap" }}>{part.content}</p>}>
                            <Markdown text={part.content ?? ""} />
                          </Suspense>
                        </div>
                      </Show>
                    )}
                  </For>
                  <Show when={isStreaming() && (chat as unknown as { messages: () => Array<{ id: string }> }).messages().at(-1)?.id === message.id}>
                    <span class="streaming-cursor" />
                  </Show>
                </div>
              }>
                {/* user bubble */}
                <div class="msg-user-stack">
                  <div class="msg-user-row">
                    <div class="msg-user-body"><p>{message.parts.find(p => p.type === "text")?.content ?? ""}</p></div>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </For>
        <Show when={(chat as unknown as { error: () => Error | undefined }).error()}>
          <div class="assistant-error-card">
            <div class="assistant-error-title">Error</div>
            <div class="assistant-error-summary">{String((chat as unknown as { error: () => Error | undefined }).error()?.message ?? "Unknown error")}</div>
          </div>
        </Show>
        <Show when={isStreaming()}>
          <div class="thinking-indicator"><div class="thinking-spinner" /> Streaming…</div>
        </Show>
        <div class="timeline-anchor active" />
      </div>

      {/* queue + stop */}
      <Show when={isStreaming()}>
        <div style={{ padding: "6px 16px", display: "flex", "justify-content": "flex-end" }}>
          <button class="btn btn-stop" onClick={() => (chat as unknown as { stop: () => void }).stop()}>Stop</button>
        </div>
      </Show>
    </div>
  );
}
