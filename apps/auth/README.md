# Shedflare Auth

Central owner authentication for Shedflare. Apps use opaque, host-only session cookies and
validate them through a private Worker RPC service binding. OpenAuth runs inside the Auth Worker
and handles Google sign-in using its existing KV storage. Auth owns opaque session expiry and
revocation in D1. Consuming apps have no OpenAuth dependency, JWT verification, or refresh tokens.

See [Deployment Guide](docs/deployment.md) for configuration and the full-cutover procedure.

## Session lifecycle

1. An app creates a browser-bound login state and an S256 verifier, then redirects to Auth.
2. Auth validates the app ID and exact callback URL. An existing central session permits a
   silent handoff; otherwise an explicit sign-in redirects to Google.
3. OpenAuth's Google OIDC provider handles the redirect, encrypted provider cookie, and signed
   identity verification. Its success callback enforces Google's issuer and the verified owner
   email, then consumes the browser's pending app login flow once and creates a central session.
4. Auth returns a single-use code valid for 60 seconds. The app exchanges it through RPC with
   the verifier. The code is bound to the app and origin.
5. The app receives a random 256-bit session token in a Secure, HttpOnly, SameSite=Lax,
   host-only cookie. Only its SHA-256 hash is persisted. App sessions reference the central
   login, whose fixed expiry is 30 days; there is no refresh or positive validation cache.
6. Every protected request validates its token through RPC against the D1 primary. Logout
   from any app or Auth revokes that central login and its linked sessions and pending codes.
   Other devices' independent logins remain active. Already accepted requests or open
   WebSockets are not forcibly terminated; subsequent authenticated requests are rejected.

`src/openauth.ts` is the OpenAuth integration. Its success callback creates opaque sessions;
OpenAuth's public token/JWKS endpoints are not exposed and its tokens never reach consuming apps.
The existing `OPENAUTH_STORAGE` KV binding remains active for OpenAuth's encryption keys.

`src/db/schema.ts` is authoritative for RPC session data. Generate committed migrations with
`pnpm --filter @shedflare/auth db:generate`. Alchemy applies them on deployment. A daily scheduled
handler removes expired login transactions, codes, and sessions.

The browser's `auth_hint` is only a display hint. Invalid sessions return 401. An Auth/RPC/storage
failure returns 503 without erasing cookies or attempting a silent-login loop; the request can
be retried. Login exchange is single-use: if a response is lost after consumption, start sign-in
again. There is no automatic replay of mutations.

## Verification

`pnpm --filter @shedflare/auth test` runs local Miniflare Workers with real service bindings and
D1 and KV, running the real OpenAuth provider with a test Google signing key. It covers cross-app SSO,
revocation, expiry, replay and concurrent exchanges, callback validation, agent-token permissions,
and outage behavior. Google's discovery/public-key services and Cloudflare's deployment metadata
API are substituted. It creates no Cloudflare resources.

Root `pnpm test:auth` is the separate guarded live Alchemy suite.

## Agent deployment inspection

The CLI's normal login prints an approval link, waits for the owner to approve in their browser,
and saves the issued credential automatically. The owner sees the requesting CLI name, a code
matching the terminal, read-only permission, and expiry. Existing owner sessions go straight to
approval; signed-out browsers sign in with Google and return to the same request. Opening a link
does not approve it. Agent names are client-supplied, so approve only requests you started.

Auth owns short-lived requests in D1 (`agent_authorizations`), with hashes of random 256-bit
device codes and 60-bit browser codes. Requests expire after ten minutes. An atomic per-address
budget allows ten starts in ten minutes; polling begins at five-second intervals and rapid polls
increase the interval. Owner approval uses the same-origin, authenticated browser POST boundary.
Token creation and request consumption run in one D1 transaction; simultaneous polls issue only
one credential. Denials and expired requests never issue tokens. A lost successful issuance response
requires restarting login, as plaintext tokens are not retained by Auth. Separate `agent_login_flows`
records bind signed-out browsers to their original request; verified Google login does not itself
grant agent access. Daily cleanup removes expired requests and login flows.
After approval, the browser shows a connecting state and refreshes until Auth issues the CLI's
token. The management link appears after issuance, so the new token is already in the list.

For manual credentials, open Auth's **Manage agent tokens** page (`/tokens`) after signing in.
Create a named token with a lifetime of 1–90 days (default 30). Copy it from the creation response; the
plaintext cannot be retrieved again. The list shows the name, permission, expiry, and last use,
with a revoke button. Creation and existing tokens appear in separate panels, stacked on small
screens. Tokens are independent of browser sessions: logout leaves them active;
revocation or expiry rejects subsequent requests immediately. Changing the owner email also
invalidates tokens issued to the previous owner.

The only permission is `deployments:read`. Send the token in `Authorization: Bearer <token>` to
these Auth endpoints:

- `GET /api/agent/session`: token name, scope, and expiry; checks revocation without calling Cloudflare.
- `GET /api/deployments`: Cloudflare Worker names and creation/modification timestamps.
- `GET /api/deployments?worker=shedflare-prod-drive`: recent deployment history, including
  deployment timestamps and version IDs with traffic percentages. The first deployment is
  currently serving traffic; an uploaded version alone does not prove it is deployed.

The API returns only this metadata. It does not expose Worker source, bindings, secrets, app
data, or write operations. An agent token cannot authenticate to app APIs or manage tokens.
Tokens belong to this deployment owner and are hashed in Auth D1; no token cache is used.
Invalid tokens return 401. Missing inspection configuration, Cloudflare failures, invalid upstream
responses, and Auth storage failures return 503 with a retry hint. Retrying these GETs is safe.

Set `apps.auth.vars.CLOUDFLARE_ACCOUNT_ID` and provision the optional
`DEPLOYMENTS_CF_API_TOKEN` Worker secret through Alchemy. Use a dedicated Cloudflare API token
restricted to **Workers → Metadata Read-only** for that one account. Agent tokens do not
contain or return this upstream credential. In the new permissions UI, use the Workers product
role at **Entire Account** scope to inspect all Workers in the chosen account. The legacy
Workers Scripts Read permission still works but also permits reading script source; it is broader
than inspection needs. See [Cloudflare Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/). See the deployment guide for operator setup.

Automation can manage tokens using the same owner browser session and same-origin protection:
`GET /tokens` with `Accept: application/json` lists metadata; `POST /tokens` with the Auth
session cookie, `Origin: <auth-origin>`, `Accept: application/json`, and JSON
`{"name":"Deployment agent","days":30}` creates a token; `POST /tokens/<id>/revoke`
with the same cookie and Origin revokes it. Bearer authorization is rejected on management
routes. Store issued tokens in a secret manager or documented local secret file, outside Git.

The [Shedflare CLI](../../packages/cli/README.md) manages local credentials and inspection:

```sh
shedflare auth login --auth-url https://auth.example.com
shedflare auth status --json
shedflare deployments list --json
shedflare deployments history shedflare-prod-drive --json
```

Login normally uses browser approval. `--token-prompt`, `--token-stdin`, and `--token-file` accept
existing tokens when needed. `auth logout`
removes only the local credential. The bundled agent skill documents the read-only workflow.

The browser flow uses JSON `POST /api/agent/device/start` (`{"name":"Codex"}`) and
`POST /api/agent/device/poll` (`{"deviceCode":"..."}`). The CLI shares their schemas with Auth.
`GET /agent/authorize?user_code=...` displays approval, and its owner-only same-origin POST approves
or denies. These endpoints never proxy Cloudflare writes or app data. They follow device-flow
semantics with a Shedflare JSON contract, rather than exposing a general OAuth token endpoint.
