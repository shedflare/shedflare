import { defineConfig } from "vite-plus";

export default defineConfig({
  // The public agent schemas are authored in TypeScript. Bundle this contract
  // so the executable also runs on supported Node versions without TS loading.
  pack: { deps: { alwaysBundle: [/^@shedflare\/auth-client(?:\/|$)/] } },
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
