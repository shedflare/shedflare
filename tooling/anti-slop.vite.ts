export const antiSlopIgnores = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "packages/shedflare-core/schemas/**",
  "tools/oxlint/anti-slop/**",
  // Headless blow-up: new chat handler + bridge are intentionally permissive until upstream 0.20.0 publishes
  "apps/chat/src/api/chat.ts",
  "apps/chat/src/lib/solid-ui-bridge.tsx",
  "apps/chat/src/lib/factory-example.tsx",
  "apps/chat/src/routes/index.tsx",
];

const antiSlopRules = {
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-empty-object-spread": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-runtime-typeof": "error",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-parameters": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "error",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
} as const;

export function antiSlopLint(pluginSpecifier: string) {
  return {
    ignorePatterns: antiSlopIgnores,
    jsPlugins: [{ name: "anti-slop", specifier: pluginSpecifier }],
    rules: antiSlopRules,
  };
}

export const antiSlopFmt = { ignorePatterns: antiSlopIgnores };
