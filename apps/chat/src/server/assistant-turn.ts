import {
  createId,
  createMessagePart,
  createTraceRun,
  createTraceSpan,
  clampSearchesPerTurn,
  MAX_BROWSER_RENDERS_PER_TURN,
  MAX_TOOL_ITERATIONS_PER_TURN,
  nowIso,
  type JsonObject,
  type CreateUserMessagePayload,
  type Message,
  type SyncServerEnvelope,
  type Thread,
  type TraceRun,
  type TraceSpan,
} from "#/domain";
import { chat, getDefaultModelId, type AppEnv } from "#/runtime";
import { combineStrategies, maxIterations, untilFinishReason } from "@tanstack/ai";
import {
  clearToolResults,
  composeStrategies,
  evictOldest,
  withCompaction,
} from "@tanstack/ai-compaction";
import { toolCacheMiddleware } from "@tanstack/ai/middlewares";
import { withPersistence } from "@tanstack/ai-persistence";
import {
  AssistantTurnError,
  createStructuredLogger,
  makeRootTraceContext,
  makeTraceRecorder,
  runAppEffect,
  traceEffect,
} from "#/effect";
import { Effect } from "effect";
import { createExaSearchTool, type ToolProgressEvent } from "./search";
import { createBrowserExtractTool } from "./extract";
import { normalizeAssistantError } from "./error-normalization";
import {
  consumeAssistantStream,
  requireSuccessfulAssistantStream,
  type StreamConsumerDeps,
} from "./stream-consumer";
import { getProviderModelOptions } from "./model-config";
import {
  syncLog,
  json,
  parseJsonRecord,
  parseJsonRecords,
  previewText,
  looksLikeMissingRealtimeAccess,
} from "./sync-utils";
import type { ChatRepository } from "./chat-repository";
import { buildModelMessages, mergePersistedModelHistory } from "./model-message-builder";
import type { EventStore } from "./event-store";
import { createOpenCodeAdapter } from "./ai-provider";
import { createChatPersistence } from "./chat-persistence";
import type { EffectDatabase } from "./effect-database";
import { modelCapabilityFor } from "./model-capabilities";
import { liveGroundingMiddleware, toolBudgetMiddleware } from "./tool-budget";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantTurnPayload = Pick<
  CreateUserMessagePayload,
  | "threadId"
  | "modelId"
  | "modelInterleavedField"
  | "reasoningLevel"
  | "search"
  | "searchLimit"
  | "preferFreeSearch"
> & {
  thread: Thread;
  userMessage: Message;
  assistantMessage: Message;
};

export interface AssistantTurnContext {
  access: ChatRepository;
  database: EffectDatabase;
  eventStore: EventStore;
  env: AppEnv;
  broadcast: (envelope: SyncServerEnvelope) => void;
  assistantTurnControllers: Map<string, AbortController>;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runAssistantTurn(payload: AssistantTurnPayload, ctx: AssistantTurnContext) {
  const abortController = new AbortController();
  ctx.assistantTurnControllers.set(payload.assistantMessage.id, abortController);
  try {
    const traceContext = makeRootTraceContext({
      messageId: payload.assistantMessage.id,
      threadId: payload.threadId,
      modelId: payload.modelId,
      opId: payload.assistantMessage.opId ?? null,
    });
    const rootSpanId = createId("span");
    const childTraceContext = {
      ...traceContext,
      parentSpanId: rootSpanId,
    };
    const traceRuns = new Map<string, TraceRun>();
    const traceSpans = new Map<string, TraceSpan>();
    const turnLogger = createStructuredLogger("assistant-turn", {
      traceId: traceContext.traceId,
      traceRunId: traceContext.traceRunId,
      rootSpanId,
      messageId: payload.assistantMessage.id,
      threadId: payload.threadId,
      modelId: payload.modelId,
    });

    const upsertTraceRun = async (row: TraceRun) => {
      traceRuns.set(row.id, row);
      const event = await ctx.eventStore.appendServerEvent(null, "trace_run_upserted", { row });
      ctx.broadcast(event);
    };

    const upsertTraceSpan = async (row: TraceSpan) => {
      traceSpans.set(row.id, row);
      const event = await ctx.eventStore.appendServerEvent(null, "trace_span_upserted", { row });
      ctx.broadcast(event);
    };

    const recorder = makeTraceRecorder({
      scope: "assistant-turn",
      logger: turnLogger,
      onTraceRunStart: async (row) => {
        await upsertTraceRun(
          createTraceRun({
            id: row.id,
            messageId: row.messageId,
            threadId: row.threadId,
            workspaceId: row.workspaceId,
            traceId: row.traceId,
            rootSpanId: row.rootSpanId,
            modelId: row.modelId,
            status: row.status,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationMs: row.durationMs,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            attrs: parseJsonRecord(row.attrsJson ?? "{}"),
          }),
        );
      },
      onTraceRunFinish: async (row) => {
        const current = traceRuns.get(row.id);
        if (!current) return;
        const { decodeTraceRunRow } = await import("#/domain");
        await upsertTraceRun(
          decodeTraceRunRow({
            ...current,
            ...row,
          }),
        );
      },
      onSpanStart: async (row) => {
        await upsertTraceSpan(
          createTraceSpan({
            id: row.id,
            traceRunId: row.traceRunId,
            traceId: row.traceId,
            parentSpanId: row.parentSpanId,
            messageId: row.messageId,
            name: row.name,
            kind: row.kind,
            status: row.status,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationMs: row.durationMs,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            attrs: parseJsonRecord(row.attrsJson ?? "{}"),
            events: parseJsonRecords(row.eventsJson ?? "[]"),
          }),
        );
      },
      onSpanFinish: async (row) => {
        const current = traceSpans.get(row.id);
        if (!current) return;
        const { decodeTraceSpanRow } = await import("#/domain");
        await upsertTraceSpan(
          decodeTraceSpanRow({
            ...current,
            ...row,
          }),
        );
      },
    });

    const traceRuntime = {
      env: ctx.env,
      traceRecorder: recorder,
      traceContext: childTraceContext,
    } satisfies Parameters<typeof runAppEffect>[1];

    const traceAsync = <A>(
      name: string,
      kind: TraceSpan["kind"],
      attrs: JsonObject,
      run: () => Promise<A>,
    ) => runAppEffect(traceEffect(name, kind, attrs, Effect.tryPromise(run)), traceRuntime);

    const traceSync = <A>(name: string, kind: TraceSpan["kind"], attrs: JsonObject, run: () => A) =>
      runAppEffect(traceEffect(name, kind, attrs, Effect.sync(run)), traceRuntime);

    syncLog("assistant_turn_start", {
      threadId: payload.threadId,
      assistantMessageId: payload.assistantMessage.id,
      modelId: payload.modelId,
      reasoningLevel: payload.reasoningLevel,
      search: payload.search,
      searchLimit: payload.searchLimit ?? null,
      traceId: traceContext.traceId,
      traceRunId: traceContext.traceRunId,
    });

    await recorder.startTraceRun({
      traceRunId: traceContext.traceRunId,
      traceId: traceContext.traceId,
      rootSpanId,
      messageId: payload.assistantMessage.id,
      threadId: payload.threadId,
      workspaceId: payload.thread.workspaceId,
      modelId: payload.modelId || payload.assistantMessage.modelId || null,
      attrs: {
        reasoningLevel: payload.reasoningLevel,
        searchEnabled: payload.search,
        searchLimit: payload.searchLimit ?? null,
      },
    });
    await recorder.startSpan({
      spanId: rootSpanId,
      traceRunId: traceContext.traceRunId,
      traceId: traceContext.traceId,
      parentSpanId: null,
      messageId: payload.assistantMessage.id,
      name: "assistant.turn",
      kind: "root",
      attrs: {
        workspaceId: payload.thread.workspaceId,
        threadId: payload.threadId,
        messageId: payload.assistantMessage.id,
        modelId: payload.modelId || payload.assistantMessage.modelId || null,
        reasoningLevel: payload.reasoningLevel,
        searchEnabled: payload.search,
        searchLimit: payload.searchLimit ?? null,
      },
    });

    const failBeforeStream = async (errorCode: string, errorMessage: string) => {
      const current = ctx.access.getMessage(payload.assistantMessage.id);
      if (current && current.status !== "completed" && current.status !== "failed") {
        const failed = await ctx.eventStore.appendServerEvent(null, "message_failed", {
          messageId: payload.assistantMessage.id,
          errorCode,
          errorMessage,
          updatedAt: nowIso(),
        });
        ctx.broadcast(failed);
      }
      await recorder.finishSpan({
        spanId: rootSpanId,
        status: "failed",
        errorCode,
        errorMessage,
      });
      await recorder.finishTraceRun({
        traceRunId: traceContext.traceRunId,
        status: "failed",
        errorCode,
        errorMessage,
      });
    };

    const thread = ctx.access.getThread(payload.threadId);
    if (!thread) {
      await failBeforeStream("ThreadNotFound", "Thread not found");
      return;
    }
    const workspace = ctx.access.getWorkspace(thread.workspaceId);
    if (!workspace) {
      await failBeforeStream("WorkspaceNotFound", "Workspace not found");
      return;
    }
    const modelId = payload.modelId || workspace.defaultModelId || getDefaultModelId(ctx.env);
    childTraceContext.workspaceId = workspace.id;
    childTraceContext.modelId = modelId;
    let seq = 0;

    let commitPendingText: () => Promise<void> = async () => {};

    const rawAppendMessagePart = async (
      kind: "activity" | "thinking_tokens" | "text" | "reasoning",
      input: {
        text?: string;
        json?: string | null;
      },
    ) => {
      const part = createMessagePart({
        messageId: payload.assistantMessage.id,
        seq: seq++,
        kind,
        text: input.text ?? "",
        json: input.json ?? null,
      });
      const event = await ctx.eventStore.appendServerEvent(null, "message_part_appended", {
        row: part,
      });
      ctx.broadcast(event);
      return part;
    };

    const appendMessagePart = async (
      kind: "activity" | "thinking_tokens" | "text" | "reasoning",
      input: {
        text?: string;
        json?: string | null;
      },
    ) => {
      if (kind !== "text") {
        await commitPendingText();
      }
      return rawAppendMessagePart(kind, input);
    };

    const reportActivity = async (activity: ToolProgressEvent) => {
      await appendMessagePart("activity", {
        text: activity.label,
        json: json(activity),
      });
    };

    try {
      const threadMessages = await traceSync("assistant.thread_messages.load", "sync", {}, () =>
        ctx.access.getThreadMessages(thread, [payload.userMessage, payload.assistantMessage]),
      );
      const searchLimit = clampSearchesPerTurn(payload.searchLimit);
      const searchTool = payload.search
        ? createExaSearchTool({
            env: ctx.env,
            assistantMessageId: payload.assistantMessage.id,
            preferFreeExa: payload.preferFreeSearch ?? false,
            log: syncLog,
            trace: (name, attrs, run) =>
              traceAsync(
                name,
                name === "assistant.search.prepare" ? "internal" : "tool",
                attrs,
                run,
              ),
            onSearchStateChange: async (state) => {
              const searchRunEvent = await ctx.eventStore.appendServerEvent(
                null,
                "search_runs_replaced",
                {
                  messageId: payload.assistantMessage.id,
                  rows: state.searchRuns,
                },
              );
              ctx.broadcast(searchRunEvent);

              const searchEvent = await ctx.eventStore.appendServerEvent(
                null,
                "search_results_replaced",
                {
                  messageId: payload.assistantMessage.id,
                  rows: state.searchResults,
                },
              );
              ctx.broadcast(searchEvent);
            },
          })
        : null;

      const extractToolConfigured = Boolean(ctx.env.BROWSER);
      const extractTool =
        payload.search && extractToolConfigured
          ? createBrowserExtractTool({
              env: ctx.env,
              assistantMessageId: payload.assistantMessage.id,
              log: syncLog,
              trace: (name, attrs, run) =>
                traceAsync(
                  name,
                  name === "assistant.extract.prepare" ? "internal" : "tool",
                  attrs,
                  run,
                ),
              onExtractStateChange: async (state) => {
                const extractEvent = await ctx.eventStore.appendServerEvent(
                  null,
                  "extract_runs_replaced",
                  {
                    messageId: payload.assistantMessage.id,
                    rows: state.extractRuns,
                  },
                );
                ctx.broadcast(extractEvent);
              },
            })
          : null;

      const activeTools = [
        ...(searchTool ? [searchTool.tool] : []),
        ...(extractTool ? [extractTool.tool] : []),
      ];
      const toolCount = activeTools.length;

      const { messages: rebuiltModelMessages, systemPrompts } = await traceAsync(
        "assistant.attachments.resolve",
        "io",
        { threadMessageCount: threadMessages.length },
        () => buildModelMessages(workspace.id, threadMessages, ctx.access, ctx.env),
      );
      const persistence = createChatPersistence(ctx.database);
      const persistedModelMessages = await traceAsync(
        "assistant.model_history.load",
        "sync",
        { threadId: payload.threadId },
        () => persistence.stores.messages.loadThread(payload.threadId),
      );
      const modelMessages = mergePersistedModelHistory({
        persisted: persistedModelMessages,
        rebuilt: rebuiltModelMessages,
        latestUserMessageId: payload.userMessage.id,
      });

      const now = new Date();
      const datePrompt = `Current date: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. When searching for current/recent information, use this date as reference—do not default to years from your training data.`;
      systemPrompts.push(datePrompt);

      const adapter = createOpenCodeAdapter({
        env: ctx.env,
        modelId,
        sessionId: payload.threadId,
        trace: (name, kind, attrs, run) => traceAsync(name, kind, attrs, run),
      });
      const providerOptions = await traceSync(
        "assistant.provider.options",
        "model",
        {
          modelId,
          reasoningLevel: payload.reasoningLevel,
          toolCount,
          searchEnabled: payload.search,
          extractToolConfigured,
        },
        () =>
          getProviderModelOptions(modelId, payload.reasoningLevel, payload.modelInterleavedField),
      );
      const modelOptions = providerOptions.modelOptions;

      if (!modelOptions && payload.reasoningLevel !== "off") {
        syncLog("reasoning_mapping_unavailable", {
          assistantMessageId: payload.assistantMessage.id,
          modelId,
          requestedReasoningLevel: payload.reasoningLevel,
        });
      }

      syncLog("assistant_turn_upstream", {
        assistantMessageId: payload.assistantMessage.id,
        modelId,
        messageCount: modelMessages.length,
        systemPromptCount: systemPrompts.length,
        toolCount,
        toolNames: activeTools.map((tool) => tool.name),
        modelInterleavedField: payload.modelInterleavedField ?? null,
        requestedReasoningLevel: payload.reasoningLevel,
        effectiveReasoningLevel: providerOptions.effectiveReasoningLevel,
        overrideReason: providerOptions.overrideReason,
        modelOptions,
      });

      const consumerDeps: StreamConsumerDeps = {
        appendServerEvent: (opId, eventType, eventPayload) =>
          ctx.eventStore.appendServerEvent(opId, eventType, eventPayload),
        broadcast: (envelope) => ctx.broadcast(envelope),
        appendMessagePart,
        rawAppendMessagePart,
        setCommitPendingText: (fn) => {
          commitPendingText = fn;
        },
        reportActivity,
        messageId: payload.assistantMessage.id,
        suppressReasoningTokens: providerOptions.effectiveReasoningLevel === "off",
        log: syncLog,
      };

      const agentLoopStrategy =
        toolCount > 0
          ? combineStrategies([
              maxIterations(MAX_TOOL_ITERATIONS_PER_TURN),
              untilFinishReason(["stop", "length", "content_filter"]),
            ])
          : maxIterations(1);

      const toolLimits: Record<string, number> = {};
      if (searchTool) toolLimits.exa_web_search = searchLimit;
      if (extractTool) toolLimits.web_extract = MAX_BROWSER_RENDERS_PER_TURN;

      const contextLimit = modelCapabilityFor(modelId.split("/").at(-1) ?? modelId)?.limit?.context;
      const compactionLimit = Math.max(8_192, Math.floor((contextLimit ?? 128_000) * 0.8));
      const middleware = [
        withPersistence(persistence),
        withCompaction({
          maxTokens: compactionLimit,
          strategyKey: "clear-tools-then-evict-v1",
          strategy: composeStrategies(
            clearToolResults({ keepRecentToolResults: 3 }),
            evictOldest({ keepRecentTokens: Math.floor(compactionLimit / 2) }),
          ),
          onCompact: (info) =>
            syncLog("assistant_turn_context_compacted", {
              assistantMessageId: payload.assistantMessage.id,
              beforeTokens: info.before,
              afterTokens: info.after,
              messagesBefore: info.messagesBefore,
              messagesAfter: info.messagesAfter,
            }),
        }),
        ...(activeTools.length > 0
          ? [
              toolBudgetMiddleware(toolLimits),
              toolCacheMiddleware({ toolNames: activeTools.map((tool) => tool.name) }),
              liveGroundingMiddleware(),
            ]
          : []),
      ];

      const stream = chat({
        adapter,
        messages: modelMessages,
        systemPrompts,
        agentLoopStrategy,
        abortController,
        modelOptions: modelOptions ?? undefined,
        tools: activeTools.length > 0 ? activeTools : undefined,
        middleware,
        threadId: payload.threadId,
        runId: traceContext.traceRunId,
      });

      const streamOutcome = await runAppEffect(
        traceEffect(
          "assistant.stream.consume",
          "io",
          { modelId },
          Effect.tryPromise({
            try: () => consumeAssistantStream(stream, consumerDeps),
            catch: (error) => {
              const normalized = normalizeAssistantError({
                errorCode: "stream_persistence_error",
                errorMessage: error instanceof Error ? error.message : String(error),
                modelId,
              });
              return new AssistantTurnError({
                errorCode: normalized.errorCode,
                errorMessage: normalized.errorMessage,
                providerName: normalized.providerName,
                retryable: normalized.retryable,
              });
            },
          }).pipe(Effect.flatMap(requireSuccessfulAssistantStream)),
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (result) => ({ ok: true as const, result }),
          }),
        ),
        traceRuntime,
      );
      if (!streamOutcome.ok) {
        const normalizedError =
          streamOutcome.error instanceof AssistantTurnError
            ? {
                errorCode: streamOutcome.error.errorCode,
                errorMessage: streamOutcome.error.errorMessage,
                providerName: streamOutcome.error.providerName,
                retryable: streamOutcome.error.retryable,
              }
            : normalizeAssistantError({
                errorCode: "assistant_turn_error",
                errorMessage:
                  streamOutcome.error instanceof Error
                    ? streamOutcome.error.message
                    : String(streamOutcome.error),
                modelId,
              });
        const current = ctx.access.getMessage(payload.assistantMessage.id);
        if (current && current.status !== "completed" && current.status !== "failed") {
          const failed = await ctx.eventStore.appendServerEvent(null, "message_failed", {
            messageId: payload.assistantMessage.id,
            errorCode: normalizedError.errorCode,
            errorMessage: normalizedError.errorMessage,
            updatedAt: nowIso(),
          });
          ctx.broadcast(failed);
        }
        await recorder.finishSpan({
          spanId: rootSpanId,
          status: normalizedError.errorCode === "cancelled" ? "cancelled" : "failed",
          errorCode: normalizedError.errorCode,
          errorMessage: normalizedError.errorMessage,
        });
        await recorder.finishTraceRun({
          traceRunId: traceContext.traceRunId,
          status: normalizedError.errorCode === "cancelled" ? "cancelled" : "failed",
          errorCode: normalizedError.errorCode,
          errorMessage: normalizedError.errorMessage,
        });
        return;
      }
      const result = streamOutcome.result;
      const completed = await traceAsync(
        "assistant.message.complete",
        "sync",
        { messageId: payload.assistantMessage.id, durationMs: result.durationMs },
        () =>
          ctx.eventStore.appendServerEvent(null, "message_completed", {
            messageId: payload.assistantMessage.id,
            text: result.text,
            updatedAt: nowIso(),
            durationMs: result.durationMs,
            ttftMs: result.ttftMs,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          }),
      );
      ctx.broadcast(completed);
      const searchRuns = searchTool?.state.searchRuns ?? [];
      const extractRuns = extractTool?.state.extractRuns ?? [];

      syncLog("assistant_turn_search_summary", {
        assistantMessageId: payload.assistantMessage.id,
        toolCallIterations: result.toolCallIterations,
        toolNamesUsed: result.toolNamesUsed,
        searchRuns: searchRuns.map((run) => ({
          step: run.step,
          query: run.query,
          status: run.status,
          resultCount: run.resultCount,
        })),
        extractRuns: extractRuns.map((run) => ({
          step: run.step,
          url: run.url,
          status: run.status,
          originalLength: run.originalLength ?? null,
          truncated: run.truncated ?? null,
        })),
      });
      syncLog("assistant_turn_answer_sanity", {
        assistantMessageId: payload.assistantMessage.id,
        searched: searchRuns.length > 0,
        toolCallIterations: result.toolCallIterations,
        likelyIgnoredGrounding:
          searchRuns.length > 0 && looksLikeMissingRealtimeAccess(result.text),
        answerPreview: previewText(result.text),
      });
      await recorder.finishSpan({
        spanId: rootSpanId,
        status: "completed",
        attrs: {
          searchRunCount: searchRuns.length,
          toolCallIterations: result.toolCallIterations,
          answerPreview: previewText(result.text),
        },
      });
      await recorder.finishTraceRun({
        traceRunId: traceContext.traceRunId,
        status: "completed",
        attrs: {
          resultTextLength: result.text.length,
          searchRunCount: searchRuns.length,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const normalizedError = normalizeAssistantError({
        errorCode: "assistant_turn_error",
        errorMessage,
        modelId,
      });
      syncLog("assistant_turn_exception", {
        assistantMessageId: payload.assistantMessage.id,
        modelId,
        search: payload.search,
        error: errorMessage,
        normalizedErrorCode: normalizedError.errorCode,
        providerName: normalizedError.providerName,
        retryable: normalizedError.retryable,
        stack: error instanceof Error ? error.stack : undefined,
      });

      const current = ctx.access.getMessage(payload.assistantMessage.id);
      if (current && current.status !== "completed" && current.status !== "failed") {
        const failed = await ctx.eventStore.appendServerEvent(null, "message_failed", {
          messageId: payload.assistantMessage.id,
          errorCode: normalizedError.errorCode,
          errorMessage: normalizedError.errorMessage,
          updatedAt: nowIso(),
        });
        ctx.broadcast(failed);

        await appendMessagePart("activity", {
          text: "Response failed",
          json: json({
            label: "Response failed",
            state: "failed",
            detail: normalizedError.errorMessage,
          } satisfies ToolProgressEvent),
        });
      }
      await recorder.finishSpan({
        spanId: rootSpanId,
        status: normalizedError.errorCode === "cancelled" ? "cancelled" : "failed",
        errorCode: normalizedError.errorCode,
        errorMessage: normalizedError.errorMessage,
      });
      await recorder.finishTraceRun({
        traceRunId: traceContext.traceRunId,
        status: normalizedError.errorCode === "cancelled" ? "cancelled" : "failed",
        errorCode: normalizedError.errorCode,
        errorMessage: normalizedError.errorMessage,
      });
    }
  } catch (error) {
    const normalizedError = normalizeAssistantError({
      errorCode: "assistant_turn_setup_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      modelId: payload.modelId,
    });
    syncLog("assistant_turn_outer_exception", {
      assistantMessageId: payload.assistantMessage.id,
      threadId: payload.threadId,
      errorCode: normalizedError.errorCode,
      errorMessage: normalizedError.errorMessage,
    });
    try {
      const current = ctx.access.getMessage(payload.assistantMessage.id);
      if (current && current.status !== "completed" && current.status !== "failed") {
        const failed = await ctx.eventStore.appendServerEvent(null, "message_failed", {
          messageId: payload.assistantMessage.id,
          errorCode: normalizedError.errorCode,
          errorMessage: normalizedError.errorMessage,
          updatedAt: nowIso(),
        });
        ctx.broadcast(failed);
      }
    } catch (persistenceError) {
      syncLog("assistant_turn_terminal_persistence_failed", {
        assistantMessageId: payload.assistantMessage.id,
        error:
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
      });
    }
    throw error;
  } finally {
    ctx.assistantTurnControllers.delete(payload.assistantMessage.id);
  }
}
