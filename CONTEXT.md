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

| Area          | Entry points to read                                                                                                                                                                                                                                 | Current state authority / boundary                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anki          | `apps/anki/src/app.tsx`, `src/server/handlers.ts`                                                                                                                                                                                                    | D1 decks/cards/reviews; browser overview, capture draft, and review display state.                                                                                                       |
| Auth          | `apps/auth/src/worker.ts`, `src/openauth.ts`, `src/sessions.ts`, `src/db/schema.ts`                                                                                                                                                                  | OpenAuth owns Google sign-in using its KV binding. D1 owns opaque central/app sessions and handoffs; apps validate through RPC and linked sessions revoke together.                      |
| CF Bill       | `apps/cf-bill/src/routes/index.tsx`, `src/server/impl/usage.ts`                                                                                                                                                                                      | Cloudflare API observations. Missing/failed observations are not measured zero or authoritative billing data.                                                                            |
| Chat          | `apps/chat/src/app.tsx` → `src/routes/index.tsx` → `src/api/chat.ts`                                                                                                                                                                                 | Current UI uses localStorage indexes, TanStack IndexedDB transcripts, and `/api/chat` SSE. Existing DO sync/persistence/backups remain separate; see below.                              |
| Discord       | `apps/discord/src/router.ts`, `src/handlers/message-create.ts`, `src/gateway/durable-object.ts`, `src/conversation/durable-object.ts`                                                                                                                | Gateway state and per-channel conversation history in separate DOs. Owner Discord ID gates mention handling.                                                                             |
| Drive         | `apps/drive/src/context.tsx`, `src/lib/upload.ts`, `src/server/impl/files.ts`, `src/server/impl/secure-uploads.ts`                                                                                                                                   | D1 metadata/upload state; R2 bytes; browser query/selection/upload UI. Independent production lifecycle outside suite deployment.                                                        |
| Homepage      | `apps/homepage/src/routes/index.tsx`, `src/routes/projects.tsx`, `src/server/router.ts`                                                                                                                                                              | D1 projects/experiences; configuration controls public reads; admin writes remain protected.                                                                                             |
| Money         | `apps/money/src/app.tsx` → `src/routes/index.tsx` (Overview), `src/routes/plan.tsx` (Plan), `src/routes/account.tsx`, `src/routes/reports.tsx`, `src/routes/categories.tsx`, `src/routes/settings.tsx`, `src/routes/redirects.tsx`, `src/lib/api.ts` | REST + D1; Overview, Plan, Accounts, and Reports read the same persisted records. Browser route resources, settings cache, and in-memory undo/redo. No active Money DO or offline queue. |
| Observability | `apps/observability/src/worker.ts`, root `alchemy.run.ts`                                                                                                                                                                                            | Tail events stored in D1; root stack wires consumers. Current filtering does not capture every handled HTTP/application failure.                                                         |
| Routines      | `apps/routines/src/context.tsx`, `src/server/handlers.ts`, `src/types.ts`                                                                                                                                                                            | D1 routines/completions/settings; optimistic browser state and fetched date ranges.                                                                                                      |
| Links (`s`)   | `apps/s/src/routes/index.tsx`, `src/server/router.ts`, `src/server/impl/links.ts`                                                                                                                                                                    | D1 links; public redirects and owner-protected management. Stable app ID/package is `s`.                                                                                                 |
| Site          | `site/src/app.tsx`, `site/src/content.ts`                                                                                                                                                                                                            | Public copy; some claims predate the current monorepo/state models. Verify against manifests and app code.                                                                               |

Paths following an app's first path in a row are relative to that app.

## Auth session cutover

Auth runs OpenAuth's Google OIDC provider to establish an owner login. App cookies contain opaque tokens, validated
through an `AUTH` Worker service binding; `AUTH_URL` only directs the browser login. Bindings use
same-stage Auth unless Core resolves an explicit `productionAliases` entry for an existing legacy
production deployment. Those entries preserve its ownership stage and hostname while using production
Auth. Unlisted stages remain isolated; proof stages cannot be configured as production aliases.
D1 primary reads enforce expiry and revocation on each request. State-bound, S256-protected
handoffs expire after 60 seconds and are atomically consumed. Logout revokes a central login and
all linked app sessions. RPC failures return 503 without clearing credentials. The new flow never
reads the former JWT/refresh cookies or legacy KV sessions; deployment requires a fresh sign-in.
OpenAuth's existing KV binding remains active for its provider encryption keys. The provider's
success callback creates opaque D1 sessions; consuming apps have no OpenAuth dependency.
See [Auth deployment](apps/auth/docs/deployment.md) for the coordinated rollout.

Auth also owns named, expiring agent tokens in D1 (`agent_tokens`). Only hashes are stored. Owner
browser sessions manage them at `/tokens`; Bearer tokens authorize GET `/api/deployments`
and its optional `worker` query, plus token metadata at GET `/api/agent/session`.
A dedicated optional `DEPLOYMENTS_CF_API_TOKEN` secret and
`CLOUDFLARE_ACCOUNT_ID` enable the Cloudflare read-only metadata adapter. No app data, source,
bindings, or Cloudflare writes are exposed. Browser logout leaves agent tokens active; explicit
revocation and expiry apply on each request. Missing configuration or upstream/storage failures
return retryable 503s without invalidating the agent's credential.

The CLI routes `auth` and `deployments` through `packages/cli/src/commands/agent.ts`.
`src/core/agent-auth.ts` owns local credential persistence in the user's configuration directory
and the GET-only HTTP client; inspection does not need a repository or operator Cloudflare login.
Auth and CLI share public metadata schemas from `@shedflare/auth-client/deployments`.
Normal CLI login uses `src/core/device-login.ts`: Auth's JSON POST `/api/agent/device/start`
and `/api/agent/device/poll`, plus owner browser approval at `/agent/authorize`. Auth's
`src/device-authorization.ts` owns hashed, expiring requests in D1 `agent_authorizations`;
single-use token issuance and consumption are transactional. `agent_login_flows` binds Google
sign-in back to approval when no central session exists. The CLI prints the approval link/code,
polls with backoff, and stores the token without displaying it. Denial, expiry and cancellation
preserve existing credentials. Explicit token-input flags remain available for automation.
The approved browser page refreshes until D1 marks the request consumed; only then does it link
to token management, so the token exists before the owner opens the list. Token creation and
existing access appear in separate responsive panels.
See [CLI agent access](packages/cli/README.md) for setup and the bundled inspection skill.

## Drive file organization

The registered home route uses `src/context.tsx` for the file query and current server records.
`FileTagPicker` edits the selected file through owner-protected PATCH `/api/files/:id`; D1 `tags`
and `file_tags` remain authoritative. Tag replacement uses a transactional D1 batch. The UI only
updates after the saved file response; failed saves retain the draft for retry. Sidebar tag counts
refresh separately with loading/error/retry states. Type and tag capsules combine with search in
GET `/api/files` before pagination. `src/shared/file-types.ts` defines MIME groups; no schema
migration is required. Query request guards discard outdated responses after filter changes.

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

## Money everyday and planning flows

Money has two working views instead of one page per feature. `/` (Overview, `src/routes/index.tsx`)
is what happened: month income/expense/net from `/api/reports/monthly/:month`, category availability,
net worth, alerts, and `src/components/ActivityPanel.tsx` (the feed/ledger, search, and URL filters
`q`, `view`, `category`, `account`, `focus`; `month=all` for all time). Its rail lists accounts,
upcoming payments with one-click Record, and category spending; selecting an account or category
filters the activity in place. `/plan` (`src/routes/plan.tsx`) combines budget, recurring, and trend
context for one month: an editable grid of assigned, spent, available, remaining scheduled spending
(projected by `paymentOccurrences` in `src/lib/recurring-view.ts`, mirroring the server's schedule
advance), last month's spend/assignment with a per-row copy, and targets. Its rail holds
`RecurringPanel.tsx` (overdue/due this month/later with inline Record/Skip; `payment` URL param opens
details) and `CashFlowPanel.tsx` (`/api/reports/cash-flow`). `/budget`, `/transactions`, and
`/schedules[/:id]` redirect into these views with their query parameters preserved.
Whole-plan Copy last month fills full previous amounts, including lower and zero amounts.
`set_budget_plan` replaces the selected month's assignments in one transactional Drizzle D1 batch,
preserves carryover settings, and restores the previous assignments as one undo step.
`src/components/MonthlyPlanDialog.tsx`, opened through Fund targets on Plan, selects
missing monthly target amounts; `allocate_budget` applies
those deltas together and reverses them as one undo step.
Unsupported goal types stay in their existing category controls. No income is forecast or created.
Both use `src/components/CategoryDrawer.tsx` for category activity, assignments, targets, and the
shared move-money dialog. Income and hidden categories are excluded from spendable envelopes.
The displayed available total is a sum of category balances, not a bank balance or a safe-to-spend forecast.

`src/lib/request-state.ts` keeps failed route requests explicit without a second data cache. Overview
and Plan sections (budget, previous month, schedules, cash flow, activity) fail/retry independently. Failed writes retain their form
drafts; successful writes and undo/redo emit `money:data-changed` to refetch server records. Amounts
and goals remain in D1; the quick composer remembers only the last account in browser storage.

Fresh installations show an Overview setup action. `MoneySetup.tsx` collects currency, one account and
opening balance, and editable starter categories with icons. Setup and categories can be skipped.
`setup_money` validates an empty deployment and commits account/group/categories/settings in one
Drizzle D1 batch. The existing settings table stores `money_setup` as a request receipt and a unique
`money_setup_lock` guard; retries return the original account, altered requests are rejected, and
concurrent first saves cannot create duplicate records. Failed writes retain drafts. Currency reads
refresh the existing settings cache from the server after completion. No schema migration is needed.

`/reports` defaults to a selected monthly view: income, net expenses, a category spending donut
whose colors match the category list, previous-month percentage comparisons, and budget vs spent
from `GET /api/reports/budget-analysis?month=YYYY-MM` (defaults to the current month). Category
links open that month's Activity. Net worth, Cash flow (with age of money), and Custom reports
(`CustomReports.tsx`) are sibling views selected by `?view=`.
`GET /api/reports/monthly/:month` validates YYYY-MM and uses `src/server/monthly-report.ts` to
read the two months from D1. `src/domain/monthly-report.ts` owns the shared response schema and
aggregation: refunds net against category expenses, valid split children replace their parent,
and transfers/opening entries stay out. Hidden categories and closed accounts retain historical
activity. Month changes ignore stale payloads; failed reads expose Retry.
`GET /api/reports/cash-flow` uses the same D1 report loader and monthly aggregation, including
uncategorized activity, so Plan's cash flow totals and averages agree with Monthly Reports.

Money's single budget currency is selected by the persisted `display_currency` setting (USD or IDR).
`src/domain/money-amount.ts` owns strict amount parsing and currency-default separators;
`src/lib/currency.ts` reads the existing settings cache reactively for every amount surface.
IDR defaults to Indonesian grouping and whole rupiah, including amount inputs. Explicit
`number_format` preferences still apply; `auto` follows the currency. Settings update the cache
only after a successful write and retain failed selections for retry. Integer storage remains
100 units per dollar or rupiah; changing the currency preference never converts existing records.
CSV import is available from account actions and Settings through `CsvImportDialog.tsx`.
`src/domain/csv-import.ts` reads comma/semicolon/tab records with escaped quotes, BOMs and multiline
fields, detects Indonesian column names, validates calendar dates and exact USD/IDR amounts,
and supports explicit column/date/number mapping. Review consumes account-scoped duplicate
matches by count; keeping duplicates is an explicit option. Multi-account exports require a source
account selection. Missing categories remain uncategorized; existing category names are matched
only when unambiguous. Invalid files and failed duplicate checks block saving.
`import_transactions` validates open accounts and up to 200 rows, honors read-only preview, and
commits new rows plus a `transaction_imports` receipt in one Drizzle D1 batch. The additive
`20261001075843_transaction_import_receipts` migration creates the receipt table. Request IDs and
payload fingerprints make lost-response retries safe. Five-row inserts stay below D1's bound
parameter limit and the complete request fits its Free query limit. Undo verifies unchanged imported
rows and tags, removes only those rows atomically, and retains the receipt for exact ID-preserving
redo. In-memory undo remains the active client history; receipts are server import provenance.
Export downloads all accounts from Settings or a single account from its actions. CSV is a flat
ledger interchange, not a structural backup: split parents appear once, split children are omitted,
and transfer/split relationships and opening account balances are not restored from CSV. Quotes,
multiline notes, amounts, category names and account names survive ordinary export/import.

Category icons are optional, validated keys stored in `categories.icon`; the Drizzle schema and
`src/domain/category-icons.ts` define the supported set. `CategoryIconPicker.tsx` edits the same
category record used by Home, Budget, and the category drawer. Initials remain the default for
existing categories. The additive `20260930224007_category_icons` migration preserves their data.

`/categories` is the management list. `CategoryEditor.tsx` saves names, icons, groups and optional
targets in a retained drawer draft. A dedicated reorder mode exposes touch/keyboard controls for
categories and groups. `reorder_categories` and `reorder_category_groups` validate distinct,
existing IDs and commit positions in one Drizzle D1 batch; undo restores their ordering.
Rename, regroup, icons, hide/show and group creation also support undo. Hidden records are collapsed.
Category deletion explicitly confirms the activity destination and loss of monthly assignments;
it moves transaction/schedule references and removes source assignments/category in one batch.
Group deletion moves categories before deleting the group, retaining category IDs and history.
Deletion does not offer a partial recreation as undo. Income categories inherit an income group
when created without an explicit type. Hidden categories still contribute income and assigned
amounts to budget totals, while their rows remain hidden. Account opening balances fund the account's
creation month once, excluding off-budget accounts; they remain excluded from Reports income.
`computeMonthBudget` rolls months forward from the earliest budget data (YNAB-style): expense
category balances carry over, unassigned money and last month's held amount flow into the next
To assign, and uncovered overspending (carryover off) comes out of the next month's To assign.
Plan shows scheduled income as "still expected" but never counts it as assignable.

`/settings` reads persisted preferences with loading/failure/retry and refreshes the existing
settings cache. Currency, number format, privacy and transaction CSV export are primary; date
format and closed-account visibility are collapsed. Writes retain the chosen draft on failure,
with Retry or Reload, and update the global settings cache only after a successful command.
Unused budget-mode, exchange-rate and week-start controls are omitted; their persisted records
and APIs remain intact. CSV downloads expose failure/retry and preserve quoted/multiline text
through `src/domain/transaction-csv.ts` and the Drizzle-backed `/api/export/csv` route.

`transfer_budget` and `cover_overspending` in `src/server/command-handlers/budget.ts` write both
assignments in a transactional Drizzle D1 batch. Relative updates preserve assignment totals;
positive, integer amounts and distinct expense categories are validated. The reverse command can
restore overspending during undo. Budget spending includes valid split children once, excludes
their parent, and nets category refunds. Account balances still count the parent once. The
previous-month comparison uses assignments versus net spending, independently of carryover.
`/transactions` defaults to the current month with an all-time option. `ActivityFeed.tsx` groups
entries by date; `TransactionDrawer.tsx` edits ordinary transactions with retained drafts on failure.
Category/month links filter the feed and transaction-focus links open the drawer. The ledger toggle
keeps inline editing, tags, splits, and schedule creation available. Split parents appear once,
child matches retain their parent, and transfers/starting balances are excluded from activity totals.
Reconciled balances and linked/split transactions are locked in the everyday drawer; the ledger
retains their existing controls. Activity reads transactions and edit metadata as one retryable
request and ignores superseded filter responses. There is no second transaction store.
CategoryDrawer's Activity reads `/api/transactions` with category and month date comparisons;
matching split children remain visible. Invalid inline or saved filter conditions return 400
instead of falling back to an unfiltered ledger.

`/accounts/:id` opens the same activity feed with its live balance, account switcher, Add, and
`AccountTransferDialog.tsx`. Ledger, CSV import, reconciliation, rename, and close/reopen live in
the account menu. Route reads include unfiltered transactions and edit metadata; optional ledger
filters select IDs from that data without duplicating transaction state. Superseded reads are ignored.
`account-view.ts` computes running balances chronologically, including same-day transactions,
and counts split parents once. Category labels/search derive from the loaded category records.
`create_account_transfer` writes opposite, reciprocally linked entries in one D1 batch; deletion
removes both, and undo recreates both. Individual financial edits and splits cannot break a transfer.
`reconcile_account` compares the cleared ledger balance against the supplied snapshot, then marks
cleared entries and adds any correctly signed adjustment in one batch; pending entries stay pending.

Recurring payments live in Plan's `RecurringPanel.tsx`. Active payments show name, date, and amount
grouped against the plan month; later, paused, and finished lists are collapsed. Rows have inline
Record/Skip (`src/lib/recurring-actions.ts`) and open details with a menu for Edit/Pause/Archive. `RecurringPaymentForm.tsx` persists the account, category, next date,
amount/sign, and recurrence settings. Discovery opens a prefilled draft before saving. Failed reads
have Retry and failed writes retain the drawer/draft. `post_schedule_transaction` batches the payment
and date advancement; `undo_schedule_payment` removes that transaction and restores the schedule
state together. Redo retargets undo to the newly created transaction. Skip, pause, archive, and edits
also support undo. These flows use the existing schedules/transactions tables, with no second store.

`pnpm --filter @shedflare/money dev:demo` runs the real REST router with isolated, in-memory SQLite
sample data and a loopback-only client preview. It creates no Cloudflare resources and is separate
from the deployed-browser E2E lifecycle. `MONEY_DEMO_EMPTY=1` starts the same preview with an
empty database for setup and empty-state verification.

## Shared package ownership

| Package                                             | Responsibility / starting point                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shedflare/core` (`packages/shedflare-core`)       | Manifest catalog, config loading/migration/patching, dependency ordering, registry/schema generators. Start at `src/index.ts`, `src/config`, and `src/manifests`.                                                                                           |
| `@shedflare/alchemy` (`packages/shedflare-alchemy`) | App config, physical names, credentials, guarded E2E bindings, HTTP adaptation, and `WorkerSecret`. App stacks own resources; root composes them.                                                                                                           |
| `@shedflare/auth-client`                            | Typed Auth RPC contract, login/callback/cookie/HTML adapters, and public deployment metadata schemas. Read `src/contract.ts`, `src/consumer.ts`, `src/http-api.ts`, `src/deployments.ts`. No JWT verification or refresh path; auth hints are display-only. |
| `@shedflare/sync-protocol`                          | Envelope schemas and class-based SQL/event/DO helpers. `SyncEngineDO` exposes handler, snapshot, and transaction hooks; it is not an Effect service-tag API. Chat extends it; Money does not.                                                               |
| `@shedflare/cli`                                    | Operator commands; config/manifest policy delegates to Core. Run from repo root and read command bodies before assuming a flag changes execution.                                                                                                           |
| `@shedflare/console`                                | Local Vite middleware API and operator UI. Config patches delegate to Core; inventory/usage are observations. Separate saved config from editable drafts.                                                                                                   |
| `@shedflare/ui`                                     | Small tested Solid/Tokenami primitives and theme tooling. Not yet adopted by the apps.                                                                                                                                                                      |
| `@shedflare/test-utils`                             | SQLite-backed D1 shim, R2 substitute, migration loader. D1 shim `batch` executes statements in a SQLite transaction and rolls back failures.                                                                                                                |

Root tooling also lives in `tooling/`, `tools/`, `scripts/`, and `infra/`.

## Verification map

Run scoped `pnpm --filter <actual-package-name> check`, `test`, and `build` from repo root, then
the relevant root scripts. Inspect package scripts and include patterns: success may mean no tests.

- `pnpm check`: configured lint/format/type checks, boundaries, and generated contracts.
- `pnpm test`: normal suites; excludes live Alchemy deployments. Auth includes local Miniflare tests with real Worker RPC and D1.
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
