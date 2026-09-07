# Shedflare agent guidance

## Repository model

This repository is the canonical source for the Shedflare apps, shared packages, site, CLI, console,
and optional suite orchestration. It is one pnpm monorepo with one Git history, root lockfile,
dependency catalog, CI workflow, and development toolchain.

- `apps/*` contains independently selectable and deployable application stacks.
- `packages/*` contains shared libraries and repository tooling products.
- `site` contains the public project website.
- Use `workspace:*` for dependencies on another local `@shedflare/*` package.
- Never add nested Git metadata, lockfiles, package-manager workspaces, or copies of root tooling.
- Never add `file:`, `link:`, implicit sibling, or source-directory dependency paths.
- Run package-manager and Git-wide operations from the repository root. Use pnpm filters for scoped
  app/package work.
- Read the nearest child `AGENTS.md` before changing an app or shared-package area.

## Finding the active implementation

Read [CONTEXT.md](CONTEXT.md) for the current entry-point and state-ownership map. Follow imports
from the app's registered route to its API and persistence before relying on a similarly named
helper or an older design document. Keep shipped behavior, migration code, and proposals distinct.
Update the relevant map/documentation when changing a route or persistence authority.

For state changes, make loading, failure, retry, and persistence behavior explicit. Derive client
contracts from existing schemas; avoid duplicating authoritative state in a second cache/store.
Check which files and tests the configured verification actually includes.

## Product boundary

Shedflare is a self-hosted suite of personal productivity tools, normally deployed by one owner.
There is no public registration, tenant isolation, or general multi-user account model.

- Auth protects the deployment owner's sessions; it does not represent a customer user base.
- API keys, stored data, and preferences belong to the deployment owner.
- Do not add multi-user or tenant behavior unless explicitly requested.

## Verification

Use Vite+ through the root scripts:

- `pnpm check` runs formatting/linting/type checks plus repository boundary and generated-contract
  verification.
- `pnpm test` runs normal workspace tests.
- `pnpm build` builds every deployable project with a build script.
- Use `pnpm --filter <package> <script>` for fast scoped feedback, then run the relevant root checks
  before handoff.
- Live Alchemy and browser E2E tests are separate because they create Cloudflare resources.

Do not install Vitest, Oxlint, Oxfmt, or tsdown directly when Vite+ already provides them. Root-owned
anti-slop configuration and the Oxlint plugin must remain centralized.

`alchemy.test.ts` is the narrow exception: Alchemy's Vitest integration requires the official
Vitest runner context, so guarded live tests use the root `alchemy-vitest` package alias. Normal
unit/component tests continue to run through Vite+ and must not discover live Alchemy suites.

## Deployment safety

Alchemy is the only supported resource lifecycle. Each app owns an `alchemy.run.ts`; the root stack
composes the selected suite. Drive remains independently deployed and is intentionally omitted from
the root production deploy/destroy contract.

- Never deploy or destroy `prod`, publish packages, rotate secrets, or change production resource
  ownership without explicit operator approval.
- Use isolated non-production stages for deployment proofs and destroy them after verification.
- Never point a temporary stage at production D1, R2, KV, Durable Object, or Worker resources.
- Preserve physical names, stack identities, stage behavior, and persistent resource bindings unless
  a separately approved migration says otherwise.
- Secrets belong in Cloudflare secret storage or documented local environment files, never Git,
  logs, structured output, or generated artifacts.
- Every interactive command must provide a non-interactive equivalent for automation.

## Architecture rules

- `shedflare.config.jsonc` is the gitignored desired-state source; manifests in
  `apps/*/shedflare.app.jsonc` define app contracts and defaults.
- `@shedflare/core` is the source of truth for app identity, discovery, validation, migration,
  configuration patching, and dependency ordering.
- Root `alchemy.run.ts` performs optional shared Auth and observability wiring. Update it and the
  contract checks when adding an app to suite composition.
- Keep app feature code inside its app. Promote code to a shared package only after there is a real,
  stable cross-app contract.
- Preserve app-specific build/test/deploy entry points so contributors can reason about and verify a
  single app without running unrelated live infrastructure.

## TypeScript and data

- Do not use `as any` to suppress type errors. Validate untrusted input at boundaries and use
  `unknown`, schemas, precise generics, or a narrowly typed adapter.
- Model invalid states out of core domain types where practical; prefer discriminated unions for
  stateful workflows.
- Prefer tests against real module boundaries over mock-heavy tests.

For SQLite-backed apps, Drizzle schema definitions in `src/db/schema.ts` are authoritative. Generate
and commit migrations after schema changes, run Durable Object migrations inside
`ctx.blockConcurrencyWhile()`, and reserve raw SQL for genuinely dynamic-table operations.

## Adding an app

1. Add `apps/<app-id>` with a package manifest, app manifest, Alchemy stack, tests, and local
   `AGENTS.md`.
2. Use shared packages through `workspace:*`; add app-specific dependencies to the root catalog when
   they should be centrally aligned.
3. Add the app to the generated registry, root composition when applicable, configuration example,
   scripts, issue-form scope list, and contract checks.
4. Run `pnpm registry:generate`, `pnpm schemas:generate`, and `pnpm check`.
5. Rehearse deployment only on an explicitly approved isolated stage.
