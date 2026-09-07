# Shedflare Money – Agent Guidance

This directory contains Shedflare Money inside the canonical monorepo. Keep it independently
selectable, testable, buildable, and deployable through scoped workspace commands.

Current state is REST + D1, with browser route data, a settings cache, and in-memory undo/redo.
There is no active Money Durable Object/WebSocket sync engine or global offline command queue.
See root [CONTEXT.md](../../CONTEXT.md). `src/lib/api.ts` calls the API;
`src/domain/commands.ts` defines command payloads; `src/server/command-handlers/handle-command.ts`
routes validated commands. Keep client contracts derived from those schemas.

For import, reconciliation, split, transfer, and undo changes, verify persisted state after success,
failure, and retry. The shared D1 shim is SQLite-backed but its current `batch` does not execute
statements or model rollback; use a faithful runtime boundary for transaction guarantees.

- Shared Shedflare dependencies must use `workspace:*`. Never commit `file:`, `link:`, sibling
  source paths, nested lockfiles, or app-local copies of root tooling.
- Use `vp` and the package scripts for Vite, formatting, linting, tests, and Alchemy commands.
- Use non-production stages for deployment proofs and destroy them after smoke testing.
- Do not change production resources, deploy to `prod`, or point a temporary stage at production D1 or R2 resources unless explicitly requested.
- Keep authentication owner-only. Do not add accounts, registration, tenants, or multi-user behavior.
- E2E authentication bindings are permitted only on stages whose names start with `e2e-`.
- Do not add `as any`; validate external inputs at their boundaries.
