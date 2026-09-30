---
name: shedflare-deployments
description: Inspect Cloudflare Worker inventory and deployment history through Shedflare's read-only agent CLI, including questions about what is deployed or whether a pushed commit is live.
---

Use the Shedflare CLI's saved agent credential. It grants `deployments:read` through the owner's
Auth service. It cannot authenticate to app APIs or deploy resources.

If `shedflare` is unavailable and you are in a Shedflare checkout, run from its root with
`pnpm exec jiti packages/cli/src/index.ts` in place of `shedflare`. The inspection commands also
work outside the repository with the installed CLI.

```sh
shedflare auth status --json
shedflare deployments list --json
shedflare deployments history <worker-name> --json
```

Use inventory to find the relevant Worker, then request its history. History includes deployment
IDs, timestamps, version IDs, and traffic percentages. Report the Worker and timestamp, including
the user's timezone when available. Multiple versions may receive traffic. An uploaded version
does not prove a deployment; Cloudflare version IDs are not Git SHAs. To claim a particular commit
is live, corroborate the record with a public build identifier or documented CI deployment evidence.
Dirty build identifiers do not establish the exact committed contents. If evidence is incomplete,
state what the metadata establishes and what remains unknown.

Commands with `--json` produce one JSON result; failures exit 1 with `error.code` and `error.message`.
For `not_logged_in` or `invalid_token`, owner approval is needed. When the user asks to connect
agent access, start browser login and keep the process running:

```sh
shedflare auth login --auth-url https://their-auth-origin --name Codex --json
```

Show the approval link and comparison code from stderr to the user. They open it in their browser
and approve; never approve on their behalf or use their browser session to mint credentials.
The CLI polls for up to ten minutes and saves the token automatically. Stdout is one final JSON
result. On denial, cancellation or expiry, stop and report it; do not create another request
without user direction. `not_found` during login means Auth needs the device-flow update.

For explicitly requested automation setup with an existing token, use `--token-file <protected-file>` or `--token-stdin`
with `--json`. Do not read, print, or paste credentials into chat, command arguments, logs, or Git.
Use the CLI to attach them to requests. Credentials are in the user's configuration directory;
avoid inspecting that file during deployment questions.

`not_found` means check the Worker name or deployed Auth version. For `service_unavailable`,
one retry of the read is reasonable; if it persists, report that inspection/configuration needs
attention. Retain the saved credential on service failures. `invalid_response` requires checking
the deployed Auth version. Local logout removes a credential without revoking the server token;
revocation is on the Auth `/tokens` page. Inspection requests do not imply deployment authorization.
