# Shedflare Drive

A private, self-hosted file manager backed by Cloudflare R2 object storage and D1 metadata. Drive can
be configured and deployed independently even though its source lives in the Shedflare monorepo.

## Features

- Files stored in a private R2 bucket
- Searchable D1 metadata, tags, and public-file links
- Multipart uploads for files larger than 10 MiB
- Owner-only authentication through Shedflare Auth

Drive uploads multipart files in 10 MiB parts with up to three concurrent parts, retries transient failures, reports progress, and aborts unfinished uploads when canceled.

Choose **CLI upload** in the signed-in toolbar, enter a local file path, and copy the command.
The preview updates as you type, including paths with spaces, apostrophes, or `~/`. Enter the
path without surrounding quotes. The command requires Bash and curl, starts with a two-minute
capability by default, transparently uses 10 MiB multipart requests, and rejects files over 500 MB.
Once an upload starts, its file-bound session can continue after the initial capability expires.

Choose **CLI download** in a file's details or context menu to get a curl command. Edit **Save as
path** to choose the destination, including its filename; missing directories are created. The
command grants access only to that file until expiry and does not make it public. Anyone holding
the command can download that file during its validity period. Downloads can be retried (including
byte-range requests) before expiry; deleting the file invalidates the command. An already-started
transfer can finish after expiry. Both dialogs offer 2-, 5-, and 10-minute commands and renewal.

## Requirements

- Node.js 22.12 or newer
- pnpm 11.9
- A Cloudflare account with Workers, D1, and R2 available
- An external Shedflare Auth issuer for the initial `0.1.x` release

## Setup

```sh
git clone git@github.com:shedflare/shedflare.git
cd shedflare
pnpm install
cp shedflare.config.example.jsonc shedflare.config.jsonc
cp apps/drive/.dev.vars.example apps/drive/.dev.vars
pnpm --filter @shedflare/drive check
pnpm --filter @shedflare/drive test
pnpm --filter @shedflare/drive build
```

Set the root `domain` and `ownerEmail`, add `"drive": {}` under `apps`, and keep `auth`
selected in `shedflare.config.jsonc`. App URLs and the shared Auth issuer are derived from that
typed catalog.

## Deploy

Review a temporary-stage plan before deploying:

```sh
pnpm --filter @shedflare/drive plan --stage pilot
pnpm --filter @shedflare/drive deploy:stage --stage pilot
pnpm --filter @shedflare/drive destroy:stage --stage pilot
```

Non-production stages receive derived subdomains and isolated resource names. For example, stage `pilot` uses `drive-pilot.example.com`, `shedflare-pilot-drive`, and `shedflare-pilot-drive-files` instead of their production equivalents.

Production deployment is explicit:

```sh
pnpm --filter @shedflare/drive deploy
```

Alchemy owns the Worker, D1 database, and R2 bucket lifecycles. Never point a test stage at production resources, and do not destroy a stage containing data you intend to keep.

See the [deployment guide](docs/deployment.md) for the resource model and migration safety notes.
