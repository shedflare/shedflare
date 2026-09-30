# Shedflare

Shedflare is a modular, self-hosted collection of personal productivity apps for Cloudflare. The
source lives in one monorepo, while every app remains an independently selectable and deployable
Alchemy stack. You can run one app, a hand-picked set, or the full suite.

See [ADR 0002](docs/architecture/0002-modular-monorepo.md) for why the project returned to a
monorepo after completing a split-repository experiment.

## Repository layout

```text
apps/       independently deployable applications
packages/   shared libraries, CLI, and local console
site/       public Shedflare project website
tools/      repository-owned development tooling
```

There is one Git history, pnpm workspace, lockfile, toolchain, and CI pipeline. Internal
`@shedflare/*` dependencies use `workspace:*`; apps do not carry nested lockfiles or copies of root
tooling.

## Apps

| App           | Source                                     | Description                                            |
| ------------- | ------------------------------------------ | ------------------------------------------------------ |
| Anki          | [`apps/anki`](apps/anki)                   | Spaced-repetition cards and review                     |
| Auth          | [`apps/auth`](apps/auth)                   | Shared owner sessions over Worker RPC                  |
| CF Bill       | [`apps/cf-bill`](apps/cf-bill)             | Cloudflare usage and plan-limit dashboard              |
| Chat          | [`apps/chat`](apps/chat)                   | AI chat with browser automation and synchronized state |
| Discord       | [`apps/discord`](apps/discord)             | Personal Discord bot                                   |
| Drive         | [`apps/drive`](apps/drive)                 | File storage backed by D1 and R2                       |
| Homepage      | [`apps/homepage`](apps/homepage)           | Personal homepage                                      |
| Links         | [`apps/s`](apps/s)                         | Link shortener; its stable app ID remains `s`          |
| Money         | [`apps/money`](apps/money)                 | Envelope-budgeting personal finance app                |
| Observability | [`apps/observability`](apps/observability) | Centralized Worker tail-event collection               |
| Routines      | [`apps/routines`](apps/routines)           | Daily routine tracker                                  |

## Development

Install and verify the whole workspace from the repository root:

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Use pnpm filters when working on one app or package:

```bash
pnpm --filter @shedflare/chat dev
pnpm --filter @shedflare/chat check
pnpm --filter @shedflare/chat test
pnpm --filter @shedflare/chat build
```

The root checks also enforce monorepo boundaries, generated app registry/schema consistency, and
the suite deployment contract.

When filing an issue or opening a pull request, name the affected app or package. The repository's
issue forms keep app-specific reports searchable even though they share one tracker.

## Configuration

`shedflare.config.jsonc` is the gitignored desired-state configuration. Copy the versioned example,
then select only the apps you want:

```bash
cp shedflare.config.example.jsonc shedflare.config.jsonc
```

App manifests live at `apps/*/shedflare.app.jsonc`. After changing the catalog, regenerate and
verify the typed registry and schemas:

```bash
pnpm registry:generate
pnpm contract:check
```

Operator secrets are managed through `Shedflare.WorkerSecret`; see
[`docs/operator-secrets.md`](docs/operator-secrets.md).

```bash
shedflare secret set chat OPENCODE_GO_API_KEY          # Cloudflare only (default)
shedflare secret set chat OPENCODE_GO_API_KEY --local  # local .env only
shedflare secret set chat OPENCODE_GO_API_KEY --both   # explicit mirror
```

Production deploys authenticate with the Alchemy Cloudflare profile and preserve secrets already
stored on the Worker. They deliberately ignore the repository `.env`; local development reads it.

## Deployment

All deployments use [Alchemy](https://alchemy.run); Wrangler is not part of the deployment or
secret-management path. Production commands are intentionally explicit:

```bash
pnpm deploy:auth       # one app
pnpm deploy:chat
pnpm deploy:s          # Links
pnpm deploy            # selected suite
```

Deploy Auth first when using shared SSO. Drive's source is maintained here, but its existing
production stack retains an independent deployment lifecycle and is deliberately excluded from the
root suite deploy/destroy commands.

For a temporary stage, invoke an app stack with a non-production stage name:

```bash
pnpm --filter @shedflare/chat deploy:stage --stage dev-bolt
```

Never deploy, destroy, publish, or transfer production resource ownership merely as part of a source
change. Those operations require explicit approval.

## CLI and console

The `shedflare` CLI provides configuration, deployment, secret, diagnostic, and read-only agent
inspection commands. See [agent login and deployment inspection](packages/cli/README.md).
The local Console is the human-facing control plane:

```bash
pnpm dashboard
shedflare doctor
```
