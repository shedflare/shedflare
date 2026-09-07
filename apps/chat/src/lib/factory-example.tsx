/* oxlint-disable anti-slop */
 /**
 * Example: headless factory via `@tanstack/ai-solid/ui` – keeps `app.css` styling.
 *
 * This file proves `import { createChatHook } from "@tanstack/ai-solid/ui"` resolves
 * (vite alias -> src/lib/solid-ui-bridge.tsx until upstream 0.20.0 publishes) and
 * shows the typed, Form/Table-like registration you asked for.
 *
 * Swap this into `routes/index.tsx` to replace the raw `useChat` usage:
 *
 *   const chatOptions = { connection: fetchServerSentEvents("/api/chat"), tools: [] };
 *   const { useAppChat, useChatContext } = createChatHook({
 *     options: chatOptions,
 *     components: {
 *       layout: (p) => <><p.Messages /><p.Input /></>,
 *       message: (p) => <article><p.Parts /></article>,
 *       input: MyInput,
 *     },
 *     partsComponents: { text: TextPart, fallback: Fallback },
 *     toolsComponents: {},
 *   });
 *   const chat = useAppChat({ threadId });
 *   return <chat.AppChat />;
 */

import { fetchServerSentEvents } from "@tanstack/ai-solid";
import { createChatHook, type PartProps, type ToolProps } from "@tanstack/ai-solid/ui";
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

// tools – typed, no CSS
const getWeather = toolDefinition({
  name: "getWeather",
  description: "Look up weather",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ temperature: z.number() }),
}).client(async ({ city }) => ({ temperature: 22 }));

const chatOptions = {
  connection: fetchServerSentEvents("/api/chat"),
  tools: [getWeather] as const,
};

// typed parts keep app.css
function TextPart(props: PartProps<typeof chatOptions, "text">) {
  return <p class="md-content">{props.part.content}</p>;
}
function WeatherTool(props: ToolProps<typeof chatOptions, "getWeather">) {
  const city = (props.part.input as { city?: string } | undefined)?.city;
  return <strong class="assistant-chip">{city ?? "…"}</strong>;
}

export const { useAppChat, useChatContext } = createChatHook({
  options: chatOptions,
  components: {
    // input listed before layout so TS infers `props.Input` exists
    input: () => {
      const chat = useChatContext();
      return (
        <form
          class="composer"
          onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget as HTMLFormElement);
            const raw = fd.get("message");
            const v = typeof raw === "string" ? raw : "";
            if (v.trim()) void chat.sendMessage(v);
            (e.currentTarget as HTMLFormElement).reset();
          }}
        >
          <input name="message" class="composer-input" placeholder="Ask…" />
          <button class="composer-send-btn" type="submit">↑</button>
        </form>
      );
    },
    layout: (p) => (
      <div class="shell" data-theme="night">
        <aside class="sidebar"><div class="brand"><div class="brand-mark">SF</div><h1>shedflare</h1></div></aside>
        <main class="main-pane">
          <p.Messages />
          <p.Input />
        </main>
      </div>
    ),
    message: (p) => <article class="msg assistant"><p.Parts /></article>,
  },
  partsComponents: { text: TextPart, fallback: (p) => <span>{p.part.type}</span> },
  toolsComponents: { getWeather: WeatherTool },
});
