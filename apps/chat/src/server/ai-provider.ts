import { OPENCODE_GO_BASE_URL, modelTransportFor, type AppEnv } from "#/runtime";
import type { ModelMessage } from "@tanstack/ai";
import {
  OpenAICompatibleChatAdapter,
  OpenAICompatibleResponsesAdapter,
} from "@tanstack/ai-openai/compatible";
import type { JsonObject, TraceSpan } from "#/domain";
import { Option } from "effect";
import * as Schema from "effect/Schema";
import OpenAI from "openai";

const MODEL_REQUEST_TIMEOUT_MS = 180_000;

const OpenCodeReasoningChunkSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      delta: Schema.Struct({ reasoning_content: Schema.optional(Schema.String) }),
    }),
  ),
});

/**
 * OpenCode's interleaved-thinking models use the common `reasoning_content`
 * Chat Completions extension. TanStack's compatible adapter intentionally
 * exposes protected hooks for this provider-specific wire variance.
 */
class OpenCodeChatAdapter extends OpenAICompatibleChatAdapter<string> {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- TanStack's protected provider hook requires unknown input, decoded immediately below.
  protected override extractReasoning(chunk: unknown): { text: string } | undefined {
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(OpenCodeReasoningChunkSchema)(chunk),
    );
    const reasoning = decoded?.choices[0]?.delta.reasoning_content;
    return reasoning ? { text: reasoning } : undefined;
  }

  protected override convertMessage(message: ModelMessage) {
    const converted = super.convertMessage(message);
    if (message.role !== "assistant" || converted.role !== "assistant") return converted;
    const reasoningContent = message.thinking
      ?.map((part) => part.content)
      .filter(Boolean)
      .join("");
    return reasoningContent ? { ...converted, reasoning_content: reasoningContent } : converted;
  }
}

const OPENCODE_CLIENT_ID = "shedflare-chat";

export function createOpenCodeAdapter(input: {
  env: Pick<AppEnv, "OPENCODE_GO_API_KEY">;
  modelId: string;
  /**
   * Stable per-conversation id sent as `x-opencode-session` for OpenCode Go
   * prompt-cache affinity. Must stay stable across turns of the same thread;
   * callers pass threadId. Falls back to a per-adapter UUID so the header is
   * never missing (missing headers may error after 09/06).
   */
  sessionId?: string;
  trace?: <A>(
    name: string,
    kind: TraceSpan["kind"],
    attrs: JsonObject,
    run: () => Promise<A>,
  ) => Promise<A>;
}) {
  const transport = modelTransportFor(input.modelId);
  const sessionId = input.sessionId?.trim() || crypto.randomUUID();
  const withSessionHeaders = (headers: Headers) => {
    if (!headers.has("x-opencode-session")) headers.set("x-opencode-session", sessionId);
    if (!headers.has("x-opencode-client")) headers.set("x-opencode-client", OPENCODE_CLIENT_ID);
    return headers;
  };
  const providerFetch: typeof fetch = (request, init) => {
    const run = () => {
      if (request instanceof Request) {
        const headers = withSessionHeaders(new Headers(request.headers));
        return fetch(new Request(request, { headers }), init);
      }
      const headers = withSessionHeaders(new Headers(init?.headers));
      return fetch(request, { ...init, headers });
    };
    return input.trace
      ? input.trace(
          "assistant.upstream.model",
          "model",
          { modelId: input.modelId, transport, sessionId },
          run,
        )
      : run();
  };

  const client = new OpenAI({
    baseURL: OPENCODE_GO_BASE_URL,
    apiKey: input.env.OPENCODE_GO_API_KEY,
    // Cloudflare Workers expose browser globals, but this adapter is created
    // only in server code and the key remains in a Worker secret binding.
    dangerouslyAllowBrowser: true,
    fetch: providerFetch,
    maxRetries: 0,
    timeout: MODEL_REQUEST_TIMEOUT_MS,
    defaultHeaders: {
      "x-opencode-session": sessionId,
      "x-opencode-client": OPENCODE_CLIENT_ID,
    },
  });
  return transport === "responses"
    ? new OpenAICompatibleResponsesAdapter(client, input.modelId, "opencode-go")
    : new OpenCodeChatAdapter(client, input.modelId, "opencode-go");
}
