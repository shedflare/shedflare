# Shedflare code and state map

Verified against `2bcf559` on 2026-09-08. This describes checked-in behavior, not a deployment
inventory. Update the relevant row when changing its entry point or persistence model.

The Git and pnpm root is this directory. There is no additional `shedflare/` source directory.
Historical split checkouts are outside the repository. Read [AGENTS.md](AGENTS.md), then the nearest
app/package guidance. [ADR 0002](docs/architecture/0002-modular-monorepo.md) records the accepted
modular monorepo; ADR 0001 and older control-plane/deepdive documents are historical context.

## Trace the active path

Start at the app's `src/app.tsx`, follow the registered route/component, then its API client,
Worker router, handler, and database schema. A file existing under `src` does not establish that
the app uses it. Saved route copies and old sync helpers are not the current Chat UI; Money's
sync-shaped names do not imply a running sync engine.

| Area          | Entry points to read                                                                                                                  | Current state authority / boundary                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anki          | `apps/anki/src/app.tsx`, `src/server/handlers.ts`                                                                                     | D1 decks/cards/reviews; browser overview, capture draft, and review display state.                                                                          |
| Auth          | `apps/auth/src/worker.ts`, `allowed-clients.ts`                                                                                       | OpenAuth plus custom silent-auth/token handling and KV storage. Issuer sessions and app JWT/refresh cookies are distinct.                                   |
| CF Bill       | `apps/cf-bill/src/routes/index.tsx`, `src/server/impl/usage.ts`                                                                       | Cloudflare API observations. Missing/failed observations are not measured zero or authoritative billing data.                                               |
| Chat          | `apps/chat/src/app.tsx` → `src/routes/index.tsx` → `src/api/chat.ts`                                                                  | Current UI uses localStorage indexes, TanStack IndexedDB transcripts, and `/api/chat` SSE. Existing DO sync/persistence/backups remain separate; see below. |
| Discord       | `apps/discord/src/router.ts`, `src/handlers/message-create.ts`, `src/gateway/durable-object.ts`, `src/conversation/durable-object.ts` | Gateway state and per-channel conversation history in separate DOs. Owner Discord ID gates mention handling.                                                |
| Drive         | `apps/drive/src/context.tsx`, `src/lib/upload.ts`, `src/server/impl/files.ts`, `src/server/impl/secure-uploads.ts`                    | D1 metadata/upload state; R2 bytes; browser query/selection/upload UI. Independent production lifecycle outside suite deployment.                           |
| Homepage      | `apps/homepage/src/routes/index.tsx`, `src/routes/projects.tsx`, `src/server/router.ts`                                               | D1 projects/experiences; configuration controls public reads; admin writes remain protected.                                                                |
| Money         | `apps/money/src/lib/api.ts`, `src/domain/commands.ts`, `src/server/command-handlers/handle-command.ts`, `src/db/schema.ts`            | REST + D1; browser route data, settings cache, and in-memory undo/redo. No active Money DO, WebSocket replay, or global offline queue.                      |
| Observability | `apps/observability/src/worker.ts`, root `alchemy.run.ts`                                                                             | Tail events stored in D1; root stack wires consumers. Current filtering does not capture every handled HTTP/application failure.                            |
| Routines      | `apps/routines/src/context.tsx`, `src/server/handlers.ts`, `src/types.ts`                                                             | D1 routines/completions/settings; optimistic browser state and fetched date ranges.                                                                         |
| Links (`s`)   | `apps/s/src/routes/index.tsx`, `src/server/router.ts`, `src/server/impl/links.ts`                                                     | D1 links; public redirects and owner-protected management. Stable app ID/package is `s`.                                                                    |
| Site          | `site/src/app.tsx`, `site/src/content.ts`                                                                                             | Public copy; some claims predate the current monorepo/state models. Verify against manifests and app code.                                                  |

Paths following an app's first path in a row are relative to that app.

## Chat currently has two data paths

The active route imports `useChat` from `@tanstack/ai-solid`. Its `/api/chat` endpoint runs TanStack
directly and returns empty history on GET. The route does not load the existing server-backed
thread index. `src/lib/solid-ui-bridge.tsx` is used by a factory example, not the active route.

The older implementation remains in `src/server/sync-engine.ts`, `src/lib/ws-connection.ts`, and
related projection/persistence modules. It owns existing DO tables, canonical provider transcripts,
event/command journals, and history endpoints. Scheduled R2 backups still export this DO through
`src/api/backups.ts`; new browser-only transcripts do not automatically enter those backups.
`index.legacy.tsx` and `index.tsx.bak` preserve the previous route; neither is registered.

Treat this as an unresolved migration boundary. Verify history reachability, backup, restore, and
deletion before removing either path. Earlier Chat deepdives explain the older path and require
verification before use as implementation instructions.

## Shared package ownership

| Package                                             | Responsibility / starting point                                                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shedflare/core` (`packages/shedflare-core`)       | Manifest catalog, config loading/migration/patching, dependency ordering, registry/schema generators. Start at `src/index.ts`, `src/config`, and `src/manifests`.                             |
| `@shedflare/alchemy` (`packages/shedflare-alchemy`) | App config, physical names, credentials, guarded E2E bindings, HTTP adaptation, and `WorkerSecret`. App stacks own resources; root composes them.                                             |
| `@shedflare/auth-client`                            | Login/callback/session/cookie/HTML gates. Read `src/consumer.ts`, `src/http-api.ts`, `src/client.ts`. Auth hint cookies are display hints, not authorization.                                 |
| `@shedflare/sync-protocol`                          | Envelope schemas and class-based SQL/event/DO helpers. `SyncEngineDO` exposes handler, snapshot, and transaction hooks; it is not an Effect service-tag API. Chat extends it; Money does not. |
| `@shedflare/cli`                                    | Operator commands; config/manifest policy delegates to Core. Run from repo root and read command bodies before assuming a flag changes execution.                                             |
| `@shedflare/console`                                | Local Vite middleware API and operator UI. Config patches delegate to Core; inventory/usage are observations. Separate saved config from editable drafts.                                     |
| `@shedflare/ui`                                     | Small tested Solid/Tokenami primitives and theme tooling. Not yet adopted by the apps.                                                                                                        |
| `@shedflare/test-utils`                             | SQLite-backed D1 shim, R2 substitute, migration loader. D1 shim `batch` currently does not execute statements or model atomicity.                                                             |

Root tooling also lives in `tooling/`, `tools/`, `scripts/`, and `infra/`.

## Verification map

Run scoped `pnpm --filter <actual-package-name> check`, `test`, and `build` from repo root, then
the relevant root scripts. Inspect package scripts and include patterns: success may mean no tests.

- `pnpm check`: configured lint/format/type checks, boundaries, and generated contracts.
- `pnpm test`: normal suites; excludes live Alchemy deployments.
- `pnpm build`: workspace builds; some server-only apps use a type check as their build.
- `pnpm --filter @shedflare/chat test:workers`: separate local Cloudflare pool tests under
  `apps/chat/test/workers`; not included in Chat's normal 67-test suite at this baseline.
- Root `test:chat`, `test:auth`, and similar app names run live Alchemy suites. Money/Drive deployed
  browser E2E entry points have their own resource lifecycle. Read scripts and existing deployment
  guidance before running them.
- New Chat route/API/bridge files appear in `tooling/anti-slop.vite.ts` ignores. A green check does
  not establish that those files were analyzed; keep exemptions visible and narrowly scoped.

The [2026-09-08 review](docs/reviews/2026-09-08-codebase-review.md) records reproducible bugs, test
gaps, and cleanup priorities. It is a dated snapshot; verify each finding against current code.

## State changes and handoff

Name the authoritative record, browser draft/cache, persistence key, and failure/retry behavior in
a state-related PR. Identify the active caller and migration implications. Prefer one committed
server operation for a single user action with related writes. Derive client contracts from
existing schemas rather than introducing parallel shapes.

Use a discriminated union for mutually exclusive editor/operation states and a keyed resource for
remote reads. Keep independent UI fields independent. A suite-wide store is not a default solution.
Cover loading, signed-out, empty, failure, retry, and partial-success states where applicable.

Update this map and app documentation when replacing a route or persistence path. Label proposals
as proposals. Preserve deployment names, data ownership, and standalone boundaries; editing this
document does not imply deployment or storage cleanup.
