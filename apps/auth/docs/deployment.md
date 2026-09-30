# Auth deployment

Alchemy owns Auth and app resources. Each app binds `AUTH` to the Auth Worker in the same account
and stage, except explicitly configured legacy production aliases described below.
`AUTH_URL` is used only for browser redirects. There is no HTTP validation fallback
or external-issuer mode. Deploy Auth before deploying its consuming apps individually. Drive
remains independently deployed and must be updated separately.

## Configure

Select Auth in `shedflare.config.jsonc` and set `apps.auth.vars.GOOGLE_CLIENT_ID`. The owner email
comes from root `ownerEmail`; the public URL comes from the root domain and Auth subdomain.
The Google client redirect URI remains:

```text
https://auth.<your-domain>/google/callback
```

OpenAuth's Google OIDC provider still handles sign-in, including the ID-token form-post flow
and browser-bound nonce verification. No new Google client secret is required. Only the deployment
owner's verified email is accepted. OpenAuth runs only inside the Auth Worker.

The allowed-client map is generated from configured apps. Independently deployed apps or extra
origins can be listed in `apps.auth.vars.ADDITIONAL_ALLOWED_CLIENTS`:

```json
{
  "shedflare-drive": ["https://drive.example.com"]
}
```

Each entry uses `shedflare-<app>` and canonical HTTPS origins. The callback must be exactly
`<origin>/api/auth/callback`. Additional origins do not change the service binding target: a
preview must have its own same-stage Auth deployment and storage. Temporary deployments must
never bind to production Auth.

Existing production deployments with older Alchemy stage names can retain their ownership and
hostname using an explicitly approved `productionAliases` entry in version 2 desired-state config:

```json
{
  "apps": {
    "routines": { "productionAliases": { "dev_bolt": "routines" } },
    "drive": { "productionAliases": { "dev_bolt": "drive-dev-bolt" } }
  }
}
```

Each entry maps an existing ownership stage to its existing subdomain under the configured domain.
Only that exact stage binds production Auth; unlisted stages use their own URLs, Auth, and storage.
Auth automatically includes these callback origins. `prod` and `e2e-*` cannot be alias keys, and
Auth itself cannot declare aliases. Core preserves aliases through validation, migration, and config
patches. The CLI chooses a legacy stage when it owns the canonical app hostname; direct Alchemy
deployment with the wrong production stage fails before resources are created. Suite deployment is
disabled while canonical apps use mixed ownership stages: deploy those apps individually.

Alchemy `2.0.0-beta.59` is patched through the root pnpm configuration to retain `secret_text` and
`secret_key` bindings during Worker uploads. Separate `WorkerSecret` resources continue to own
setting secret values. A live isolated proof verified that a Worker update with an unchanged secret
resource retained the original secret value; the proof Worker was destroyed afterward.

## Full cutover

This is a breaking session migration. Old access/refresh cookies and issuer sessions are ignored;
everyone signs in again. There are no shims, data imports, legacy token exchanges, or fallback reads of
old credentials. Schedule Auth and app deployments together: old apps stop authenticating once
Auth is updated. Deploy the Auth stack first, then all consumers, including independent Drive.

Alchemy creates `AuthDatabase` with binding `AUTH_DB` and applies the generated D1 migrations.
Worker names, stack identities, and existing app data resources are unchanged. The existing
`AuthStorage` KV resource and `OPENAUTH_STORAGE` binding remain active for OpenAuth's encryption
keys. RPC sessions and handoffs use D1; no old app tokens or KV sessions are imported or accepted.

After explicit production approval, use scoped deployment commands for this cutover: Auth first,
then each configured consumer. `pnpm deploy:drive` handles Drive separately. For an approved isolated proof stage, commands are
non-interactive and must use that stage for Auth and every consumer:

```bash
pnpm exec alchemy deploy apps/auth/alchemy.run.ts --stage auth-rpc-proof --yes
pnpm exec alchemy deploy apps/money/alchemy.run.ts --stage auth-rpc-proof --yes
# Verify login, cross-app SSO, logout, and rejection of old credentials.
pnpm exec alchemy destroy apps/money/alchemy.run.ts --stage auth-rpc-proof --yes
pnpm exec alchemy destroy apps/auth/alchemy.run.ts --stage auth-rpc-proof --yes
```

Configure isolated HTTPS URLs, the Google callback, and build the app before a live proof.
The local Miniflare tests need neither credentials nor deployment approval. Live app smoke tests
and Drive/Money browser E2E runners provision same-stage Auth first and destroy it after their
app. They require the Auth configuration (including the Google client ID) even when the browser
suite uses its existing stage-guarded E2E credentials.

## Optional agent access

Read-only Cloudflare deployment inspection requires an account ID and a dedicated upstream API
token. Set `apps.auth.vars.CLOUDFLARE_ACCOUNT_ID` in the desired-state config. Create a Cloudflare
API token restricted to **Workers → Metadata Read-only**, scoped to that account, then
provide `DEPLOYMENTS_CF_API_TOKEN` in a documented, ignored local environment file. An approved
isolated deployment can load that file non-interactively:

```bash
pnpm exec alchemy deploy apps/auth/alchemy.run.ts --stage agent-inspection-proof --env-file /path/to/isolated-auth.env --yes
```

Use isolated account/resources for the proof, then destroy the temporary stage as described above.
Setting a production secret or deploying production requires explicit operator approval.
Auth uses the optional `WorkerSecret` lifecycle and preserves an existing secret when
no value is supplied. Without the account ID or secret, sign-in remains available and inspection
returns a clear 503 configuration error.

Alchemy applies the `agent_tokens` migration alongside the session migrations. No agent tokens
are issued during deployment. With the browser-login update deployed, `shedflare auth login`
prints an approval link, polls, and saves a named, expiring token after the owner approves.
The update adds `agent_authorizations` and `agent_login_flows` tables in the existing Auth D1;
its migration is additive and does not change app sessions, RPC contracts or persistent bindings.
Manual token creation at `/tokens` remains available. These tokens grant only `deployments:read` and cannot deploy,
destroy, inspect app data, or manage credentials. Browser logout does not revoke them; revoke
them explicitly from the token page. The initial RPC migration required the coordinated
Auth/app cutover below. After consumers are migrated, browser-login updates deploy Auth independently.

## Production rollout: 2026-10-01

The operator approved the coordinated rollout for Auth, Drive, Chat, Money, CF Bill, Routines,
and Links after reviewing the legacy-name and secret-retention fixes. All eight stack/stage
deployments below completed and passed live verification on 2026-10-01 in Asia/Jakarta
(2026-09-30 18:03–18:10 UTC). Worker names, ownership stages, domains, existing storage identities,
and existing secret bindings were retained. Auth D1 was created as
`3e97abd1-ad5f-4748-ad65-9d5a2f55211f`. Legacy Drive received its additive secure-upload migration
and a new upload secret, retaining its existing database and bucket.

`pnpm check` passed with Go memory/concurrency limits for this host. The complete serial normal
test run passed 528 tests with 4 skips. Isolated live proofs verified unchanged secret values
across Worker updates, Auth/Drive RPC calls, invalid-session rejection, and Google redirect setup;
all proof resources were destroyed. Each production consumer then passed storage-ID, secret-name,
domain-ownership, RPC invalid-session, and Google redirect checks. The owner's interactive Google
sign-in and authenticated app-data access remain manual verification steps.

The account-wide follow-up audit covered 86 Workers and found an additional external consumer:
`simple-devices-dev_bolt` at `https://devices.peculiarnewbie.com`, using legacy client ID
`simple-devices` and `AUTH_ISSUER_URL`. This project is outside the Shedflare repository and was
not changed. Its legacy login flow is incompatible with the new Auth; the operator confirmed
that it is unused and explicitly requested leaving it for now. All seven Shedflare consumer deployments use
the new `AUTH` RPC binding and no longer expose `AUTH_ISSUER_URL`.

### Existing resources to preserve

| App          | Alchemy stack / stage            | Worker                        | Public hostname                     |
| ------------ | -------------------------------- | ----------------------------- | ----------------------------------- |
| Auth         | `ShedflareAuth` / `prod`         | `shedflare-prod-auth`         | `auth.peculiarnewbie.com`           |
| Drive        | `ShedflareDrive` / `prod`        | `shedflare-prod-drive`        | `drive.peculiarnewbie.com`          |
| Chat         | `ShedflareChat` / `prod`         | `shedflare-prod-chat`         | `chat.peculiarnewbie.com`           |
| Money        | `ShedflareMoney` / `prod`        | `shedflare-prod-money`        | `money.peculiarnewbie.com`          |
| CF Bill      | `ShedflareCfBill` / `dev_bolt`   | `shedflare-dev-bolt-cf-bill`  | `cf-bill.peculiarnewbie.com`        |
| Routines     | `ShedflareRoutines` / `dev_bolt` | `shedflare-dev-bolt-routines` | `routines.peculiarnewbie.com`       |
| Links        | `ShedflareS` / `dev_bolt`        | `shedflare-dev-bolt-s`        | `s.peculiarnewbie.com`              |
| Legacy Drive | `ShedflareDrive` / `dev_bolt`    | `shedflare-dev-bolt-drive`    | `drive-dev-bolt.peculiarnewbie.com` |

All six consuming apps currently point at production Auth using `AUTH_ISSUER_URL`.
The additional legacy Drive deployment also uses production Auth and is affected by this cutover.
The legacy stage label on CF Bill, Routines, and Links does not make them isolated test deployments:
they serve the owner's normal app domains and existing data.

| Resource                      | Existing identity                      |
| ----------------------------- | -------------------------------------- |
| Auth KV                       | `cd2198ecd63f46648faf1867f3911a1f`     |
| Drive D1                      | `01957fc3-6ab5-4e85-a59a-3fd2c6577596` |
| Drive R2                      | `shedflare-prod-drive-files`           |
| Chat Durable Object namespace | `6e05787b81c9483b836f099d7443244c`     |
| Chat R2                       | `shedflare-prod-chat-uploads`          |
| Money D1                      | `9fae6cfd-da6f-41ed-bb42-5947cb27cd8d` |
| Money R2                      | `shedflare-prod-money-uploads`         |
| Routines D1                   | `42dfacef-e1d0-4ddf-b884-a882c04f9f7b` |
| Links D1                      | `952ca668-81b1-419f-840e-f52b6f5d1abd` |
| Legacy Drive D1               | `d1809e89-6b3c-4693-8ec3-613086802107` |
| Legacy Drive R2               | `shedflare-dev-bolt-drive-files`       |

### Preparation findings and resolution

The findings below were the execution gates. They were resolved by the approved production-alias
configuration, the pnpm Alchemy patch and live retention proof, matching CF Bill ownership-tag
recovery without `--adopt`, reviewed forward plans, and prepared rollback builds/stacks. The
rollback inputs remain in the ignored `.shedflare/auth-cutover-rollback` directory and the external
`/home/bolt/git/web/shedflare-auth-cutover-rollback` worktree at `fa3e531`. Its Auth rollback plan
retains the new D1 database and existing KV; the Drive rollback plan retains storage and secrets.

1. **Resolve the legacy production mapping.** The current `dev_bolt` plans preserve the Routines
   and Links databases, but change their public URLs to stage-suffixed hosts and bind `AUTH` to
   `shedflare-dev-bolt-auth`. Running them with `--stage prod` instead would select different
   resource names and state. Neither plan implements the intended cutover. Prepare an explicit,
   operator-approved mapping that retains the existing stack/stage identities, Worker
   names, public hostnames, and databases while targeting `shedflare-prod-auth` and its public
   URL. Include the legacy Drive deployment in the reviewed migration; do not silently leave
   its production Auth dependency broken. It has separate data resources and no existing upload
   secret binding. Its plan also updates the existing D1 database and creates the upload secret.
   Check its migration ledger and schema before applying the additive public-file and secure-upload
   migrations; do not replace the database or reapply an already completed initial migration.
   Keep the exception restricted to these existing deployments; new previews must
   retain same-stage Auth and isolated storage. This changes the current same-stage contract and
   needs a separately approved migration under the root deployment guidance before application.
2. **Preserve secrets during Worker uploads.** Alchemy `2.0.0-beta.59` currently sends
   `keepBindings: undefined` in `Cloudflare/Workers/WorkerProvider.ts`. Its Worker upload does
   not include the secrets managed separately by Shedflare's `WorkerSecret` resources. The
   Drive and Chat plans mark those secret resources as unchanged, so a later reconcile cannot
   be relied on to restore them. Prepare and verify secret inheritance or retention in the
   Alchemy upload path before applying any of these Worker updates. Cloudflare documents
   [`keep_bindings`](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
   as the binding types retained from the previous upload. Preserve the existing values of
   `SECURE_UPLOAD_TOKEN_SECRET`, `UPLOAD_TOKEN_SECRET`, `OPENCODE_GO_API_KEY`, `EXA_API_KEY`,
   and `CF_API_TOKEN`; do not rotate them or copy their plaintext into artifacts.
3. **Confirm CF Bill state recovery.** The Cloudflare Worker has matching
   `ShedflareCfBill` / `dev_bolt` / `CfBillWorker` ownership tags, and its plan recognizes an
   existing Worker update. The state store's stack listing did not include `ShedflareCfBill`.
   Verify recovery of that existing ownership and the retained domain before applying it.
   Do not use a blanket `--adopt` flag or create a replacement Worker.
4. **Re-plan all eight stack/stage deployments after those changes.** Auth may create its new D1
   database and migrations. Existing app storage identities, domains, and secret values must remain unchanged. Verify
   every consumer's `AUTH` target is `shedflare-prod-auth`, every `AUTH_URL` is the existing
   production Auth origin, and Auth allows all seven existing callback origins, including legacy
   Drive. Do not use the root suite deployment: Drive is independent and this cutover excludes
   other suite resources.
5. **Prepare recovery before starting the outage.** Retain the prior source/build inputs and
   prepare Alchemy rollback stacks using the same resource identities. A rollback must keep
   the newly created Auth D1 resource declared, even when serving the previous Auth Worker;
   removing it from the stack could schedule deletion. Review rollback plans for storage and
   secret preservation. Version IDs below are evidence of the previous deployments, not a
   substitute for an Alchemy rollback plan.

On 2026-10-01 at 02:02 Asia/Jakarta (2026-09-30 19:02 UTC), the operator supplied the dedicated
Workers Metadata Read-only token and approved the Auth follow-up deployment. Alchemy uploaded
`DEPLOYMENTS_CF_API_TOKEN`, applied the additive browser-login tables, and deployed Auth version
`4bee35dc-421e-4101-a85b-7639a2bd8493`. The existing Auth D1 and KV were retained. The upstream
token passed inventory and deployment-history reads. Optional deployment secrets now read
Alchemy's ConfigProvider, including `--env-file`, rather than requiring exported process variables.
The browser-login endpoints are live; issuing an agent credential still requires owner approval.

An owner approval exposed a native-form regression: `Referrer-Policy: no-referrer` sends
`Origin: null`, which Auth correctly rejects. The 02:10 Asia/Jakarta follow-up deployed version
`e8ef4556-755c-4bc1-9399-fb290947bc3a` with `same-origin` policy for HTML; other responses retain
`no-referrer`. Cross-origin, missing-origin and null-origin approvals remain rejected. All 44 Auth
tests passed. Chromium reproduced the failure with the previous live policy and confirmed the
correct form origin with the new live policy. No databases, storage or secrets changed.

The owner then approved the Codex request. The CLI saved its credential automatically and
verified authenticated status, inventory for 86 Workers, and production Auth deployment history
through the read-only agent API.

At 02:20 Asia/Jakarta, Auth version `2b43d4b1-f464-4d48-aceb-efef117c41e4` added separate
responsive token panels and an automatically refreshing connecting page. The management link
now appears after transactional issuance, preventing navigation to the list before the new token
exists. All 44 Auth tests and `pnpm check` passed; Chromium verified the connecting transition and
desktop/mobile layouts. Live checks confirmed the layout, 100% deployment traffic, preserved
Auth storage/secret bindings, and continued read-only access with the saved Codex credential.

### Deployment sequence and verification

Auth and Drive scoped builds and local tests passed: 36 Auth tests and 129 Drive tests.
Chat, Money, CF Bill, Routines, and Links builds also passed. Read-only plans for all eight
stack/stage deployments completed; the legacy plans are diagnostic and must not be applied as
currently written. `pnpm check` passed, including repository boundaries and generated contracts.

After the gates above pass, deploy Auth first, then Drive, Chat, Money, CF Bill, Routines,
and Links, including the legacy Drive deployment, in one maintenance window. Old sessions require
a fresh sign-in. The outage starts when Auth changes and ends as each consumer is migrated;
deployments are not atomic.

Use the reviewed per-app Alchemy commands from the repository root, with explicit stack files,
stages, `--profile party --env-file .env --yes`. Keep the four legacy deployments in `dev_bolt` under
the approved mapping. After each deployment, inspect live settings to compare storage IDs,
secret names, domain ownership, and the Auth service binding against this inventory. Verify
unauthenticated APIs reject access and the login redirect uses the expected client and callback.
Then verify owner sign-in, cross-app SSO, logout, and existing data in all seven consumer deployments.
Local tests do not establish that the owner's live Google sign-in or live data access succeeds.

If verification fails, stop the rollout and use the reviewed coordinated Alchemy rollback.
Restore compatible consumer builds and the previous Auth together, preserving all storage;
do not destroy stacks or rotate credentials to recover from a login failure.

| Worker                        | Previous version at 100% traffic       |
| ----------------------------- | -------------------------------------- |
| `shedflare-prod-auth`         | `58920a01-ee9c-4c74-b6df-653ac85d4228` |
| `shedflare-prod-drive`        | `dd432c5c-2d2f-48d7-8fef-f01635f57248` |
| `shedflare-prod-chat`         | `7181808c-c185-43f6-8149-011375655f93` |
| `shedflare-prod-money`        | `98bcb6e2-e566-45f4-bd51-d3b419234a07` |
| `shedflare-dev-bolt-cf-bill`  | `0c809a34-0dce-427c-956a-f9c59d01746a` |
| `shedflare-dev-bolt-routines` | `c449fce7-e867-4cbe-9267-1bb433e785d1` |
| `shedflare-dev-bolt-s`        | `dffe9da7-fb01-40ba-ab87-53e559a401bc` |
| `shedflare-dev-bolt-drive`    | `fdfe82f8-3cde-44cb-ab66-54b8e21b1ba4` |

### Deployed versions

| Worker                        | Version at 100% traffic                |
| ----------------------------- | -------------------------------------- |
| `shedflare-prod-auth`         | `35f24846-e82c-4d00-99be-667ec256c9e9` |
| `shedflare-prod-drive`        | `92bba113-8528-4eeb-b952-98da42a019d9` |
| `shedflare-prod-chat`         | `57c93815-8e70-4e1c-bbdd-8c1317589a3f` |
| `shedflare-prod-money`        | `da0f353b-d11e-470e-87b7-18c6ed44fa60` |
| `shedflare-dev-bolt-cf-bill`  | `58bebb2a-c7b6-4ed8-8131-91fb7e13bf02` |
| `shedflare-dev-bolt-routines` | `b5a6dc23-5b38-4772-a181-df360b9bac17` |
| `shedflare-dev-bolt-s`        | `0139537a-141d-4f94-88a8-938d86c5527f` |
| `shedflare-dev-bolt-drive`    | `90e031f9-dc93-411a-a616-84ab73bb2629` |
