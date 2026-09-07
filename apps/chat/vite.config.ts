import { antiSlopFmt, antiSlopLint } from "../../tooling/anti-slop.vite.ts";
import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildInfoDefines } from "./build/vite-build-info.ts";

const repoDir = path.dirname(fileURLToPath(import.meta.url));

export default {
  resolve: {
    alias: {
      "#": path.resolve(repoDir, "src"),
      "@tanstack/ai-solid/ui": path.resolve(repoDir, "src/lib/solid-ui-bridge.tsx"),
    },
  },
  define: buildInfoDefines(import.meta.url),
  plugins: [solid(), ...(process.env.VITEST ? [] : [cloudflare()])],
  server: {
    allowedHosts: true,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "deploy/**/*.test.ts"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/solid-js") || id.includes("node_modules/@solidjs")) {
            return "vendor";
          }
          if (
            id.includes("node_modules/marked") ||
            id.includes("node_modules/dompurify") ||
            id.includes("node_modules/highlight.js")
          ) {
            return "markdown";
          }
          if (id.includes("node_modules/effect")) {
            return "effect";
          }
        },
      },
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    ...antiSlopLint("../../tools/oxlint/anti-slop/index.ts"),
    options: { typeAware: true, typeCheck: true },
  },
  fmt: antiSlopFmt,
};
