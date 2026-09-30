import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  useContext,
} from "solid-js";
import { clearAuthHint, readAuthHint } from "@shedflare/auth-client/client";
import * as Schema from "effect/Schema";
import type { ContextMenuState, SortBy, SortOrder, Toast, ViewMode } from "./types";
import {
  type DriveFile,
  type TagSummary,
  FilesResponse,
  FileResponse,
  TagsResponse,
  SessionResponse,
} from "./types";
import { formatSize, fileGlyph, sortFiles } from "./utils";
import type { FileTypeFilter } from "./shared/file-types";

export { formatSize, fileGlyph };

/* ── requestJson helper ───────────────────────────── */

const ErrorResponse = Schema.Struct({ error: Schema.String });

async function responseErrorMessage(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    return Schema.decodeUnknownSync(ErrorResponse)(JSON.parse(text)).error;
  } catch {
    // Fall back to a short non-HTML response or a status-specific message.
  }

  if (text && !text.trimStart().startsWith("<")) return text.slice(0, 500);
  if (response.status === 401) return "Session expired — please sign in again";
  if (response.status === 404) return "The requested file no longer exists";
  if (response.status === 429) return "Drive is busy. Wait a moment and retry";
  if (response.status >= 500) return "Drive could not complete the request. Retry";
  return `Drive request failed (HTTP ${response.status})`;
}

export async function requestJson<
  SchemaType extends Parameters<typeof Schema.decodeUnknownSync>[0],
>(input: RequestInfo | URL, schema: SchemaType, init?: RequestInit): Promise<SchemaType["Type"]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(await responseErrorMessage(response));
    return Schema.decodeUnknownSync(schema)(await response.json());
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Drive did not respond within 10 seconds. Retry.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Context type ────────────────────────────────── */

export type DriveContextValue = {
  // ── Data ─────────────────────────────────
  files: () => DriveFile[];
  sortedFiles: () => DriveFile[];
  tags: () => TagSummary[];
  loadFiles: (append?: boolean, pageOffset?: number) => Promise<void>;
  loadTags: () => Promise<void>;
  tagsState: () => { status: "loading" | "ready" } | { status: "error"; message: string };

  // ── Query ────────────────────────────────
  search: () => string;
  setSearch: (v: string) => void;
  selectedTag: () => string;
  setSelectedTag: (v: string) => void;
  selectedFileType: () => FileTypeFilter;
  setSelectedFileType: (v: FileTypeFilter) => void;
  selectedFileId: () => string;
  setSelectedFileId: (v: string) => void;
  selectedFile: () => DriveFile | undefined;

  // ── View ─────────────────────────────────
  viewMode: () => ViewMode;
  setViewMode: (v: ViewMode) => void;
  sortBy: () => SortBy;
  setSortBy: (v: SortBy) => void;
  sortOrder: () => SortOrder;
  setSortOrder: (v: SortOrder) => void;

  // ── Pagination ───────────────────────────
  offset: () => number;
  hasMore: () => boolean;
  loadMore: () => Promise<void>;

  // ── Session ──────────────────────────────
  checkingSession: () => boolean;
  unauthorized: () => boolean;
  userEmail: () => string;
  signIn: () => void;

  // ── Loading ──────────────────────────────
  filesLoading: () => boolean;

  // ── Feedback ─────────────────────────────
  error: () => string;
  setError: (v: string) => void;
  toasts: () => Toast[];
  addToast: (message: string, type?: Toast["type"]) => void;

  // ── UI coordination ──────────────────────
  editingId: () => string;
  setEditingId: (v: string) => void;
  contextMenu: () => ContextMenuState | null;
  setContextMenu: (v: ContextMenuState | null) => void;
  pendingDeleteId: () => string;
  setPendingDeleteId: (v: string) => void;
  leftSidebarOpen: () => boolean;
  setLeftSidebarOpen: (v: boolean) => void;
  rightSidebarCollapsed: () => boolean;
  setRightSidebarCollapsed: (v: boolean) => void;
  selection: () => Set<string>;
  toggleFileSelection: (id: string) => void;
  clearSelection: () => void;

  // ── File actions ─────────────────────────
  download: (file: DriveFile) => void;
  publicUrl: (file: DriveFile) => string;
  copyPublicLink: (file: DriveFile) => Promise<void>;
  setFilePublic: (file: DriveFile, isPublic: boolean) => Promise<void>;
  setFileTags: (file: DriveFile, tags: string[]) => Promise<void>;
  remove: (file: DriveFile) => Promise<void>;
  removeSelected: () => Promise<void>;
  downloadSelected: () => void;
  submitRename: (file: DriveFile, newName: string) => Promise<void>;
};

const DriveCtx = createContext<DriveContextValue>();

export { DriveCtx };

export function useDrive() {
  const ctx = useContext(DriveCtx);
  if (!ctx) throw new Error("useDrive must be used within DriveProvider");
  return ctx;
}

/* ── Provider ────────────────────────────────────── */

export function DriveProvider(props: { children: import("solid-js").JSX.Element }) {
  // ── Data ──────────────────────────────────
  const [files, setFiles] = createSignal<DriveFile[]>([]);
  const [tags, setTags] = createSignal<TagSummary[]>([]);
  const [tagsState, setTagsState] = createSignal<ReturnType<DriveContextValue["tagsState"]>>({
    status: "loading",
  });

  // ── Query ─────────────────────────────────
  const [search, setSearch] = createSignal("");
  const [selectedTag, setSelectedTag] = createSignal("");
  const [selectedFileType, setSelectedFileType] = createSignal<FileTypeFilter>("");
  const [selectedFileId, setSelectedFileId] = createSignal("");

  // ── View ──────────────────────────────────
  const [viewMode, setViewMode] = createSignal<ViewMode>("grid");
  const [sortBy, setSortBy] = createSignal<SortBy>("date");
  const [sortOrder, setSortOrder] = createSignal<SortOrder>("desc");

  // ── Pagination ────────────────────────────
  const [offset, setOffset] = createSignal(0);
  const [hasMore, setHasMore] = createSignal(false);

  // ── Session ───────────────────────────────
  // Seed from the auth hint so a known-signed-in user paints the drive shell
  // immediately instead of the "Checking session…" overlay. bootstrap() below
  // reconciles against /api/session.
  const sessionHint = readAuthHint();
  const [checkingSession, setCheckingSession] = createSignal(!sessionHint);
  const [unauthorized, setUnauthorized] = createSignal(false);
  const [userEmail, setUserEmail] = createSignal(sessionHint);

  // ── Loading ───────────────────────────────
  const [filesLoading, setFilesLoading] = createSignal(false);

  // ── Feedback ──────────────────────────────
  const [error, setError] = createSignal("");
  const [toasts, setToasts] = createSignal<Toast[]>([]);

  // ── UI coordination ───────────────────────
  const [editingId, setEditingId] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = createSignal("");
  const [leftSidebarOpen, setLeftSidebarOpen] = createSignal(
    globalThis.window?.matchMedia?.("(min-width: 901px)").matches ?? true,
  );
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = createSignal(false);
  const [selection, setSelection] = createSignal(new Set<string>());

  onMount(() => {
    if (!globalThis.window?.matchMedia) return;
    const wideViewport = window.matchMedia("(min-width: 901px)");
    const updateSidebarForViewport = (event: MediaQueryListEvent) => {
      setLeftSidebarOpen(event.matches);
    };

    wideViewport.addEventListener("change", updateSidebarForViewport);
    onCleanup(() => wideViewport.removeEventListener("change", updateSidebarForViewport));
  });

  // ── Derived ───────────────────────────────

  const selectedFile = createMemo(() => {
    const id = selectedFileId();
    if (!id) return undefined;
    return files().find((f) => f.id === id);
  });

  const sortedFiles = createMemo(() => sortFiles(files(), sortBy(), sortOrder()));

  const query = createMemo(() => {
    const params = new URLSearchParams();
    if (search().trim()) params.set("search", search().trim());
    if (selectedTag()) params.set("tag", selectedTag());
    if (selectedFileType()) params.set("type", selectedFileType());
    return params.toString();
  });

  // ── API ───────────────────────────────────

  let filesRequest = 0;
  async function loadFiles(append = false, pageOffset = 0) {
    const request = ++filesRequest;
    const requestedQuery = query();
    setFilesLoading(true);
    try {
      const base = requestedQuery ? `?${requestedQuery}&` : "?";
      const data = await requestJson(
        `/api/files${base}limit=30&offset=${pageOffset}`,
        FilesResponse,
      );
      if (request !== filesRequest || requestedQuery !== query()) return;
      setFiles((prev) => (append ? [...prev, ...data.files] : [...data.files]));
      setOffset(pageOffset);
      setHasMore(data.nextOffset !== null);
    } catch (error) {
      if (request === filesRequest && requestedQuery === query()) throw error;
    } finally {
      if (request === filesRequest) setFilesLoading(false);
    }
  }

  let tagsRequest = 0;
  async function loadTags() {
    const request = ++tagsRequest;
    setTagsState({ status: "loading" });
    try {
      const data = await requestJson("/api/tags", TagsResponse);
      if (request !== tagsRequest) return;
      setTags([...data.tags]);
      setTagsState({ status: "ready" });
      if (selectedTag() && !data.tags.some((tag) => tag.name === selectedTag())) setSelectedTag("");
    } catch (error) {
      if (request !== tagsRequest) return;
      setTagsState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not load tags",
      });
      throw error;
    }
  }

  async function bootstrap() {
    try {
      const session = await requestJson("/api/session", SessionResponse);
      setUserEmail(session.user.email);
      setUnauthorized(false);
      await loadTags().catch(() => {});
    } catch (err) {
      if (err instanceof Error && err.message.includes("Unauthorized")) {
        // Hint was stale (or this is the post-silent-auth sign-in screen): drop
        // it and the optimistic email so we don't keep painting the shell.
        clearAuthHint();
        setUserEmail("");
        const url = new URL(window.location.href);
        if (url.searchParams.get("error") !== "no_session") {
          window.location.replace("/api/auth/login?auto=1");
          return;
        }
        setUnauthorized(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Could not load Drive");
    } finally {
      setCheckingSession(false);
    }
  }

  createEffect(() => {
    void query();
    setOffset(0);
    if (!userEmail()) return;
    void loadFiles(false, 0).catch((err) =>
      addToast(err instanceof Error ? err.message : "Search failed", "error"),
    );
  });

  void bootstrap();

  // ── Toast helper ──────────────────────────

  function addToast(message: string, type: Toast["type"] = "info") {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }

  // ── Selection helpers ─────────────────────

  function toggleFileSelection(id: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelection(new Set<string>());
  }

  // ── File actions ──────────────────────────

  function signIn() {
    window.location.assign("/api/auth/login");
  }

  function download(file: DriveFile) {
    window.location.assign(`/api/files/${file.id}/download`);
  }

  function publicUrl(file: DriveFile) {
    return `${window.location.origin}/public/files/${encodeURIComponent(file.id)}/download`;
  }

  async function copyPublicLink(file: DriveFile) {
    if (!file.isPublic) {
      addToast("Publish the file before copying its public link", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(publicUrl(file));
      addToast("Public link copied", "success");
    } catch {
      addToast(publicUrl(file), "info");
    }
  }

  async function setFilePublic(file: DriveFile, isPublic: boolean) {
    setError("");
    try {
      const data = await requestJson(`/api/files/${file.id}`, FileResponse, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic }),
      });
      setFiles((prev) => prev.map((f) => (f.id === file.id ? data.file : f)));
      addToast(isPublic ? "File is now public" : "Public sharing disabled", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Could not update sharing", "error");
    }
  }

  async function setFileTags(file: DriveFile, tags: string[]) {
    const data = await requestJson(`/api/files/${file.id}`, FileResponse, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    const refreshFiles = filesLoading() || Boolean(selectedTag() || search().trim());
    // Invalidate reads begun before this write so they cannot restore old tags.
    filesRequest++;
    setFilesLoading(false);
    // Use the saved server record; failed writes leave the displayed tags intact.
    setFiles((prev) => prev.map((f) => (f.id === file.id ? data.file : f)));
    if (refreshFiles) {
      void loadFiles(false, 0).catch((error) =>
        addToast(error instanceof Error ? error.message : "Could not refresh files", "error"),
      );
    }
    // A failed count refresh is separately retryable and does not undo a saved edit.
    void loadTags().catch(() => {});
  }

  async function remove(file: DriveFile) {
    setError("");
    try {
      const response = await fetch(`/api/files/${file.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      setSelectedFileId("");
      setPendingDeleteId("");
      await Promise.all([loadFiles(false, 0), loadTags()]);
      setOffset(0);
      addToast(`Deleted ${file.name}`);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Delete failed", "error");
    }
  }

  async function removeSelected() {
    const ids = [...selection()];
    if (ids.length === 0) return;
    setError("");
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const response = await fetch(`/api/files/${id}`, { method: "DELETE" });
        if (response.ok) deleted++;
        else failed++;
      } catch {
        failed++;
      }
    }
    clearSelection();
    await Promise.all([loadFiles(false, 0), loadTags()]);
    setOffset(0);
    addToast(
      failed > 0
        ? `Deleted ${deleted} file${deleted !== 1 ? "s" : ""}; ${failed} failed`
        : `Deleted ${deleted} file${deleted !== 1 ? "s" : ""}`,
      failed > 0 ? "error" : "info",
    );
  }

  function downloadSelected() {
    for (const id of selection()) {
      const file = files().find((f) => f.id === id);
      if (file) download(file);
    }
  }

  async function submitRename(file: DriveFile, newName: string) {
    const name = newName.trim();
    if (!name || name === file.name) return;
    setError("");
    try {
      await requestJson(`/api/files/${file.id}`, FileResponse, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name } : f)));
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Rename failed", "error");
    }
  }

  async function loadMore() {
    if (filesLoading() || !hasMore()) return;
    const next = offset() + 30;
    await loadFiles(true, next);
  }

  /* ── Value ────────────────────────────────── */

  const value: DriveContextValue = {
    files,
    sortedFiles,
    tags,
    loadFiles,
    loadTags,
    tagsState,
    search,
    setSearch,
    selectedTag,
    setSelectedTag,
    selectedFileType,
    setSelectedFileType,
    selectedFileId,
    setSelectedFileId,
    selectedFile,
    viewMode,
    setViewMode,
    sortBy,
    setSortBy,
    sortOrder,
    setSortOrder,
    offset,
    hasMore,
    loadMore,
    checkingSession,
    unauthorized,
    userEmail,
    signIn,
    filesLoading,
    error,
    setError,
    toasts,
    addToast,
    editingId,
    setEditingId,
    contextMenu,
    setContextMenu,
    pendingDeleteId,
    setPendingDeleteId,
    leftSidebarOpen,
    setLeftSidebarOpen,
    rightSidebarCollapsed,
    setRightSidebarCollapsed,
    selection,
    toggleFileSelection,
    clearSelection,
    download,
    publicUrl,
    copyPublicLink,
    setFilePublic,
    setFileTags,
    remove,
    removeSelected,
    downloadSelected,
    submitRename,
  };

  return <DriveCtx.Provider value={value}>{props.children}</DriveCtx.Provider>;
}
