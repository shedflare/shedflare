import { createId, nowIso, summarizeThreadTitle, type SyncServerEnvelope } from "#/domain";
import { chat, getDefaultModelId, modelTransportFor, type AppEnv } from "#/runtime";
import { getTitleGenerationModelOptions } from "./model-config";
import { syncLog, sanitizeGeneratedTitle } from "./sync-utils";
import type { ChatRepository } from "./chat-repository";
import { normalizeThread } from "./persistence-codecs";
import type { EventStore } from "./event-store";
import { createOpenCodeAdapter } from "./ai-provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TitleGenerationInput {
  threadId: string;
  promptText: string;
  chatModelId: string;
  chatModelInterleavedField?: string | null;
}

export interface TitleGenerationContext {
  access: ChatRepository;
  eventStore: EventStore;
  env: AppEnv;
  broadcast: (envelope: SyncServerEnvelope) => void;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function generateThreadTitle(
  input: TitleGenerationInput,
  ctx: TitleGenerationContext,
) {
  const thread = ctx.access.getThread(input.threadId);
  if (!thread || thread.title !== "New Chat") return;
  const settings = ctx.access.getAccountSettings();
  const modelId =
    settings?.titleGenerationModelId?.trim() || input.chatModelId || getDefaultModelId(ctx.env);
  let title = summarizeThreadTitle(input.promptText);

  const modelInterleavedField = settings?.titleGenerationModelId?.trim()
    ? settings.titleGenerationModelInterleavedField
    : input.chatModelInterleavedField;
  const transport = modelTransportFor(modelId);
  const titleModelOptions = getTitleGenerationModelOptions(modelInterleavedField);
  const modelOptions =
    transport === "responses"
      ? { ...titleModelOptions, max_output_tokens: 64 }
      : { ...titleModelOptions, max_tokens: 64, temperature: 0.2 };
  const systemPrompt = [
    "Generate a concise chat thread title for the user's prompt.",
    "Rules: 3 to 7 words. No quotes. No trailing punctuation. Return only the title.",
  ].join("\n");
  const promptText = input.promptText.slice(0, 4000);

  try {
    const generated = await chat({
      adapter: createOpenCodeAdapter({ env: ctx.env, modelId, sessionId: input.threadId }),
      stream: false,
      systemPrompts: [systemPrompt],
      messages: [{ role: "user", content: promptText }],
      modelOptions,
      threadId: input.threadId,
    });
    title = sanitizeGeneratedTitle(generated) ?? title;
  } catch (error) {
    syncLog("title_generation_failed", {
      threadId: input.threadId,
      modelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const current = ctx.access.getThread(input.threadId);
  if (!current || current.title !== "New Chat") return;
  const updatedAt = nowIso();
  const event = await ctx.eventStore.appendServerEvent(null, "thread_upserted", {
    row: normalizeThread({ ...current, title, updatedAt }, createId("srvop")),
  });
  ctx.broadcast(event);
}
