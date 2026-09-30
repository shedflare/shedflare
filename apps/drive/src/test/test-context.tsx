import { createSignal, type JSX } from "solid-js";
import { DriveCtx, type DriveContextValue } from "../context";
import type { DriveFile, TagSummary, Toast } from "../types";
import type { FileTypeFilter } from "../shared/file-types";

export function createMockContext(overrides?: Partial<DriveContextValue>): DriveContextValue {
  const [files] = createSignal<DriveFile[]>([]);
  const [tags] = createSignal<TagSummary[]>([]);
  const [search, setSearch] = createSignal("");
  const [selectedTag, setSelectedTag] = createSignal("");
  const [selectedFileType, setSelectedFileType] = createSignal<FileTypeFilter>("");
  const [selectedFileId, setSelectedFileId] = createSignal("");
  const [viewMode, setViewMode] = createSignal<"grid" | "list">("grid");
  const [sortBy, setSortBy] = createSignal<"name" | "date" | "size">("date");
  const [sortOrder, setSortOrder] = createSignal<"asc" | "desc">("desc");
  const [offset] = createSignal(0);
  const [hasMore] = createSignal(false);
  const [filesLoading] = createSignal(false);
  const [checkingSession] = createSignal(false);
  const [unauthorized] = createSignal(false);
  const [userEmail] = createSignal("test@example.com");
  const [error, setError] = createSignal("");
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [editingId, setEditingId] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal(null);
  const [pendingDeleteId, setPendingDeleteId] = createSignal("");
  const [leftSidebarOpen, setLeftSidebarOpen] = createSignal(true);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = createSignal(false);
  const [selection, setSelection] = createSignal(new Set<string>());

  const noop = () => {};
  const noopAsync = async () => {};

  return {
    files,
    sortedFiles: files,
    tags,
    loadFiles: noopAsync,
    loadTags: noopAsync,
    tagsState: () => ({ status: "ready" }),
    search,
    setSearch,
    selectedTag,
    setSelectedTag,
    selectedFileType,
    setSelectedFileType,
    selectedFileId,
    setSelectedFileId,
    selectedFile: () => undefined,
    viewMode,
    setViewMode,
    sortBy,
    setSortBy,
    sortOrder,
    setSortOrder,
    offset,
    hasMore,
    loadMore: noopAsync,
    filesLoading,
    checkingSession,
    unauthorized,
    userEmail,
    signIn: noop,
    error,
    setError,
    toasts,
    addToast: (message: string, type: Toast["type"] = "info") => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
    },
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
    toggleFileSelection: (id: string) => {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    clearSelection: () => setSelection(new Set<string>()),
    download: noop,
    publicUrl: (file: DriveFile) => `https://test.example.com/public/files/${file.id}/download`,
    copyPublicLink: noopAsync,
    setFilePublic: noopAsync,
    setFileTags: noopAsync,
    remove: noopAsync,
    removeSelected: noopAsync,
    downloadSelected: noop,
    submitRename: noopAsync,
    ...overrides,
  };
}

export function TestDriveProvider(props: {
  value?: Partial<DriveContextValue>;
  children: JSX.Element;
}) {
  const ctx = createMockContext(props.value);
  return <DriveCtx.Provider value={ctx}>{props.children}</DriveCtx.Provider>;
}
