# Codebase review: state, UX, and maintainability

Reviewed 2026-09-08 against `2bcf5593548ea49cf2d19329e4fdf8a507808cdc`.

The monorepo boundary is sound. The largest problems are inside product flows: duplicated state ownership, operations that report success without producing the expected result, and missing recovery paths. Fix these before undertaking a suite-wide state or design-system rewrite.

## Scope and evidence

This was a repository-wide architecture and code-path review across all 11 apps, eight shared/tooling packages, the site, root infrastructure, CI, and agent documentation. It was not a line-by-line audit of every file. Runtime reproductions concentrated on Money's persistence and Chat's current browser route. Findings below distinguish reproduced behavior from source inspection.

- Applied the quality-code skill: valid state models, derived types, boundary validation, real module tests, useful observability, and restrained abstractions. Also consulted the Cloudflare, Workers, Durable Objects, and Effect guidance.
- `pnpm test`: **469 passed, 4 skipped, 53 passing test files**. CF Bill, Homepage, Observability, Links, and Site report no normal tests; some have separate live tests. Shared auth-client has no own test script.
- `pnpm build`: passed. This establishes buildability, not working deployed flows.
- `pnpm --filter @shedflare/chat test:workers`: **38 passed in two files** using the separate local Cloudflare pool suite.
- `pnpm check`: **passed after the documentation updates**; its exclusions matter (F16).
- Local Money reproductions used the real command handlers, Drizzle, and the repository's in-memory SQLite-backed D1 shim. A SQLite trigger simulated a failed write. No deployed data was used.
- Chat browser reproductions used the built UI in Chromium, served locally with deterministic bootstrap/model responses. They validate navigation and draft behavior, not authentication-provider or model-provider integration.
- Additional local checks called the real config patcher, auth callback, redirect validator, and tail handler. Only the external OAuth token exchange was intercepted.
- A supplemental direct `tsc --noEmit -p apps/chat/tsconfig.json` check fails on `cloudflare:test` declarations, related implicit types, and two shared-package typing issues. This is separate from the configured Vite+ check; it needs a clear Workers-test type-check configuration, not blanket casts.

No production deployments, account changes, provider inference calls, or real user data mutations were performed. Runtime fixes are recommendations; documentation changes accompanying this review are described at the end.

## Findings to fix first

P1 means broken core behavior, data integrity, or an authentication boundary that should be fixed before the next deployment of that area. P2 means a concrete recovery, correctness, or maintenance problem to address next. These priorities apply to this owner-operated suite, not a hypothetical multi-tenant product.

### F01 · P1 · Reconciliation moves the balance away from the statement

**Owner:** Money. **Evidence:** reproduced with real command handlers and SQLite.

[ReconcileModal](../../apps/money/src/routes/account.tsx#L433) computes `statementBalance - runningBalance`, then creates an adjustment with `amount: -diff()` at line 461. Account queries add transaction amounts to the opening balance. A running balance of 10,000 cents reconciled to 12,000 therefore becomes **8,000**, not 12,000. The modal also sends `lastReconciled`, but [update_account](../../apps/money/src/server/command-handlers/accounts.ts#L36) never persists that field. The reproduction returned `balance: 8000, last_reconciled: null`.

The operation fans out independent requests with `Promise.all`; one failure leaves partial reconciliation and `processing=true` because there is no failure/finally branch.

**Simplify:** one server `reconcile_account` command owns the current balance, adjustment, reconciliation marks, and timestamp. Commit the operation atomically and return the resulting balance. The UI needs only `editing | submitting | failed | complete` state.

**Acceptance:** reconcile both upward and downward, reconcile an already-balanced account, inject a failure, and retry the same operation. Verify the persisted total and timestamp, not just the completion screen.

### F02 · P1 · Import preview writes data and matching can modify another account

**Owner:** Money. **Evidence:** reproduced with real command handlers and SQLite.

[Import handler](../../apps/money/src/server/command-handlers/import.ts#L13) accepts a payload whose schema includes `isPreview`, but never branches on it. It finds existing transactions by `importedDescription` alone, without account/date/import identity.

Reproduction: import `SHOP, -100` into account A; preview `SHOP, -900` into account B. The second call reports `updated: 1`, and account A's original row becomes `-900` with the new date. Account B receives no row. Even within one account, repeated merchant descriptions are not transaction identities.

**Simplify:** separate a pure import plan from applying it. Preview returns the plan without writes. Use an account-scoped stable bank transaction ID or a documented import fingerprint, and require explicit resolution for ambiguous matches. Return per-row outcomes.

**Acceptance:** preview leaves the database byte-for-byte unchanged; equal descriptions in different accounts/dates remain separate; replaying an accepted import is idempotent.

### F03 · P1 · The CSV dialog never reads the selected file

**Owner:** Money. **Evidence:** direct source path.

[ImportModal](../../apps/money/src/routes/account.tsx#L343) checks that a file exists, then submits one zero-value transaction dated today. It never reads `f.text()`, parses the file, or calls the upload/parse flow. On success it hardcodes `added: 0` instead of using the result. Selecting a real bank statement can therefore create an unrelated entry while reporting zero imported entries.

**Simplify:** make the flow `select file → parse/map → preview → confirm → result`, with the parsed import plan as the only input to confirmation. Reuse the existing parser under `src/server/import/parse-csv.ts` where appropriate; do not keep a second placeholder import path.

**Acceptance:** a two-row fixture creates exactly those two rows, with matching dates and amounts. Parse errors preserve the selected file and show actionable row errors.

### F04 · P1 · Splitting a transaction can leave a partially written split

**Owner:** Money and test-utils. **Evidence:** reproduced using a SQLite failure trigger.

[split_transaction](../../apps/money/src/server/command-handlers/transactions.ts#L59) deletes existing children, inserts replacements individually, and only then marks the parent. Failure on the second insert left a `-100` ordinary parent and a `-40` child persisted, with `is_parent=0`. Replacing an existing split can also discard the original children before the failure.

**Simplify:** validate the entire command first and apply the related writes as one D1 batch/transaction supported by the actual runtime. Return one committed result. The same audit should cover budget transfers, payee merges, reorders, and Anki's card-update/review-record pair.

**Acceptance:** inject a failure after the first write and verify the complete previous state remains. Before testing a batch-based fix, repair or replace [D1Shim.batch](../../packages/test-utils/src/d1-shim.ts#L61): it currently returns the statements without executing them or modelling atomicity. Cloudflare documents D1 batch rollback semantics in its [database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

### F05 · P1 · Chat's visible history and server backups now describe different data

**Owner:** Chat. **Evidence:** active route, API, and backup path traced.

The [active route](../../apps/chat/src/routes/index.tsx#L100) stores workspace/thread metadata in localStorage and transcripts through IndexedDB persistence. It sends to [handleChat](../../apps/chat/src/api/chat.ts#L91), which performs an in-request TanStack run without the existing durable persistence. Its GET path returns an empty transcript. Meanwhile [scheduled backups](../../apps/chat/src/worker.ts#L19) still export the Sync Engine DO, via [createChatBackup](../../apps/chat/src/api/backups.ts#L120).

Existing server-backed threads are not loaded by the new route; new visible conversations do not reach those backups. Another browser cannot discover them. Deleting a thread/workspace only removes its localStorage index; the IndexedDB transcript is not deleted by those functions. This is a persistence migration gap, not proof that old server data was deleted.

**Simplify:** select and document one authoritative conversation store. If retaining the existing sync/backup contract, connect the new UI to durable TanStack persistence and provide a tested migration/import path for browser-only transcripts. Treat sidebar metadata as a projection of that authority. Do not remove the old storage until migration and backup recovery are verified.

**Acceptance:** old history remains reachable; a new conversation survives browser storage deletion through server recovery; a second browser sees it; export/restore includes the new conversation; deletion semantics cover transcript and index consistently.

### F06 · P1 · OAuth callback does not reject missing or mismatched state

**Owner:** auth-client and all consumers. **Evidence:** actual callback invoked locally with intercepted external token exchange.

[handleCallback](../../packages/auth-client/src/consumer.ts#L367) uses the nonce comparison only to choose `returnTo`. Missing/malformed/mismatched state still proceeds to `/token` with `code_verifier: ""`. A request containing only `?code=test-code` caused a token-exchange attempt in the reproduction. The browser's initiation of the login is therefore not enforced at this boundary.

**Simplify:** fail before token exchange when the expected one-use state is absent or invalid; adopt the supported client PKCE flow and keep its verifier in the initiating session. Reuse that implementation across consumers. This follows the request-binding protections described in [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.7.1). No production exploit was attempted.

**Acceptance:** valid round trip succeeds; missing state/cookie, mismatch, replay, and wrong verifier fail before setting session cookies.

### F07 · P2 · Return-path validation accepts an external redirect spelling

**Owner:** auth-client and Auth. **Evidence:** reproduced with the real shared validator and URL parser.

[validateReturnTo](../../packages/auth-client/src/consumer.ts#L116) rejects `//` but accepts a leading slash followed by a backslash. The accepted value `/\external.example/path` resolves against `https://app.example` to `https://external.example/path`. [Auth's copy](../../apps/auth/src/worker.ts#L174) has the same validation shape.

**Simplify:** one shared same-origin redirect validator; reject backslashes/control characters and validate the fully parsed destination's origin. Return a canonical local path. Reuse it for logout and callback navigation.

**Acceptance:** encoded and raw slash/backslash variants, malformed escapes, control characters, and protocol-relative paths cannot leave the app origin.

### F08 · P1 · Chat's silent-auth fallback is a dead end

**Owner:** Chat. **Evidence:** Chromium reproduction on the built route.

[fetchBootstrap](../../apps/chat/src/routes/index.tsx#L44) intentionally stops auto-login when `error=no_session`, but [the unauthenticated view](../../apps/chat/src/routes/index.tsx#L221) only says “Checking session… Redirecting to login.” There is no sign-in link/button and no redirect occurs. In a fresh browser after the one-shot silent-auth attempt, the user is stuck.

**Simplify:** a session resource with explicit `checking | signedIn | signedOut | failed` states. Signed-out state offers interactive sign-in; failed state offers retry. An auth hint may speed up the shell but must not replace those states.

**Acceptance:** direct `/?error=no_session` access offers a working sign-in action; transient bootstrap failure offers retry; expired session preserves the draft.

### F09 · P1 · Chat hides all navigation on mobile

**Owner:** Chat. **Evidence:** Chromium at 390 × 844.

[CSS](../../apps/chat/src/app.css#L2777) hides the sidebar below 700px unless it has `.open`. The [new route](../../apps/chat/src/routes/index.tsx#L234) always renders `class="sidebar"` and has no menu toggle. Browser inspection found the sidebar and “New chat” button invisible, with zero menu buttons. Workspace switching, chat history, new chat, and logout become inaccessible at phone widths.

**Simplify:** one drawer state with a labelled menu button, focus return, Escape/backdrop dismissal, and close-on-navigation. Reuse the existing CSS deliberately rather than assuming old behavior survives a route replacement.

**Acceptance:** at phone width and by keyboard, open history, create a chat, change workspaces, close navigation, and reach logout.

## State and recovery findings

### F10 · P2 · Drive can show stale search results and skip a page after failure

**Owner:** Drive. **Evidence:** direct source path.

[loadFiles](../../apps/drive/src/context.tsx#L224) applies every response to shared `files/hasMore/loading` signals without a query key, cancellation, or latest-request guard. A slow earlier search can overwrite a newer search, and an in-flight “load more” can append rows from the previous filter. [loadMore](../../apps/drive/src/context.tsx#L414) advances the offset before the request succeeds; retry after a failure advances again and skips the failed page.

**Simplify:** a query resource keyed by `{search, tag}` owns pages and its next cursor. Append only for that key and commit the cursor on success. Keep sorting/selection derived from that resource. Preserve caller cancellation in `requestJson`, which currently replaces `init.signal` with its timeout signal.

**Acceptance:** resolve two searches out of order, change filters during pagination, and fail/retry a page. No stale rows, skipped pages, or premature loading completion.

### F11 · P2 · Routines keeps failed optimistic writes and refreshes analytics too early

**Owner:** Routines. **Evidence:** direct source path.

[Mutations in context.tsx](../../apps/routines/src/context.tsx#L182) roll back only when fetch resolves with `!resp.ok`; a rejected fetch bypasses recovery entirely. Add/update/delete/toggle call `bump()` before the write completes. Calendar/analytics consumers can refetch the old server state at that revision, with no second revision after success. A failed mutation can stay visually applied without useful feedback.

**Simplify:** track each mutation's pending/error state and previous value, handle both transport rejection and non-OK responses, apply the canonical response, then invalidate dependent ranges after commit. For completion use `setCompleted({routineId,date,completed})` instead of a non-idempotent toggle, so retry has a defined meaning. Serialize overlapping writes to the same routine/day.

**Acceptance:** offline toggle, server rejection, rapid double-toggle, and analytics refresh after a slow write all produce a truthful view and a retry path.

### F12 · P2 · Weekly routine counts omit days in the adjacent month

**Owner:** Routines. **Evidence:** client/server contract comparison.

[weekCounts](../../apps/routines/src/context.tsx#L98) filters only `monthCompletions`, loaded for the selected calendar month. A week crossing a month boundary loses the adjacent month's completions. The server's [getDay](../../apps/routines/src/server/handlers.ts#L53) already calculates a complete week, but `DayResponseSchema` discards its `weekCounts` and the client recomputes an incomplete version.

**Simplify:** use one explicitly bounded completion-range resource. Fetch the union of the visible month and selected week, or consume the server's weekly aggregate consistently. Derive daily and weekly views from that data.

**Acceptance:** include completions on both sides of a month/year boundary and compare the displayed weekly count to the persisted rows.

### F13 · P2 · Console saves overwrite unrelated drafts; removing a var does not remove it

**Owner:** Console. **Evidence:** draft flow inspected; patch semantics reproduced against a temporary config.

[ConfigPage's effect](../../packages/console/src/routes/config.tsx#L59) resets every editable field whenever any save refetches config. Editing one app, then saving another section loses the first draft. [saveVars](../../packages/console/src/routes/config.tsx#L119) submits only remaining textarea keys, while [patchConfig](../../packages/shedflare-core/src/config/patch.ts#L86) treats omitted keys as unchanged. Removing a line and saving makes it reappear. A real patch with `vars:{}` retained the supposedly removed key.

**Simplify:** keep a server snapshot and section-scoped dirty drafts. Rebase only the saved section, or offer one explicit Save all action. Generate `null` deletions from the difference against the original editable vars, preserving hidden secret names. Render success and failure as different operation states.

**Acceptance:** edit two sections and save one without losing the other; delete a var and reload; preserve sensitive values that the form deliberately hides.

### F14 · P2 · Money undo/redo moves history before the operation succeeds

**Owner:** Money. **Evidence:** direct source path; existing tests cover returned errors rather than transport rejection.

[undo/redo](../../apps/money/src/lib/undo-stack.ts#L51) moves entries between stacks before awaiting `execute`. It restores them on `{ok:false}`, but not on a rejected fetch or decode failure. A failed undo can therefore appear available for redo despite never having been applied. Concurrent clicks also race on the shared stacks. Recreating an item during redo needs to retarget the next inverse to the newly returned ID, as is already partly handled for undo.

**Simplify:** one history state plus a single in-flight operation. Commit stack movement only after success and preserve history on every failure. Type each forward/inverse pair from the command map rather than `string` plus `object`.

**Acceptance:** rejected network request, rapid double-click, and create → undo → redo → undo all preserve both database state and the correct target ID.

### F15 · P2 · Central error collection drops handled HTTP failures

**Owner:** Observability and root orchestration. **Evidence:** actual tail handler reproduction plus source inspection.

[tail](../../apps/observability/src/worker.ts#L41) discards a trace with outcome `ok` before inspecting response status or error logs. A Worker can catch an exception, return 500, and still have a successful runtime outcome. Passing an `ok` trace with HTTP 500 and an error log to this handler scheduled **zero** persistence operations. Several routers explicitly catch exceptions and return 500.

Also, [patchTailConsumers](../../alchemy.run.ts#L26) parses JSON without checking HTTP status or Cloudflare's `success` field; an API rejection can look like successful wiring.

**Simplify:** classify runtime failures, HTTP failures, and application failures explicitly. Correlate them with request/operation IDs and named spans; avoid persisting full sensitive URLs by default. Make tail-wiring failure visible by validating the API envelope. Keep the existing centralized tail collection, but make its coverage truthful.

**Acceptance:** handled 500, unhandled exception, expected 4xx, and log-only failure have documented outcomes. Failed tail configuration is reported. Use [Cloudflare's observability guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#observability) for runtime instrumentation.

### F16 · P2 · Validation bypasses cover the new Chat implementation

**Owner:** Chat and root tooling. **Evidence:** reproduced with the configured checker.

[antiSlopIgnores](../../tooling/anti-slop.vite.ts#L15) includes the new API, bridge, example, and active route. The same list feeds formatting. Running `pnpm exec vp check` with the new handler, bridge, and route as explicit targets failed before analysis: all matched files were excluded. Those files also carry broad assertions (`as never`, double casts, and `any` in the bridge), making a green build weak evidence of API compatibility.

The route uses the actual `useChat` hook; the bridge/factory example is not the active UI. Its compatibility comments should not be treated as a verified promise about a future upstream release. `index.legacy.tsx` and `index.tsx.bak` are identical copies of the previous route, adding 9,130 lines of competing reference material under source.

**Simplify:** remove file-level bypasses in a scoped cleanup, type the route against the installed package exports, and keep any necessary interop cast at one documented boundary. Delete redundant source copies only after their migration role is resolved; Git already preserves the old route. Keep migration notes outside runtime routes.

**Acceptance:** the checker actually analyzes every active route/API; negative type examples fail; a browser test exercises the currently imported route. Separate Workers-test configuration from browser/application type checks.

### F17 · P2 · Auth's sign-out promise is stronger than its implementation

**Owner:** Auth and auth-client. **Evidence:** source path.

[Auth home](../../apps/auth/src/worker.ts#L88) says signing out revokes access everywhere on the next visit. [Logout](../../apps/auth/src/worker.ts#L621) deletes only `session:<id>` and the issuer cookie. It does not revoke existing app access/refresh tokens. Access tokens are configured for a year, and consumers verify JWTs locally rather than consulting that session record.

**Simplify:** make local-app logout and global revocation distinct, truthful operations. Choose an explicit token/session revocation design and describe its actual latency. Prefer supported issuer mechanisms over duplicating token issuance and refresh storage logic. Merely changing the copy does not implement revocation.

**Acceptance:** verify an already authenticated app after issuer logout and after explicit global revocation. Document which existing sessions remain valid and for how long.

### F18 · P2 · Partial usage failures are indistinguishable from missing usage

**Owner:** CF Bill, with a reusable pattern in Console. **Evidence:** source path.

[CF Bill's query wrapper](../../apps/cf-bill/src/server/impl/usage.ts#L191) collects errors but only uses them if every query fails. With one successful product, failed products disappear from `{period,products}`. The UI cannot distinguish zero usage, no resources, missing permissions, and an API failure. That is a misleading state model for an operator dashboard.

**Simplify:** return per-product `available | unavailable | failed` results with timestamps and error summaries. Preserve usable data and show what could not be loaded. Console already carries some inventory/usage errors; align semantics before extracting shared aggregation code.

**Acceptance:** one denied product query leaves other cards visible and gives the failed product an explanation/retry action. No failure is displayed as a measured zero.

## Simplification opportunities across the repository

These are design recommendations, not all separately reproduced defects. Keep each change within its app until two consumers establish a stable contract.

| Area               | Current complexity or UX gap                                                                                                                                                        | Smaller target                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat               | Global composer draft follows the user into another thread; window custom events connect composer and pane; delete updates only the index                                           | A thread-scoped controller/context owns send, stop, draft, transcript, and persistence result. Direct typed callbacks replace the global event bus. Chromium confirmed a draft follows “New chat.”                                                                         |
| Chat               | Implementation details appear in the composer/empty state; delete actions have no recovery; automatic scrolling ignores whether the user scrolled up                                | Explain product behavior, provide undo/confirmation for destructive actions, preserve draft on send failure, scroll only while following the latest message. Label icon-only controls.                                                                                     |
| Money              | Categories uses independent rename/delete/goal modal signals; Reports has parallel data/form signals; API command types widen to `string`/`object` despite a command schema map     | A discriminated editor state, a keyed report resource, and command payload/result types derived from `CommandInvocation`. Preserve separate independent field signals where they are genuinely independent.                                                                |
| Money              | Broad `money:data-changed` events refetch routes; pages also patch their own arrays, and overlapping reads have no consistent request ownership                                     | One app-local query invalidation policy with entity/query keys. Mutation responses update/invalidate that owner; avoid layering a second collection cache over every REST response.                                                                                        |
| Drive              | One context exposes data fetching, auth, pagination, toasts, drawer state, selection, and mutations                                                                                 | Split responsibilities into app-local session, file-query, upload, and interaction controllers. Derive `selectedFile` from one selected ID; make rename/delete/context-menu mutually exclusive when appropriate. Keep the existing streaming upload and cancellation work. |
| Routines           | Client recomputes server week data; revision is used as a catch-all invalidator; toggles have ambiguous retry semantics                                                             | Range-keyed completion data plus explicit desired-state writes. Share date/range calculations with the API contract, without introducing a suite-wide store.                                                                                                               |
| Anki               | One `busy` flag spans deck creation, card creation, and review; mutation failures have `finally` but no error presentation; answer visibility is separate from card identity        | A keyed review state (`question                                                                                                                                                                                                                                            | answer | submitting | failed`) and separate capture operation state. Preserve form input and show actionable errors. `src/app.tsx:75`, `:93`, and `:118` are starting points. |
| Links              | Load errors are swallowed and display “No links yet”; clipboard success is shown before its promise resolves                                                                        | A list resource with retry, and awaited copy/mutation results. Use the existing list schema instead of restating the row type. Start at `src/routes/index.tsx:24` and `:80`.                                                                                               |
| Homepage           | Client interfaces and generic `fetchJson<T>` restate server data; project/experience lists have no explicit loading/error/empty rendering                                           | Derive response types/decoders from the API definitions, and render all resource states. Validate parsed tags rather than treating arbitrary JSON as `string[]`.                                                                                                           |
| Discord            | Gateway has parallel reconnect flags plus persisted state; per-channel turn reads history, awaits inference, then appends messages without a turn queue or message-ID deduplication | Explicit connection phases and a per-channel queued operation keyed by Discord message ID. Test two overlapping mentions and replayed delivery before choosing the persistence design. This concurrency concern is source-based, not a live Discord reproduction.          |
| auth-client        | Shared cookie/redirect helpers exist, but consumers still assemble separate session hints, loading flags, auth errors, and refresh-cookie handling                                  | One documented session contract and a small shared session controller once consumer differences are understood. Keep owner checks server-side. Test callback, refresh, and signed-out recovery as real boundaries.                                                         |
| sync-protocol      | Context docs described Effect services/HTTP routers that no longer match the class API; only Chat currently extends the base and overrides much of command handling                 | Document the actual extension points; avoid expanding a generic engine for a nonexistent Money consumer. Test WebSocket acknowledgements, not just a returned command result: duplicate commands currently return early without the normal broadcast path.                 |
| Core/CLI/Console   | Core correctly owns manifest/config validation; Console has local draft problems; CLI advertises `--yes` but deploy always passes it and always selects prod                        | Preserve Core's authority. Give deploy one explicit parsed invocation model whose documented options match execution. Keep root-relative command usage explicit; do not infer safe deployment behavior from an unused option.                                              |
| UI package         | Four small tested primitives exist but apps do not consume them                                                                                                                     | Adopt one proven primitive at a time. Highest-value shared additions are accessible dialog/focus behavior and status/error presentation, not another theme or global state framework.                                                                                      |
| Site               | Product copy still calls Money DO/local-first and describes suite composition via pinned releases                                                                                   | Generate factual resource facts from app manifests and keep narrative copy aligned with the active route. `site/src/content.ts:34` and `:91` are stale.                                                                                                                    |
| Root orchestration | Source ownership is centralized, but the site is deployed unconditionally by the suite stack                                                                                        | Explicitly document that site behavior or make it selectable in a separately scoped change. Preserve Drive's independent lifecycle and physical resource names.                                                                                                            |

### State modelling rules worth adopting

1. **One authority per durable entity.** Browser caches, projections, and drafts need explicit lifetimes; none should silently become a second database.
2. **Keys own requests.** Tie async results to their query/thread/range key and discard stale completions. Advance pagination only after successful data receipt.
3. **Group mutually exclusive states, not every signal.** A modal can be `closed | renaming(id,draft) | deleting(id) | editingGoal(id,draft)`. Form fields that can vary independently can remain signals or a form store.
4. **Separate draft from saved state.** Refetching server data must not overwrite unrelated unsaved edits. Scope drafts by the identity they belong to.
5. **One user operation, one committed result.** Reconciliation and splitting should not be assembled from unrelated browser writes. Retry only with explicit idempotency semantics.
6. **Failure is data.** Include pending, failure, retry, partial success, and empty states in UI contracts. A swallowed error or empty fallback is not successful recovery.
7. **Derive contract types.** Money already has command schemas; use them at dispatch. Avoid generic `fetchJson<T>` that asserts a shape without decoding it. Use brands where mixing IDs/amount units is plausible, not on every string.
8. **Keep Effect at useful boundaries.** Name service operations/spans, decode input, preserve typed errors, and keep provider I/O outside authoritative transactions. Avoid converting simple Solid component state into an Effect service architecture.

## Verification and test priorities

The current suite has valuable real SQLite/Drizzle tests, particularly in Drive and Money, plus contract checks and small UI component tests. Its green status does not cover the flows above. Most of Chat's 67 normal tests exercise helpers/older behavior, while its local Workers tests are a separate command and the active browser route has no end-to-end coverage in that count.

Prioritize these behavioral tests over new lint rules or implementation-mirroring tests:

| Slice                      | Test boundary                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Money import               | Real parser → import plan → actual SQLite writes, including preview/replay/cross-account matching    |
| Money reconciliation/split | Real database state before/after success, injected failure, and retry                                |
| Chat history               | Current route → current endpoint → persistence → backup/restore, with old and new transcripts        |
| Chat session/mobile        | Current route at `?error=no_session`, 390px viewport, keyboard navigation, draft isolation           |
| Drive                      | Out-of-order query completion, pagination failure/retry, selection under filter changes              |
| Routines                   | Transport failure, overlapping completion writes, adjacent-month week, post-commit analytics         |
| Auth                       | Valid/missing/replayed state, PKCE, redirect normalization, refresh-cookie propagation, logout scope |
| Console                    | Save one dirty section, preserve another, remove a var, and preserve hidden sensitive fields         |
| Observability              | Handled HTTP 500 and rejected tail-wiring API response                                               |
| Shared test harness        | Executing D1 batch semantics and rollback, not returning statement objects                           |

Normal source checks/builds are local. The existing Alchemy and deployed browser E2E suites have a different resource lifecycle and should remain explicitly separate. Local Cloudflare pool tests should be documented independently from both.

## Suggested delivery order

1. **Restore trust in writes and login.** Separate focused changes for F01–F04 and F06–F09. Add the smallest behavioral regression test with each fix.
2. **Choose Chat's durable authority and migrate deliberately.** Fix F05 before deleting any legacy persistence or backup path. Remove route duplicates and broad checker exclusions as the active path gains coverage.
3. **Make asynchronous UI state reliable.** Drive query ownership, Routines mutations/ranges, Money history, Console drafts. These are app-local changes; do not introduce a universal store.
4. **Make status reporting truthful.** Observability classification, partial usage results, logout scope, and smaller-app errors.
5. **Consolidate proven patterns.** Typed command boundaries, shared auth recovery, a dialog primitive, and documentation/source checks. Keep deployment and app ownership explicit in every PR.

## Help for future agents

The accompanying documentation refresh replaces the obsolete root context with an entry-point/state map, points root guidance at it, and adds current-state notes to Chat and Money guidance. It distinguishes shipped behavior, legacy implementation, and proposals. The review does not authorize future agents to silently change storage authority or production resource ownership.

Documentation still needing a product-aware follow-up includes Chat's README/deepdives, Money feature claims (especially import/reconciliation), Site copy, and historical HTML onboarding/control-plane plans. Keep dated ADRs as history. For changing code, trace the actual import and route graph first; do not infer an active architecture from names such as `sync`, `collections`, `legacy`, or a historical plan.

Useful patterns to preserve: the modular monorepo and opt-in app ownership; `@shedflare/core` config/manifest authority; comment-preserving validated config patches; owner-only server checks; guarded E2E bindings; non-destructive `WorkerSecret` behavior; Drive's upload recovery work; derived budget totals; and real SQLite-backed persistence tests.
