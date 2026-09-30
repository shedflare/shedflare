import {
  buildMultiSearchContext,
  clampSearchesPerTurn,
  compareThreadRecency,
  compareWorkspaceRecency,
  createAttachment,
  createMessage,
  createThread,
  createWorkspace,
  DEFAULT_SEARCHES_PER_TURN,
  MAX_SEARCHES_PER_TURN,
  mergeAttachmentLink,
  resolveThreadMessagePath,
  sortConversationMessages,
  slugify,
  type ExternalValue,
  type SyncEventPayloadMap,
  type SyncEventType,
  type SyncServerEvent,
} from "#/domain";
import {
  BrowserRenderError,
  clampExaResults,
  cloudflareBrowserMarkdown,
  exaSearch,
  ExaSearchError,
  extractReasoningTokens,
  extractChatCompletionText,
  clearEnvOverrideCache,
  filterModelsCatalog,
  modelTransportFor,
  normalizeModelsCatalogResponse,
  getSignedAttachmentUrl,
  getInlineAttachment,
  isImageAttachment,
  isOwnerEmail,
  isInlineTextAttachment,
  normalizeEmail,
  normalizeExtractUrl,
  parseExaMcpTextResponse,
  truncateExtractedMarkdown,
  verifyUploadToken,
} from "#/runtime";
import { createExaSearchTool } from "../server/search";
import type { SearchProgressEvent } from "../server/search";
import { createBrowserExtractTool } from "../server/extract";
import {
  consumeAssistantStream,
  requireSuccessfulAssistantStream,
} from "../server/stream-consumer";
import {
  chat,
  convertSchemaToJsonSchema,
  EventType,
  toolDefinition,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai";
import { AssistantTurnError, decodeAppEnv } from "#/effect";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { explainAssistantError } from "./assistant-errors";
import { editUserMessageAction, retryMessageAction, sendMessageAction } from "./actions";
import {
  applyLocalInsert,
  attachments,
  messages,
  resetCollections,
  threads,
  workspaces,
} from "./collections";
import {
  activateWorkspaceDraftView,
  clearAllDraftState,
  consumePendingDraftAttachmentCleanup,
  ensureWorkspaceDraft,
  getWorkspaceConversationView,
  getWorkspaceDraft,
  reconcileDraftState,
  removeWorkspaceDraftAttachment,
  updateWorkspaceDraft,
} from "./draft-state";
import { resetPendingOps } from "./pending-ops";
import { processEnvelopes } from "./sync-adapter";
import { getLastServerSeq, setLastServerSeq } from "./ws-connection";
import { readChatNavigationState, withChatNavigationState } from "./navigation-state";
import { normalizeAssistantError } from "../server/error-normalization";
import { createVersionedResponseInit } from "../server/router";
import {
  createChatBackupKey,
  parseChatBackupKeyTimestamp,
  selectExpiredChatBackupKeys,
} from "../api/backups";
import { createOpenCodeAdapter } from "../server/ai-provider";
import { toolBudgetMiddleware } from "../server/tool-budget";
import { mergePersistedModelHistory } from "../server/model-message-builder";
import { selectAutomaticModelId } from "./model-selection";

function replaceFetch(implementation: typeof fetch) {
  globalThis.fetch = implementation;
}

function decodeRequestBody(init?: RequestInit): ExternalValue {
  const body = Schema.decodeUnknownSync(Schema.String)(init?.body ?? "{}");
  return JSON.parse(body);
}

function resolveRequestUrl(input: RequestInfo | URL) {
  return new Request(input).url;
}

function requireCaptured<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

function requireToolExecutor<TArgs, TResult>(tool: {
  execute?: (args: TArgs, context?: never) => TResult | Promise<TResult>;
}) {
  const execute = tool.execute;
  if (!execute) throw new Error("Expected a server-side tool executor");
  return async (args: TArgs): Promise<TResult> => execute(args);
}

const SearchToolResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  resultCount: Schema.optional(Schema.Number),
});
const ExtractToolResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  url: Schema.String,
  content: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
});
const ExaRequestSchema = Schema.Struct({
  useAutoprompt: Schema.Boolean,
  type: Schema.String,
  numResults: Schema.Number,
  contents: Schema.Any,
});
type CapturedExaRequest = {
  url: string;
  body: Schema.Schema.Type<typeof ExaRequestSchema>;
};

function decodeSearchToolResult(value: ExternalValue) {
  return Schema.decodeUnknownSync(SearchToolResultSchema)(value);
}

function decodeExtractToolResult(value: ExternalValue) {
  return Schema.decodeUnknownSync(ExtractToolResultSchema)(value);
}

function testServerEvent<T extends SyncEventType>(
  serverSeq: number,
  eventType: T,
  payload: SyncEventPayloadMap[T],
): SyncServerEvent<T> {
  // SAFETY: eventType and payload share the same generic key, preserving the mapped event union.
  return {
    type: "event",
    serverSeq,
    eventId: `evt_${serverSeq}`,
    eventType,
    payload,
  } as SyncServerEvent<T>;
}

beforeEach(() => {
  resetCollections();
  resetPendingOps();
  clearAllDraftState();
  setLastServerSeq(0);
  if (globalThis.localStorage) {
    localStorage.clear();
  }
});

describe("domain helpers", () => {
  it("orders workspace and thread fallbacks by recency, not snapshot insertion order", () => {
    const olderWorkspace = {
      ...createWorkspace({ name: "Older", defaultModelId: "old" }),
      sortKey: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const newerWorkspace = {
      ...createWorkspace({ name: "Newer", defaultModelId: "new" }),
      sortKey: 2,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const olderThread = {
      ...createThread({ workspaceId: olderWorkspace.id }),
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const newerThread = {
      ...createThread({ workspaceId: olderWorkspace.id }),
      lastMessageAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    expect([olderWorkspace, newerWorkspace].sort(compareWorkspaceRecency)[0]?.id).toBe(
      newerWorkspace.id,
    );
    expect([olderThread, newerThread].sort(compareThreadRecency)[0]?.id).toBe(newerThread.id);
  });

  it("round-trips chat selection through URL parameters without dropping other params", () => {
    const url = new URL(
      "https://chat.example.com/?debug=1&workspaceId=old&threadId=old-thread#messages",
    );
    const next = withChatNavigationState(url, {
      workspaceId: "wrk_new",
      threadId: "thd_new",
      view: "thread",
    });

    expect(readChatNavigationState(next)).toEqual({
      workspaceId: "wrk_new",
      threadId: "thd_new",
      view: null,
    });
    expect(next.searchParams.get("debug")).toBe("1");
    expect(next.hash).toBe("#messages");

    const draftUrl = withChatNavigationState(next, {
      workspaceId: "wrk_new",
      threadId: null,
      view: "draft",
    });
    expect(readChatNavigationState(draftUrl)).toEqual({
      workspaceId: "wrk_new",
      threadId: null,
      view: "draft",
    });
  });

  it("preserves Worker WebSocket handles when wrapping responses", () => {
    const response = new Response(null, { status: 200 });
    const socket: WebSocket = Object.create(WebSocket.prototype);
    Object.defineProperty(response, "webSocket", { value: socket });

    expect(createVersionedResponseInit(response).webSocket).toBe(socket);
  });

  it("slugifies workspace names", () => {
    expect(slugify("  My Personal Workspace!! ")).toBe("my-personal-workspace");
  });

  it("creates attachments in a queued state", () => {
    const attachment = createAttachment({
      threadId: "thd_123",
      objectKey: "thd_123/file.txt",
      fileName: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 128,
    });

    expect(attachment.status).toBe("queued");
    expect(attachment.threadId).toBe("thd_123");
  });

  it("preserves an existing attachment message link on later upserts", () => {
    const attachment = createAttachment({
      threadId: "thd_123",
      objectKey: "thd_123/cat.png",
      fileName: "cat.png",
      mimeType: "image/png",
      sizeBytes: 128,
    });

    const merged = mergeAttachmentLink(
      { messageId: "msg_123" },
      {
        ...attachment,
        messageId: null,
        status: "ready",
      },
    );

    expect(merged.messageId).toBe("msg_123");
    expect(merged.status).toBe("ready");
  });

  it("builds grounded search context blocks", () => {
    const context = buildMultiSearchContext({
      runs: [
        {
          query: "current date and time right now",
          rows: [
            {
              title: "Example",
              url: "https://example.com",
              snippet: "hello world",
            },
          ],
        },
      ],
    });

    expect(context).toContain("Tool: exa_web_search");
    expect(context).toContain("Search query: current date and time right now");
    expect(context).toContain("<exa_search_results>");
    expect(context).toContain("do not mention the search tool");
    expect(context).toContain("[1] Example");
    expect(context).toContain("https://example.com");
  });

  it("builds grounded context blocks for multiple searches", () => {
    const context = buildMultiSearchContext({
      runs: [
        {
          query: "time in jakarta right now",
          rows: [
            {
              title: "Clock",
              url: "https://example.com/clock",
              snippet: "09:00",
            },
          ],
        },
        {
          query: "jakarta timezone",
          rawText: "Source 1\nhttps://example.com/tz\nUTC+7",
        },
      ],
    });

    expect(context).toContain("One or more web search tools have already been executed");
    expect(context).toContain("Search run 1");
    expect(context).toContain("Search run 2");
    expect(context).toContain("Search query: time in jakarta right now");
    expect(context).toContain("Search query: jakarta timezone");
    expect(context).toContain("https://example.com/tz");
  });

  it("sorts same-timestamp turns deterministically with the user before the assistant", () => {
    const createdAt = "2026-04-09T12:00:00.000Z";
    const sorted = sortConversationMessages([
      {
        id: "msg_assistant",
        role: "assistant",
        createdAt,
      },
      {
        id: "msg_user",
        role: "user",
        createdAt,
      },
    ]);

    expect(sorted.map((message) => message.id)).toEqual(["msg_user", "msg_assistant"]);
  });

  it("resolves the active thread path from the thread head", () => {
    const baseThread = createThread({ workspaceId: "wrk_123" });
    const firstUser = createMessage({
      threadId: baseThread.id,
      role: "user",
      modelId: "openai/gpt-4.1",
      text: "original",
    });
    const firstAssistant = createMessage({
      threadId: baseThread.id,
      parentMessageId: firstUser.id,
      role: "assistant",
      modelId: "openai/gpt-4.1",
      text: "first answer",
    });
    const revisedUser = createMessage({
      threadId: baseThread.id,
      parentMessageId: firstUser.parentMessageId ?? null,
      sourceMessageId: firstUser.id,
      role: "user",
      modelId: "openai/gpt-4.1",
      text: "revised",
    });
    const revisedAssistant = createMessage({
      threadId: baseThread.id,
      parentMessageId: revisedUser.id,
      role: "assistant",
      modelId: "openai/gpt-4.1",
      text: "revised answer",
    });

    const visible = resolveThreadMessagePath(
      [firstUser, firstAssistant, revisedUser, revisedAssistant],
      revisedAssistant.id,
    );

    expect(visible.map((message) => message.id)).toEqual([revisedUser.id, revisedAssistant.id]);
  });

  it("optimistically sends a message without direct collection mutations", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", thread);

    expect(() =>
      sendMessageAction({
        thread,
        text: "hello",
        modelId: workspace.defaultModelId,
        reasoningLevel: "medium",
        search: false,
        searchLimit: 4,
      }),
    ).not.toThrow();

    const persistedThread = threads.get(thread.id);
    const optimisticMessages = [...messages.state.values()].filter(
      (message) => message.threadId === thread.id,
    );

    expect(workspaces.get(workspace.id)).toBeTruthy();
    expect(persistedThread?.title).toBe("New Chat");
    expect(persistedThread?.headMessageId).toBeTruthy();
    expect(persistedThread?.modelId).toBe(workspace.defaultModelId);
    expect(persistedThread?.reasoningLevel).toBe("medium");
    expect(persistedThread?.searchEnabled).toBe(false);
    expect(persistedThread?.searchLimit).toBe(4);
    expect(optimisticMessages).toHaveLength(2);
    expect(optimisticMessages.map((message) => message.role).sort()).toEqual(["assistant", "user"]);
    expect(optimisticMessages.map((message) => message.reasoningLevel)).toEqual([
      "medium",
      "medium",
    ]);
    const userMessage = optimisticMessages.find((message) => message.role === "user");
    const assistantMessage = optimisticMessages.find((message) => message.role === "assistant");
    expect(userMessage?.parentMessageId).toBeNull();
    expect(assistantMessage?.parentMessageId).toBe(userMessage?.id);
    expect(assistantMessage?.id).toBe(persistedThread?.headMessageId);
  });

  it("materializes a draft thread on first send", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const draftThread = createThread({ workspaceId: workspace.id });

    applyLocalInsert("workspaces", workspace);

    expect(threads.get(draftThread.id)).toBeUndefined();

    sendMessageAction({
      thread: draftThread,
      text: "draft hello",
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
      searchLimit: 2,
    });

    expect(threads.get(draftThread.id)?.title).toBe("New Chat");
    expect(threads.get(draftThread.id)?.modelId).toBe(workspace.defaultModelId);
    expect(threads.get(draftThread.id)?.searchLimit).toBe(2);
    expect(
      [...messages.state.values()].filter((message) => message.threadId === draftThread.id),
    ).toHaveLength(2);
  });

  it("retries from an existing user turn by only appending a new assistant branch", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });
    const userMessage = createMessage({
      threadId: thread.id,
      role: "user",
      modelId: workspace.defaultModelId,
      text: "hello",
    });
    const assistantMessage = createMessage({
      threadId: thread.id,
      parentMessageId: userMessage.id,
      role: "assistant",
      modelId: workspace.defaultModelId,
      text: "world",
    });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", { ...thread, headMessageId: assistantMessage.id });
    applyLocalInsert("messages", userMessage);
    applyLocalInsert("messages", assistantMessage);

    retryMessageAction({
      thread: { ...thread, headMessageId: assistantMessage.id },
      userMessage,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
      searchLimit: 5,
    });

    const threadAfterRetry = threads.get(thread.id);
    const threadMessages = [...messages.state.values()].filter(
      (message) => message.threadId === thread.id,
    );
    const assistantMessages = threadMessages.filter((message) => message.role === "assistant");
    const retriedAssistant = assistantMessages.find(
      (message) => message.id !== assistantMessage.id,
    );

    expect(threadMessages).toHaveLength(3);
    expect(retriedAssistant?.parentMessageId).toBe(userMessage.id);
    expect(retriedAssistant?.status).toBe("pending");
    expect(threadAfterRetry?.headMessageId).toBe(retriedAssistant?.id);
    expect(threadAfterRetry?.modelId).toBe(workspace.defaultModelId);
    expect(threadAfterRetry?.reasoningLevel).toBe("off");
    expect(threadAfterRetry?.searchEnabled).toBe(false);
    expect(threadAfterRetry?.searchLimit).toBe(5);
  });

  it("edits a user turn by creating a new user branch and cloned attachments", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });
    const originalUser = createMessage({
      threadId: thread.id,
      role: "user",
      modelId: workspace.defaultModelId,
      text: "draft",
    });
    const originalAssistant = createMessage({
      threadId: thread.id,
      parentMessageId: originalUser.id,
      role: "assistant",
      modelId: workspace.defaultModelId,
      text: "answer",
    });
    const originalAttachment = createAttachment({
      threadId: thread.id,
      messageId: originalUser.id,
      objectKey: `${thread.id}/note.txt`,
      fileName: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      status: "ready",
    });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", { ...thread, headMessageId: originalAssistant.id });
    applyLocalInsert("messages", originalUser);
    applyLocalInsert("messages", originalAssistant);
    applyLocalInsert("attachments", originalAttachment);

    editUserMessageAction({
      thread: { ...thread, headMessageId: originalAssistant.id },
      sourceMessage: originalUser,
      text: "revised draft",
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
      searchLimit: 1,
      attachmentIds: [originalAttachment.id],
    });

    const threadAfterEdit = threads.get(thread.id);
    const threadMessages = [...messages.state.values()].filter(
      (message) => message.threadId === thread.id,
    );
    const editedUser = threadMessages.find(
      (message) => message.role === "user" && message.id !== originalUser.id,
    );
    const editedAssistant = threadMessages.find(
      (message) => message.role === "assistant" && message.id !== originalAssistant.id,
    );
    const clonedAttachments = [...attachments.state.values()].filter(
      (attachment) => attachment.threadId === thread.id && attachment.id !== originalAttachment.id,
    );

    expect(editedUser?.sourceMessageId).toBe(originalUser.id);
    expect(editedAssistant?.parentMessageId).toBe(editedUser?.id);
    expect(threadAfterEdit?.headMessageId).toBe(editedAssistant?.id);
    expect(threadAfterEdit?.modelId).toBe(workspace.defaultModelId);
    expect(threadAfterEdit?.reasoningLevel).toBe("off");
    expect(threadAfterEdit?.searchEnabled).toBe(false);
    expect(threadAfterEdit?.searchLimit).toBe(1);
    expect(clonedAttachments).toHaveLength(1);
    expect(clonedAttachments[0]?.messageId).toBe(editedUser?.id);
    expect(clonedAttachments[0]?.objectKey).toBe(originalAttachment.objectKey);
  });

  it("applies authoritative upserts over optimistic rows without duplicate-key errors", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const originalThread = createThread({ workspaceId: workspace.id, title: "New Chat" });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", originalThread);

    const updatedThread = {
      ...originalThread,
      title: "what time is it?",
    };

    expect(() =>
      processEnvelopes([
        {
          type: "event",
          serverSeq: 1,
          eventId: "evt_workspace",
          eventType: "workspace_upserted",
          payload: { row: workspace },
          causedByOpId: "op_workspace",
        },
        {
          type: "event",
          serverSeq: 2,
          eventId: "evt_thread",
          eventType: "thread_upserted",
          payload: { row: updatedThread },
          causedByOpId: "op_thread",
        },
      ]),
    ).not.toThrow();

    expect(workspaces.get(workspace.id)?.id).toBe(workspace.id);
    expect(threads.get(originalThread.id)?.title).toBe("what time is it?");
  });

  it("uses the sync snapshot server cursor when applying a reset", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });

    setLastServerSeq(99);
    processEnvelopes([
      {
        type: "sync_reset",
        reason: "initial_sync",
        protocolVersion: "test",
        snapshot: {
          serverSeq: 7,
          tables: {
            workspaces: {
              [workspace.id]: workspace,
            },
          },
        },
      },
    ]);

    expect(getLastServerSeq()).toBe(7);
    expect(workspaces.get(workspace.id)?.id).toBe(workspace.id);
  });

  it("advances the sync cursor after applying acks and events", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });

    processEnvelopes([
      {
        type: "ack",
        opId: "op_workspace",
        serverSeq: 3,
        acceptedAt: "2026-04-24T00:00:00.000Z",
        commandType: "create_workspace",
      },
    ]);

    expect(getLastServerSeq()).toBe(3);

    processEnvelopes([
      {
        type: "event",
        serverSeq: 4,
        eventId: "evt_workspace",
        eventType: "workspace_upserted",
        payload: { row: workspace },
        causedByOpId: "op_workspace",
      },
    ]);

    expect(workspaces.get(workspace.id)?.id).toBe(workspace.id);
    expect(getLastServerSeq()).toBe(4);
  });

  it("does not advance the sync cursor from hello_ack before replayed events apply", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });

    setLastServerSeq(3);
    processEnvelopes([
      {
        type: "hello_ack",
        protocolVersion: "test",
        serverTime: "2026-04-24T00:00:00.000Z",
        lastServerSeq: 10,
      },
      {
        type: "event",
        serverSeq: 4,
        eventId: "evt_workspace",
        eventType: "workspace_upserted",
        payload: { row: workspace },
        causedByOpId: null,
      },
    ]);

    expect(workspaces.get(workspace.id)?.id).toBe(workspace.id);
    expect(getLastServerSeq()).toBe(4);
  });

  it("applies message completion after same-batch message creation", () => {
    const message = createMessage({
      threadId: "thread_1",
      role: "assistant",
      modelId: "openai/gpt-4.1",
      status: "pending",
    });

    processEnvelopes([
      {
        type: "event",
        serverSeq: 1,
        eventId: "evt_message_pending",
        eventType: "message_upserted",
        payload: { row: message },
        causedByOpId: "op_message",
      },
      {
        type: "event",
        serverSeq: 2,
        eventId: "evt_message_completed",
        eventType: "message_completed",
        payload: {
          messageId: message.id,
          text: "Final answer",
          updatedAt: "2026-04-24T00:00:00.000Z",
          durationMs: 1000,
          ttftMs: 100,
          promptTokens: 10,
          completionTokens: 5,
        },
        causedByOpId: null,
      },
    ]);

    expect(messages.get(message.id)?.status).toBe("completed");
    expect(messages.get(message.id)?.text).toBe("Final answer");
  });

  it("reuses the same draft for a workspace", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });

    const first = ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "low",
      search: true,
    });
    const second = ensureWorkspaceDraft({
      workspace,
      modelId: "other-model",
      reasoningLevel: "high",
      search: false,
    });

    expect(second.thread.id).toBe(first.thread.id);
    expect(getWorkspaceDraft(workspace.id)?.search).toBe(true);
  });

  it("removes invalid workspace drafts during reconciliation", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });

    ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });
    activateWorkspaceDraftView(workspace.id);

    reconcileDraftState([], []);

    expect(getWorkspaceDraft(workspace.id)).toBeNull();
    expect(getWorkspaceConversationView(workspace.id)).toBe("thread");
  });

  it("drops a draft when the workspace is archived by sync", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", thread);
    ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });
    activateWorkspaceDraftView(workspace.id);

    processEnvelopes([
      {
        type: "event",
        serverSeq: 1,
        eventId: "evt_workspace_archived",
        eventType: "workspace_archived",
        payload: {
          id: workspace.id,
          archivedAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        },
        causedByOpId: "op_workspace_archived",
      },
    ]);

    expect(getWorkspaceDraft(workspace.id)).toBeNull();
  });

  it("removes ready attachments from a draft before first send", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const draft = ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });

    updateWorkspaceDraft(workspace.id, (current) => ({
      ...current,
      attachments: [
        {
          localId: "local_att",
          attachmentId: "att_ready",
          threadId: draft.thread.id,
          fileName: "cat.png",
          mimeType: "image/png",
          sizeBytes: 10,
          status: "ready",
        },
      ],
    }));

    const removed = removeWorkspaceDraftAttachment(workspace.id, "local_att");

    expect(removed?.attachmentId).toBe("att_ready");
    expect(getWorkspaceDraft(workspace.id)?.attachments).toHaveLength(0);
    expect(consumePendingDraftAttachmentCleanup()).toHaveLength(0);
  });
});

describe("TanStack model history", () => {
  const user = (id: string, content = id): ModelMessage => ({
    id,
    role: "user",
    content,
  });
  const assistant = (content: string): ModelMessage => ({ role: "assistant", content });

  it("keeps native tool history when appending a product turn", () => {
    const persisted: ModelMessage[] = [
      user("u1"),
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "exa_web_search", arguments: '{"query":"latest"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: '{"ok":true}' },
      assistant("answer"),
    ];
    const rebuilt = [user("u1"), assistant("answer"), user("u2", "follow up")];

    expect(
      mergePersistedModelHistory({
        persisted,
        rebuilt,
        latestUserMessageId: "u2",
      }),
    ).toEqual([...persisted, rebuilt[2]]);
  });

  it("replaces only the changed native suffix for retries and edits", () => {
    expect(
      mergePersistedModelHistory({
        persisted: [user("u1"), assistant("old answer")],
        rebuilt: [user("u1", "updated attachment")],
        latestUserMessageId: "u1",
      }),
    ).toEqual([user("u1", "updated attachment")]);

    expect(
      mergePersistedModelHistory({
        persisted: [user("u1"), assistant("answer 1"), user("u2-old"), assistant("old")],
        rebuilt: [user("u1"), assistant("answer 1"), user("u2-new", "edited")],
        latestUserMessageId: "u2-new",
      }),
    ).toEqual([user("u1"), assistant("answer 1"), user("u2-new", "edited")]);
  });

  it("uses an explicit auto-model policy instead of catalog order", () => {
    expect(
      selectAutomaticModelId([
        { id: "deepseek-v4-flash" },
        { id: "opencode/qwen3.6-plus" },
        { id: "kimi-k3" },
      ]),
    ).toBe("kimi-k3");
    expect(selectAutomaticModelId([{ id: "only-model" }])).toBe("only-model");
  });
});

describe("server helpers", () => {
  beforeEach(() => clearEnvOverrideCache());

  const env = decodeAppEnv({
    OPENCODE_GO_API_KEY: "opencode-key",
    OPENCODE_GO_MODEL_ALLOWLIST: "openai/gpt-4.1,anthropic/claude-sonnet-4",
    DEFAULT_MODEL_ID: "openai/gpt-4.1",
    APP_PUBLIC_URL: "https://chat.example.com",
    UPLOAD_TOKEN_SECRET: "test-secret",
    AUTH_URL: "https://auth.example.com",
    AUTH_CLIENT_ID: "shedflare-chat",
    AUTH: {
      async validateSession() {
        throw new Error("Unexpected Auth RPC in local test");
      },
      async exchangeCode() {
        throw new Error("Unexpected Auth RPC in local test");
      },
      async revokeSession() {
        throw new Error("Unexpected Auth RPC in local test");
      },
    },
    OWNER_EMAIL: "owner@example.com",
    DEV_AUTH_EMAIL: "owner@example.com",
    EXA_API_KEY: "exa-key",
    UPLOADS: {},
    SYNC_ENGINE: {},
    // A truthy sentinel stands in for the Cloudflare Browser Rendering
    // binding. The real binding is a Fetcher that only works under
    // `wrangler dev --remote`; tests inject a fake `extract` function into
    // `createBrowserExtractTool` so we never dereference it.
    BROWSER: { __mock: true },
  });

  it("normalizes email addresses", () => {
    expect(normalizeEmail(" Owner@Example.com ")).toBe("owner@example.com");
  });

  it("matches owner email addresses after normalization", () => {
    expect(isOwnerEmail(" Owner@Example.com ", "owner@example.com")).toBe(true);
    expect(isOwnerEmail("other@example.com", "owner@example.com")).toBe(false);
  });

  it("creates sortable chat backup keys", () => {
    const key = createChatBackupKey(new Date("2026-06-18T19:30:00.000Z"));

    expect(key).toBe("backups/chat/snapshots/2026-06-18T19-30-00-000Z.json.gz");
    expect(parseChatBackupKeyTimestamp(key)?.toISOString()).toBe("2026-06-18T19:30:00.000Z");
  });

  it("selects only chat backups older than two months for deletion", () => {
    const expired = "backups/chat/snapshots/2026-03-17T12-00-00-000Z.json.gz";
    const recent = "backups/chat/snapshots/2026-05-19T12-00-00-000Z.json.gz";
    const invalid = "backups/chat/snapshots/manual.json.gz";

    expect(
      selectExpiredChatBackupKeys([expired, recent, invalid], new Date("2026-06-18T12:00:00.000Z")),
    ).toEqual([expired]);
  });

  it("filters model catalog data to the allowlist", () => {
    const result = filterModelsCatalog(
      {
        "opencode-go": {
          id: "opencode-go",
          api: "https://api.example.com",
          models: {
            a: {
              id: "openai/gpt-4.1",
              name: "GPT 4.1",
              tool_call: true,
              interleaved: { field: "reasoning_content" },
            },
            b: { id: "openai/o3-mini", name: "o3-mini" },
          },
        },
      },
      env,
    );

    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe("openai/gpt-4.1");
    expect(result.models[0]?.reasoning).toBe(true);
    expect(result.models[0]?.toolCall).toBe(true);
    expect(result.models[0]?.interleaved?.field).toBe("reasoning_content");
    expect(result.models[0]?.family).toBe("unknown");
  });

  it("returns all opencode-go models when allowlist is omitted", () => {
    const { OPENCODE_GO_MODEL_ALLOWLIST: _, ...envNoAllowlist } = env;
    const result = filterModelsCatalog(
      {
        "opencode-go": {
          id: "opencode-go",
          api: "https://api.example.com",
          models: {
            a: { id: "openai/gpt-4.1", name: "GPT 4.1" },
            b: { id: "openai/o3-mini", name: "o3-mini" },
          },
        },
      },
      envNoAllowlist,
    );

    expect(result.models).toHaveLength(2);
  });

  it("merges local capability registry with endpoint model", () => {
    const { OPENCODE_GO_MODEL_ALLOWLIST: _, ...noAllowlist } = env;
    const result = filterModelsCatalog(
      {
        "opencode-go": {
          id: "opencode-go",
          api: "https://api.example.com",
          models: {
            a: { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
            b: { id: "mimo-v2-omni", name: "MiMo V2 Omni" },
            c: { id: "unknown-model", name: "Unknown Model" },
          },
        },
      },
      noAllowlist,
    );

    expect(result.models).toHaveLength(3);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("mimo-v2.5-pro");
    expect(ids).toContain("mimo-v2-omni");
    expect(ids).toContain("unknown-model");

    const mimoPro = result.models.find((m) => m.id === "mimo-v2.5-pro")!;
    expect(mimoPro.attachment).toBe(false);
    expect(mimoPro.reasoning).toBe(true);
    expect(mimoPro.toolCall).toBe(true);
    expect(mimoPro.family).toBe("mimo-v2.5-pro");

    const mimoOmni = result.models.find((m) => m.id === "mimo-v2-omni")!;
    expect(mimoOmni.attachment).toBe(true);
    expect(mimoOmni.reasoning).toBe(true);

    const unknown = result.models.find((m) => m.id === "unknown-model")!;
    expect(unknown.attachment).toBe(false);
    expect(unknown.reasoning).toBe(false);
    expect(unknown.toolCall).toBe(false);
    expect(unknown.family).toBe("unknown");
  });

  it("marks newly listed GPT and Kimi models as multimodal", () => {
    const { OPENCODE_GO_MODEL_ALLOWLIST: _, ...noAllowlist } = env;
    const result = filterModelsCatalog(
      {
        "opencode-go": {
          id: "opencode-go",
          api: "https://api.example.com",
          models: {
            luna: { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
            kimi: { id: "kimi-k3", name: "Kimi K3" },
          },
        },
      },
      noAllowlist,
    );

    expect(result.models.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
      attachment: true,
      reasoning: true,
      toolCall: true,
    });
    expect(result.models.find((model) => model.id === "kimi-k3")).toMatchObject({
      attachment: true,
      reasoning: true,
      toolCall: true,
      interleaved: { field: "reasoning_content" },
    });
  });

  it("uses the Responses transport for GPT 5.6 Luna", () => {
    expect(modelTransportFor("gpt-5.6-luna")).toBe("responses");
    expect(modelTransportFor("opencode-go/gpt-5.6-luna")).toBe("responses");
    expect(modelTransportFor("kimi-k3")).toBe("chat-completions");
  });

  it("env var override overrides local registry", () => {
    const { OPENCODE_GO_MODEL_ALLOWLIST: _, ...noAllowlist } = env;
    const overrideEnv = {
      ...noAllowlist,
      OPENCODE_GO_MODEL_CAPABILITIES: '{"mimo-v2.5-pro":{"attachment":true}}',
    };
    const result = filterModelsCatalog(
      {
        "opencode-go": {
          id: "opencode-go",
          api: "https://api.example.com",
          models: {
            a: { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
          },
        },
      },
      overrideEnv,
    );

    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.attachment).toBe(true);
  });

  it("normalizes OpenAI-style model list to internal catalog shape", () => {
    const normalized = normalizeModelsCatalogResponse({
      object: "list",
      data: [
        { id: "minimax-m2.7", object: "model", created: 1777311000, owned_by: "opencode" },
        { id: "kimi-k2.6", object: "model", created: 1777311000, owned_by: "opencode" },
      ],
    });
    expect(normalized["opencode-go"]?.models?.["0"]?.id).toBe("minimax-m2.7");
    expect(normalized["opencode-go"]?.models?.["1"]?.id).toBe("kimi-k2.6");
  });

  it("classifies supported attachment types", () => {
    expect(isImageAttachment("image/png")).toBe(true);
    expect(isInlineTextAttachment("text/plain", 100)).toBe(true);
    expect(isInlineTextAttachment("application/pdf", 100)).toBe(false);
    expect(isInlineTextAttachment("text/plain", 200_000)).toBe(false);
  });

  it("preserves workspace defaults", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
      defaultReasoningLevel: "high",
      defaultSearchMode: true,
    });

    expect(workspace.defaultSearchMode).toBe(true);
    expect(workspace.defaultModelId).toBe("openai/gpt-4.1");
    expect(workspace.defaultReasoningLevel).toBe("high");
  });

  it("explains Kimi reasoning/tool incompatibility errors for the UI", () => {
    const explained = explainAssistantError({
      errorCode: "stream_error",
      errorMessage:
        'HTTP 400: {"error":{"message":"thinking is enabled but reasoning_content is missing"}}',
    });

    expect(explained.summary).toContain("thinking mode is incompatible");
    expect(explained.explanation).toContain("does attempt to preserve that field now");
  });

  it("normalizes provider reasoning incompatibility on the server", () => {
    const normalized = normalizeAssistantError({
      errorCode: "stream_error",
      errorMessage:
        'HTTP 400: {"error":{"message":"reasoning_content is missing for continuation"}}',
      modelId: "moonshot/kimi-k2.5",
    });

    expect(normalized.errorCode).toBe("provider_reasoning_incompatible");
    expect(normalized.retryable).toBe(false);
    expect(normalized.providerName).toBe("moonshot");
  });

  it("extracts fallback Exa MCP search text", () => {
    const text = parseExaMcpTextResponse(
      [
        "event: message",
        'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Source 1\\nhttps://example.com\\nSnippet"}]}}',
        "",
      ].join("\n"),
    );

    expect(text).toContain("https://example.com");
    expect(text).toContain("Snippet");
  });

  it("extracts text from chat completion content arrays", () => {
    const text = extractChatCompletionText([
      { type: "text", text: "what time is it right now" },
      { type: "ignored", text: "nope" },
    ]);

    expect(text).toBe("what time is it right now");
  });

  it("extracts reasoning token counts from nested usage payloads", () => {
    expect(
      extractReasoningTokens({
        completion_tokens_details: {
          reasoning_tokens: 128,
        },
      }),
    ).toBe(128);

    expect(
      extractReasoningTokens({
        outputTokensDetails: {
          reasoningTokens: "64",
        },
      }),
    ).toBe(64);

    expect(extractReasoningTokens({ completion_tokens: 42 })).toBe(null);
  });

  it("uses TanStack's official adapter and middleware to bound parallel tool calls", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ExternalValue[] = [];
    let requestCount = 0;
    let executions = 0;
    replaceFetch(
      vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
        requests.push(decodeRequestBody(init));
        requestCount += 1;
        const body =
          requestCount === 1
            ? [
                'data: {"id":"chatcmpl_tools","object":"chat.completion.chunk","created":1,"model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}]}',
                'data: {"id":"chatcmpl_tools","object":"chat.completion.chunk","created":1,"model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
                "data: [DONE]",
                "",
              ].join("\n\n")
            : [
                'data: {"id":"chatcmpl_answer","object":"chat.completion.chunk","created":2,"model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"Done."},"finish_reason":null}]}',
                'data: {"id":"chatcmpl_answer","object":"chat.completion.chunk","created":2,"model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                "data: [DONE]",
                "",
              ].join("\n\n");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const lookup = toolDefinition({
      name: "lookup",
      description: "Look up one fact.",
    }).server(async () => {
      executions += 1;
      return { ok: true };
    });

    try {
      let text = "";
      for await (const chunk of chat({
        adapter: createOpenCodeAdapter({ env, modelId: "kimi-k3" }),
        messages: [{ role: "user", content: "look it up" }],
        tools: [lookup],
        middleware: [toolBudgetMiddleware({ lookup: 1 })],
      })) {
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) text += chunk.delta;
      }

      expect(text).toBe("Done.");
      expect(executions).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ tools: [{ function: { name: "lookup" } }] });
      expect(requests[1]).not.toHaveProperty("tools");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clamps exa result counts", () => {
    expect(clampExaResults(1)).toBe(3);
    expect(clampExaResults(5)).toBe(5);
    expect(clampExaResults(99)).toBe(8);
  });

  it("signs attachment URLs for authenticated model fetches", async () => {
    const signedUrl = await getSignedAttachmentUrl(env, "thd_123/cat.png");
    const url = new URL(signedUrl);
    const token = url.searchParams.get("token");

    expect(url.origin).toBe("https://chat.example.com");
    expect(url.pathname).toBe("/api/uploads/blob/thd_123%2Fcat.png");
    expect(token).toBeTruthy();

    if (!token) throw new Error("Expected a signed upload token");
    const payload = await verifyUploadToken(env, token);

    expect(payload?.action).toBe("read_attachment");
    expect(payload?.objectKey).toBe("thd_123/cat.png");
    expect(Number(payload?.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("loads stored image bytes as inline model input", async () => {
    const inline = await getInlineAttachment(
      {
        ...env,
        UPLOADS: {
          get: async () => ({
            arrayBuffer: async () => new Blob([new Uint8Array([0, 1, 255])]).arrayBuffer(),
            httpMetadata: { contentType: "image/jpeg" },
          }),
        },
      },
      "thd_123/cat.jpg",
      "image/png",
    );

    expect(inline).toEqual({ mimeType: "image/jpeg", base64: "AAH/" });
  });

  it("sends useAutoprompt and contents options to the Exa API", async () => {
    const originalFetch = globalThis.fetch;
    let captured: CapturedExaRequest | null = null;
    replaceFetch(
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        captured = {
          url: resolveRequestUrl(url),
          body: Schema.decodeUnknownSync(ExaRequestSchema)(decodeRequestBody(init)),
        };
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Example",
                url: "https://example.com",
                highlights: ["hello world"],
                publishedDate: "2026-04-10",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    try {
      const results = await exaSearch(env, "Oscar Piastri 2026 F1 standings", 5);
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toBe("hello world");
      expect(results[0].domain).toBe("example.com");
      const actual = requireCaptured<CapturedExaRequest>(captured, "Expected Exa request capture");
      expect(actual.url).toBe("https://api.exa.ai/search");
      expect(actual.body.useAutoprompt).toBe(true);
      expect(actual.body.type).toBe("auto");
      expect(actual.body.numResults).toBe(5);
      expect(actual.body.contents).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies Exa HTTP failures with retry and reason metadata", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    replaceFetch(
      vi.fn(async () => {
        calls += 1;
        return new Response("nope", { status: 429 });
      }),
    );

    try {
      await expect(exaSearch(env, "anything", 5)).rejects.toMatchObject({
        name: "ExaSearchError",
        reason: "rate_limited",
        retryable: true,
      });
      // Retries once on 429 before giving up.
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry Exa 4xx non-rate-limited failures", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    replaceFetch(
      vi.fn(async () => {
        calls += 1;
        return new Response("bad request", { status: 400 });
      }),
    );

    try {
      await expect(exaSearch(env, "anything", 5)).rejects.toBeInstanceOf(ExaSearchError);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("search tool returns structured grounding on success", async () => {
    const originalFetch = globalThis.fetch;
    replaceFetch(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  title: "F1 Standings",
                  url: "https://f1.example.com/standings",
                  highlights: ["Piastri leads with 89 points"],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    try {
      const { tool, state } = createExaSearchTool({
        env,
        assistantMessageId: "msg_1",
      });
      const execute = requireToolExecutor(tool);
      const result = decodeSearchToolResult(
        await execute({ query: "Piastri 2026 F1 WDC standings" }),
      );

      expect(result.ok).toBe(true);
      expect(result.resultCount).toBe(1);
      expect(tool.description).toContain("current or externally verifiable information");
      expect(tool.description).toContain("answer directly from existing context otherwise");
      expect(tool.description).not.toContain("reformulate");
      expect(String(result.context)).toContain("Tool: exa_web_search");
      expect(String(result.context)).toContain("Piastri leads with 89 points");
      expect(state.searchRuns).toHaveLength(1);
      expect(state.searchRuns[0]?.status).toBe("completed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clamps search budget to the supported UI range", () => {
    expect(clampSearchesPerTurn(undefined)).toBe(DEFAULT_SEARCHES_PER_TURN);
    expect(clampSearchesPerTurn(0)).toBe(1);
    expect(clampSearchesPerTurn(4.8)).toBe(4);
    expect(clampSearchesPerTurn(10)).toBe(MAX_SEARCHES_PER_TURN);
  });

  it("search tool returns a structured failure instead of throwing on Exa errors", async () => {
    const originalFetch = globalThis.fetch;
    replaceFetch(vi.fn(async () => new Response("upstream fail", { status: 500 })));

    try {
      const { tool, state } = createExaSearchTool({
        env,
        assistantMessageId: "msg_err",
      });
      const result = decodeSearchToolResult(
        await requireToolExecutor(tool)({ query: "whatever query terms" }),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("exa_http");
      expect(result.hint).toBeTypeOf("string");
      expect(result.hint?.length).toBeGreaterThan(0);
      // Records the failed run for debugging.
      expect(state.searchRuns).toHaveLength(1);
      expect(state.searchRuns[0]?.status).toBe("failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("search tool rejects empty and too-short queries", async () => {
    const { tool } = createExaSearchTool({
      env,
      assistantMessageId: "msg_short",
    });
    const executeRaw = requireToolExecutor(tool);
    const execute = (args: { query: string; numResults?: number }) =>
      executeRaw(args).then(decodeSearchToolResult);

    const empty = await execute({ query: "" });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBe("empty_query");

    const whitespace = await execute({ query: "   " });
    expect(whitespace.ok).toBe(false);
    expect(whitespace.reason).toBe("empty_query");

    const short = await execute({ query: "a" });
    expect(short.ok).toBe(false);
    expect(short.reason).toBe("query_too_short");

    expect(convertSchemaToJsonSchema(tool.inputSchema)).toMatchObject({
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 400 },
        numResults: { type: "number", minimum: 3, maximum: 8 },
      },
    });
  });

  it("classifies Exa aborts/timeouts as a retryable timeout reason", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    // fetchWithTimeout wraps fetch with an AbortController; simulate the
    // post-abort rejection shape (Error with "timed out" in the message).
    replaceFetch(
      vi.fn(async () => {
        calls += 1;
        throw new Error("Request timed out after 15000ms");
      }),
    );

    try {
      await expect(exaSearch(env, "anything", 5)).rejects.toMatchObject({
        name: "ExaSearchError",
        reason: "timeout",
        retryable: true,
      });
      // Timeouts are retryable, so the retry loop should run to EXA_MAX_ATTEMPTS (2).
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("search tool falls back to the Exa MCP endpoint when EXA_API_KEY is unset", async () => {
    const originalFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    replaceFetch(
      vi.fn(async (url: RequestInfo | URL) => {
        const href = resolveRequestUrl(url);
        fetchedUrls.push(href);
        // MCP returns text/event-stream with a JSON-RPC "tools/call" result payload.
        const body = [
          "event: message",
          'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Source 1\\nhttps://mcp.example.com/hit\\nMCP snippet content"}]}}',
          "",
        ].join("\n");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    try {
      const envNoKey = { ...env, EXA_API_KEY: "" };
      const { tool, state } = createExaSearchTool({
        env: envNoKey,
        assistantMessageId: "msg_mcp",
      });
      const result = decodeSearchToolResult(
        await requireToolExecutor(tool)({ query: "mcp fallback query" }),
      );

      expect(result.ok).toBe(true);
      expect(fetchedUrls.some((u) => u.includes("mcp.exa.ai"))).toBe(true);
      expect(fetchedUrls.every((u) => !u.includes("api.exa.ai/search"))).toBe(true);
      expect(String(result.context)).toContain("https://mcp.example.com/hit");
      expect(String(result.context)).toContain("MCP snippet content");
      expect(state.searchRuns).toHaveLength(1);
      expect(state.searchRuns[0]?.status).toBe("completed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ---------------------------------------------------------------------------
  // Browser Rendering extract tool
  // ---------------------------------------------------------------------------

  it("normalizeExtractUrl prepends https and rejects garbage", () => {
    expect(normalizeExtractUrl("example.com/docs")?.toString()).toBe("https://example.com/docs");
    expect(normalizeExtractUrl("  https://foo.bar/baz ")?.toString()).toBe("https://foo.bar/baz");
    expect(normalizeExtractUrl("")).toBeNull();
    // Non-http(s) schemes rejected
    expect(normalizeExtractUrl("ftp://x.y/z")).toBeNull();
    expect(normalizeExtractUrl("not a url at all")).toBeNull();
  });

  it("truncateExtractedMarkdown caps long payloads and preserves short ones", () => {
    const short = truncateExtractedMarkdown("# short page\n\nhello");
    expect(short.truncated).toBe(false);
    expect(short.text).toBe("# short page\n\nhello");

    const big = truncateExtractedMarkdown("x".repeat(20_000));
    expect(big.truncated).toBe(true);
    expect(big.originalLength).toBe(20_000);
    // Truncated text includes a visible marker so the model knows content was cut.
    expect(big.text).toContain("truncated");
    expect(big.text.length).toBeLessThan(20_000);
  });

  it("cloudflareBrowserMarkdown errors cleanly when the binding is missing", async () => {
    const envNoBinding = { ...env, BROWSER: undefined };
    await expect(cloudflareBrowserMarkdown(envNoBinding, "https://x.test")).rejects.toMatchObject({
      name: "BrowserRenderError",
      reason: "not_configured",
      retryable: false,
    });
  });

  it("cloudflareBrowserMarkdown rejects invalid URLs before touching the binding", async () => {
    // Even with a binding present, bad URLs should short-circuit without
    // attempting a browser launch.
    await expect(cloudflareBrowserMarkdown(env, "not a url at all")).rejects.toMatchObject({
      name: "BrowserRenderError",
      reason: "invalid_url",
      retryable: false,
    });
  });

  it("extract tool returns truncated-aware markdown content on success", async () => {
    const calls: string[] = [];
    const { tool, state } = createBrowserExtractTool({
      env,
      assistantMessageId: "msg_extract_ok",
      extract: async (_env, url) => {
        calls.push(url);
        return "# Example\n\nBody content here.";
      },
    });

    const result = decodeExtractToolResult(
      await requireToolExecutor(tool)({ url: "https://example.com/article" }),
    );

    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://example.com/article");
    expect(result.content).toContain("Example");
    expect(result.truncated).toBe(false);
    expect(calls).toEqual(["https://example.com/article"]);
    expect(state.extractRuns).toHaveLength(1);
    expect(state.extractRuns[0]?.status).toBe("completed");
  });

  it("extract tool rejects malformed URLs without touching the browser", async () => {
    let renders = 0;
    const { tool, state } = createBrowserExtractTool({
      env,
      assistantMessageId: "msg_extract_invalid",
      extract: async () => {
        renders += 1;
        return "";
      },
    });
    const result = decodeExtractToolResult(await requireToolExecutor(tool)({ url: "not a url" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_url");
    expect(renders).toBe(0);
    expect(state.extractRuns).toHaveLength(0);
  });

  it("extract tool maps Browser Rendering HTTP failures into structured errors", async () => {
    const { tool, state } = createBrowserExtractTool({
      env,
      assistantMessageId: "msg_extract_err",
      extract: async () => {
        throw new BrowserRenderError("target returned HTTP 500", {
          status: 500,
          retryable: true,
          reason: "http",
        });
      },
    });
    const result = decodeExtractToolResult(
      await requireToolExecutor(tool)({ url: "https://example.com/broken" }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("extract_http");
    expect(result.hint).toBeTypeOf("string");
    expect(state.extractRuns).toHaveLength(1);
    expect(state.extractRuns[0]?.status).toBe("failed");
  });

  it("extract tool surfaces not_configured when the binding is missing", async () => {
    const { tool } = createBrowserExtractTool({
      env: { ...env, BROWSER: undefined },
      assistantMessageId: "msg_extract_unconfigured",
      // No injection — falls through to cloudflareBrowserMarkdown which
      // throws BrowserRenderError("not_configured").
    });
    const result = decodeExtractToolResult(
      await requireToolExecutor(tool)({ url: "https://example.com/x" }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_configured");
  });

  it("BrowserRenderError classifies response bodies as retryable vs not", () => {
    const authErr = new BrowserRenderError("unauthorized", {
      status: 401,
      retryable: false,
      reason: "auth",
    });
    expect(authErr.retryable).toBe(false);
    expect(authErr.reason).toBe("auth");
  });

  it("keeps empty final streams in Effect's typed failure channel", async () => {
    const eventTypes: SyncEventType[] = [];
    const activities: SearchProgressEvent[] = [];

    const result = await consumeAssistantStream(
      (async function* () {
        const chunk: StreamChunk = {
          type: EventType.RUN_FINISHED,
          threadId: "thread_empty",
          runId: "run_empty",
          finishReason: "stop",
          timestamp: Date.now(),
        };
        yield chunk;
      })(),
      {
        messageId: "msg_empty",
        appendServerEvent: async (_opId, eventType, payload) => {
          const event = testServerEvent(eventTypes.length + 1, eventType, payload);
          eventTypes.push(eventType);
          return event;
        },
        broadcast: () => {},
        appendMessagePart: async (kind, input) => ({
          id: `part_${activities.length + 1}`,
          messageId: "msg_empty",
          seq: activities.length,
          kind,
          text: input.text ?? "",
          json: input.json ?? null,
        }),
        rawAppendMessagePart: async (kind, input) => ({
          id: `part_${activities.length + 1}`,
          messageId: "msg_empty",
          seq: activities.length,
          kind,
          text: input.text ?? "",
          json: input.json ?? null,
        }),
        reportActivity: async (activity) => {
          activities.push(activity);
        },
      },
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected failed stream result");
    expect(result.error.errorCode).toBe("assistant_no_output");
    const turnError = await Effect.runPromise(
      Effect.flip(requireSuccessfulAssistantStream(result)),
    );
    expect(turnError).toBeInstanceOf(AssistantTurnError);
    expect(turnError.errorCode).toBe("assistant_no_output");
    expect(eventTypes.includes("message_failed")).toBe(false);
    expect(activities.some((activity) => activity.label === "Response failed")).toBe(true);
  });
});
