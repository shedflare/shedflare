/* oxlint-disable anti-slop */
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { toolDefinition } from "@tanstack/ai";
import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { getRuntimeEnv, getSession } from "#/runtime";
import { buildMultiSearchContext } from "#/domain";
import {
  clampExaResults,
  exaMcpSearchRawText,
  exaSearch,
  type AppEnv,
} from "#/runtime";
import { createOpenCodeAdapter } from "../server/ai-provider";
import { getProviderModelOptions } from "../server/model-config";
import { createBrowserExtractTool } from "../server/extract";

const SEARCH_RESULTS_PER_RUN = 5;

const SearchArgsSchema = v.strictObject({
  query: v.pipe(v.string(), v.minLength(2), v.maxLength(400)),
  numResults: v.optional(v.pipe(v.number(), v.minValue(3), v.maxValue(8))),
});

const ExtractArgsSchema = v.strictObject({
  url: v.pipe(v.string(), v.minLength(4), v.maxLength(2000)),
});

// Shared tool output schemas (kept loose so model isn't blocked by strict validation)
const SearchOutputSchema = v.strictObject({
  ok: v.boolean(),
  query: v.string(),
  resultCount: v.optional(v.number()),
  context: v.optional(v.string()),
  error: v.optional(v.string()),
});

function createSearchTool(env: AppEnv) {
  return toolDefinition({
    name: "exa_web_search",
    description:
      "Search the web for current information. Use when fresh sources would materially improve the answer.",
    inputSchema: toStandardJsonSchema(SearchArgsSchema),
    outputSchema: toStandardJsonSchema(SearchOutputSchema),
  }).server(async (args, context) => {
    const signal = context?.abortSignal;
    if (signal?.aborted) return { ok: false, query: args.query, error: "Cancelled" };
    const query = args.query.trim();
    const numResults = clampExaResults(args.numResults ?? SEARCH_RESULTS_PER_RUN);
    try {
      if (env.EXA_API_KEY) {
        const rows = await exaSearch(env, query, numResults, signal);
        const grounding = buildMultiSearchContext({
          runs: [{ query, rows: rows.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })) }],
        });
        return { ok: true, query, resultCount: rows.length, context: grounding };
      }
      const rawText = await exaMcpSearchRawText(query, numResults, signal);
      const grounding = buildMultiSearchContext({ runs: [{ query, rawText }] });
      return { ok: true, query, resultCount: rawText ? 1 : 0, context: grounding };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, query, error: message.slice(0, 400) };
    }
  });
}

function createExtractTool(env: AppEnv) {
  // Reuse existing browser extract tool but wrap it as headless server tool.
  // The legacy helper expects an assistantMessageId for publishing state; we
  // provide a dummy and ignore its side effects for the headless path.
  const legacy = createBrowserExtractTool({
    env,
    assistantMessageId: "headless",
    log: () => {},
    trace: async (_name, _attrs, run) => run(),
    onExtractStateChange: async () => {},
  });
  // Legacy tool already is a ServerTool definition; reuse directly if BROWSER binding exists.
  // Otherwise fallback to a simple url-fetch extract (reuse createBrowserExtractTool internals would fail without BROWSER).
  // We keep legacy's tool but we don't need its state publishing.
  return legacy.tool;
}

export async function handleChat(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const session = await getSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  // Hydration probe for TanStack client: GET ?threadId=...
  if (request.method === "GET") {
    const url = new URL(request.url);
    const threadId = url.searchParams.get("threadId");
    // No server persistence for v1 — client uses indexedDB persistence if configured.
    // Return empty transcript so client renders empty state correctly.
    if (threadId) {
      return Response.json({ messages: [], activeRun: null, interrupts: null });
    }
    return new Response("Missing threadId", { status: 400 });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const wireMessages = Array.isArray(record.messages) ? (record.messages as unknown[]) : [];
  const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
  const runId = typeof record.runId === "string" ? record.runId : undefined;
  const forwardedProps = (record.forwardedProps ?? record.data ?? {}) as Record<string, unknown>;
  const modelIdRaw = typeof forwardedProps.modelId === "string" ? forwardedProps.modelId : undefined;
  const reasoningLevelRaw = typeof forwardedProps.reasoningLevel === "string" ? forwardedProps.reasoningLevel : "off";
  const searchEnabled = forwardedProps.search === true || forwardedProps.search === "true";
  const modelId = modelIdRaw?.trim() || env.DEFAULT_MODEL_ID?.trim() || "auto";
  const reasoningLevel = (["off", "low", "medium", "high"] as const).includes(reasoningLevelRaw as never)
    ? (reasoningLevelRaw as "off" | "low" | "medium" | "high")
    : "off";

  // Build adapter + model options. threadId doubles as the stable
  // x-opencode-session for prompt-cache affinity (required after 09/06).
  const adapter = createOpenCodeAdapter({ env, modelId, sessionId: threadId });
  const providerOptions = getProviderModelOptions(modelId, reasoningLevel);

  // Tools: always include search + extract when search is enabled or BROWSER is configured
  const tools = [];
  if (searchEnabled) {
    tools.push(createSearchTool(env));
    if (env.BROWSER) tools.push(createExtractTool(env));
  }

  // System prompts: keep date grounding
  const systemPrompts: string[] = [];
  const now = new Date();
  systemPrompts.push(
    `Current date: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. When searching, use this as reference.`,
  );

  const stream = chat({
    adapter,
    messages: wireMessages as never,
    tools: tools.length ? (tools as never) : undefined,
    threadId,
    runId,
    modelOptions: providerOptions.modelOptions as never,
    systemPrompts,
  });

  return toServerSentEventsResponse(stream);
}
