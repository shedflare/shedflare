# Shedflare CLI

The CLI provides workspace setup and deployment commands, plus read-only deployment inspection
that works from any directory. In this checkout, run it from the repository root with
`pnpm exec jiti packages/cli/src/index.ts` in place of `shedflare` below. Build the executable with
`pnpm --filter ./packages/cli build`; its entry point is `packages/cli/dist/index.mjs`.

## Agent login

The Auth service must support browser-approved CLI login. Run:

```sh
shedflare auth login --auth-url https://auth.example.com
```

The CLI prints a clickable approval link and a code, then waits. Open the link in your browser,
check the code, and click **Approve**. An existing owner session opens approval directly; otherwise
Google signs you in and returns to it. The page shows the requesting CLI's name, read-only access,
and an editable expiry of 1–90 days (default 30). The name is supplied by the requesting client;
only approve requests you started. The CLI receives and saves the token automatically, without
displaying it. Set `--name Codex` to name the credential; otherwise it uses your machine's hostname.

Approval requests expire after ten minutes. Denial, expiry, Ctrl+C, or a failed login preserves
existing local credentials. Polling respects server backoff and retries temporary service failures
until expiry. Issuance is single-use and transactional. If its successful response is lost, start
login again; the first credential remains revocable on `/tokens` but cannot be retrieved.

Existing manually created tokens remain supported. Use `--token-prompt` for hidden input, or
for automation supply a protected file or pipe from your secret provider:

```sh
shedflare auth login --auth-url https://auth.example.com --token-file /secure/agent-token --json
shedflare auth login --auth-url https://auth.example.com --token-stdin --json < /secure/agent-token
shedflare auth login --auth-url https://auth.example.com --token-prompt
```

Credentials live at `$XDG_CONFIG_HOME/shedflare/agent.json` when the environment variable is an
absolute path, otherwise `~/.config/shedflare/agent.json`. Keep this directory outside the
repository. The CLI creates the directory with mode 0700 and the file with mode 0600, writes
atomically, and refuses to read symlink files or files with broader Unix permissions. Tokens are
stored locally in plaintext; restrict access to this directory. The Auth URL must be an HTTPS
origin; HTTP is supported only for loopback development. Requests never follow redirects.

```sh
shedflare auth status --json
shedflare deployments list --json
shedflare deployments history shedflare-prod-drive --json
shedflare auth logout --json
```

Status checks expiry and revocation using `GET /api/agent/session`, independently of the
Cloudflare inspection configuration. List returns `{workers:[...]}`; history returns
`{worker,deployments:[...]}` with timestamps, version IDs, and traffic percentages. These are
Cloudflare identifiers, not Git SHAs. A deployed build identifier is separate evidence when
matching a deployment to a commit.

Without `--json`, commands print readable results. With it, stdout contains one JSON result
and login never prompts locally. Browser login writes its approval link and progress to stderr,
leaving stdout as one final JSON result. This also works in agent sessions and over SSH; the browser
can be on another device. Failures exit 1 and return `{error:{code,message}}`; `not_logged_in`,
`invalid_token`, `not_found`, `service_unavailable`, and `invalid_response` distinguish common
failures. JSON results exclude credentials and unrecognized response fields. Failures preserve
the saved credentials. Logout removes the local copy; revoke the token on the Auth `/tokens`
page to invalidate every copy.

Browser login also reports `access_denied`, `expired_request`, `cancelled`, and `rate_limited`.
`not_found` during login means Auth needs the updated device endpoints. The CLI rejects approval
links outside the exact configured Auth origin. Secret device codes and issued tokens never appear
in terminal output, JSON output, or command arguments.

The inspection commands use only GET requests and expose no app data or deployment writes.
The CLI's existing operator deployment commands require their own Cloudflare credentials;
agent tokens do not authorize them. See [Auth setup](../../apps/auth/README.md#agent-deployment-inspection)
for the upstream account configuration.

## Agent skill

[shedflare-deployments](skills/shedflare-deployments/SKILL.md) teaches agents to check login,
inspect deployment metadata, and distinguish deployment records from Git commit evidence.
Copy its folder into your agent's skill directory; for Codex, use
`${CODEX_HOME:-$HOME/.codex}/skills/shedflare-deployments`.
