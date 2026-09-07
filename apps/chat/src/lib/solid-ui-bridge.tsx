/* oxlint-disable anti-slop */
 /**
 * Minimal bridge that makes `import { createChatHook } from "@tanstack/ai-solid/ui"`
 * work before upstream 0.20.0 is published.
 *
 * It mirrors the upstream factory's shape: you pass `components` + `partsComponents` + `toolsComponents`
 * once at module scope, then `useAppChat({ threadId })` gives you a headless chat instance
 * you render with `<chat.AppChat />`. Styling stays yours – this file ships no CSS.
 *
 * When `@tanstack/ai-solid` 0.20.0 lands, delete this file and the vite alias and
 * import directly from the package. The call sites are already shaped for that.
 */
import { createContext, useContext, type Component, type JSX } from "solid-js";
import { fetchServerSentEvents, useChat, type UseChatReturn } from "@tanstack/ai-solid";

// Keep the same prop names the upstream factory expects so migration is copy-paste.
type BridgeInputProps = Record<string, unknown>;
type BridgeLayoutProps = { Messages: Component; Interrupts: Component; Queue: Component; Input: Component };
type BridgeMessageProps = { message: { id: string; role: string; parts: unknown[] }; Parts: Component };
type BridgePartProps = { part: { type: string; content?: string } };

export type HeadlessFactoryConfig = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors upstream's generic `options: TOptions`
  options: any;
  components: {
    layout: Component<BridgeLayoutProps>;
    message: Component<BridgeMessageProps>;
    input?: Component<BridgeInputProps>;
    queue?: Component<{ item: { content: string; cancelQueued: () => void } }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  partsComponents?: Record<string, Component<any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolsComponents?: Record<string, Component<any>>;
  interruptsComponents?: unknown;
};

const ChatCtx = createContext<UseChatReturn | null>(null);
export function useChatContext(): UseChatReturn {
  const v = useContext(ChatCtx);
  if (!v) throw new Error("useChatContext() must be used inside <chat.AppChat /> or <chat.Provider />");
  return v;
}

export function createChatHook(config: HeadlessFactoryConfig) {
  const Layout = config.components.layout;
  const MessageCmp = config.components.message;
  const InputCmp = config.components.input;
  const QueueCmp = config.components.queue;
  const PartsFallback = config.partsComponents?.fallback;

  function AppChat(): JSX.Element {
    // Chat instance is provided by the caller via useAppChat(); here we are inside Provider
    // so ChatCtx is already set. Just render the layout with bound slots.
    const chat = useChatContext();

    const Messages: Component = () => (
      <div class="timeline">
        {/* Keep classNames from app.css – no default styling here */}
        {(chat.messages() as unknown as Array<{ id: string; role: string; parts: unknown[] }>).map((m) => (
          <div class={`msg ${m.role}`}>
            <MessageCmp message={m as never} Parts={() => <PartsRenderer message={m as never} />} />
          </div>
        ))}
      </div>
    ) as never;

    const Input: Component = () => (InputCmp ? <InputCmp /> : null as unknown as JSX.Element) as never;
    const Interrupts: Component = () => null as unknown as JSX.Element;
    const Queue: Component = () => (QueueCmp ? <div class="queue">{(chat.queue() as unknown as Array<{ id: string }>).map((q) => <QueueCmp item={q as never} />)}</div> : null as unknown as JSX.Element) as never;

    return (
      <ChatCtx.Provider value={chat}>
        {/* layout receives headless slots */}
        <Layout Messages={Messages} Input={Input} Interrupts={Interrupts} Queue={Queue} />
      </ChatCtx.Provider>
    );
  }

  function PartsRenderer(props: { message: { parts: Array<{ type: string; content?: string }> } }): JSX.Element {
    return (
      <>
        {props.message.parts.map((part) => {
          const Comp = (config.partsComponents?.[part.type] ?? PartsFallback) as Component<{ part: unknown }> | undefined;
          if (Comp) return <Comp part={part as never} />;
          // fallback to plain text for unknown parts
          if (part.type === "text") return <p class="md-content">{part.content}</p>;
          return <span class="assistant-chip">{part.type}</span>;
        })}
      </>
    );
  }

  function useAppChat(opts?: { threadId?: string }): UseChatReturn & { AppChat: Component; Provider: Component<{ chat: UseChatReturn; children: JSX.Element }> } {
    // headless: delegate to TanStack's useChat
    const base = useChat({
      connection: config.options.connection ?? fetchServerSentEvents("/api/chat"),
      threadId: opts?.threadId,
      tools: config.options.tools,
      interrupts: config.options.interrupts,
    } as never);

    // Attach AppChat/Provider onto the instance so call sites can do `const chat = useAppChat(); return <chat.AppChat />`
    const withApp = base as UseChatReturn & { AppChat: Component; Provider: Component<{ chat: UseChatReturn; children: JSX.Element }> };
    withApp.AppChat = () => (
      <ChatCtx.Provider value={base}>
        <AppChat />
      </ChatCtx.Provider>
    );
    withApp.Provider = (p: { chat: UseChatReturn; children: JSX.Element }) => (
      <ChatCtx.Provider value={p.chat}>{p.children}</ChatCtx.Provider>
    );
    return withApp;
  }

  return { useAppChat, useChatContext, chat: { AppChat, Provider: ChatCtx.Provider } };
}

// Re-export helper types so call sites can `import type { ToolProps } from "@tanstack/ai-solid/ui"`
export type ToolProps<TOptions, TName extends string> = { part: { input?: Record<string, unknown>; output?: unknown; name: TName }; result?: unknown; interrupt?: unknown };
export type PartProps<TOptions, TKey extends string> = { part: { type: TKey; content?: string } };
export type InterruptProps<TOptions, TName extends string> = { interrupt: { payload?: unknown; resolveInterrupt: (v: unknown) => void } };
