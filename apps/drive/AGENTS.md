# Shedflare Drive – Agent Guidance

This directory contains Shedflare Drive inside the canonical monorepo. Keep it independently
testable, buildable, and deployable through scoped workspace commands. Its existing production
lifecycle remains outside the root suite deploy/destroy commands.

- Shared Shedflare dependencies must use `workspace:*`. Never commit `file:`, `link:`, sibling
  source paths, nested lockfiles, or app-local copies of root tooling.
- Use `vp` and the package scripts for Vite, formatting, linting, tests, and Alchemy commands.
- Use non-production stages for deployment proofs and destroy them after smoke testing.
- Do not change production resources, deploy to `prod`, or point a temporary stage at production D1 or R2 resources unless explicitly requested.
- Keep authentication owner-only. Do not add accounts, registration, tenants, or multi-user behavior.
- E2E authentication bindings are permitted only on stages whose names start with `e2e-`.
- Do not add `as any`; validate external inputs at their boundaries.

CLI upload/download dialogs share `src/components/CliCommandDialog.tsx`; path edits derive the
shell command locally through `src/lib/cli-commands.ts` and never issue new capabilities. Uploads
retain the multipart session flow. Download command creation is owner-protected in the file API;
`/api/cli-downloads/:id` verifies a purpose-specific, expiring capability bound to the file ID and
R2 object key before streaming. The existing `SECURE_UPLOAD_TOKEN_SECRET` signs both purposes;
upload and download tokens are not interchangeable. No public-sharing state is changed. Keep
shell-argument tests and anonymous download/expiry tests when changing either command path.
