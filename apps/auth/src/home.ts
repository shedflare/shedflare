import type { AgentTokenMetadata } from "./tokens";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAuthHome(opts: { email: string | null; appOrigins: string[] }): string {
  const { email, appOrigins } = opts;
  const apps = [...new Set(appOrigins)]
    .sort()
    .map(
      (origin) =>
        `<a class="app-link" href="${escapeHtml(origin)}" target="_blank" rel="noreferrer">${escapeHtml(origin.replace(/^https?:\/\//, ""))}</a>`,
    )
    .join("");

  const body = email
    ? `
    <div class="card">
      <p class="eyebrow">Signed in</p>
      <h1 class="title">${escapeHtml(email ?? "")}</h1>
      <p class="sub">Your session is active on this auth domain. Signing out revokes it everywhere — apps will ask you to sign in again on your next visit.</p>
      <a class="app-link" href="/tokens">Manage agent tokens</a>
      <form method="post" action="/logout">
        <button class="btn btn-danger" type="submit">Sign out</button>
      </form>
    </div>`
    : `
    <div class="card">
      <p class="eyebrow">Not signed in</p>
      <h1 class="title">Shedflare Auth</h1>
      <p class="sub">No active session on this auth domain. Open any app below and sign in with Google — it will establish a session here too.</p>
      ${apps ? `<div class="apps">${apps}</div>` : ""}
    </div>`;

  return renderPage(body);
}

export function renderAgentTokens(tokens: AgentTokenMetadata[], issuedToken?: string): string {
  const rows = tokens
    .map(
      (token) => `<article class="token">
        <h3>${escapeHtml(token.name)}</h3>
        <p class="sub">${token.scope} · ${token.expiresAt > Date.now() ? "Expires" : "Expired"} ${new Date(token.expiresAt).toISOString()}</p>
        <p class="sub">Last used: ${token.lastUsedAt ? new Date(token.lastUsedAt).toISOString() : "never"}</p>
        <form method="post" action="/tokens/${escapeHtml(token.id)}/revoke">
          <button class="btn btn-danger" type="submit">Revoke</button>
        </form>
      </article>`,
    )
    .join("");
  return renderPage(`<main class="token-page">
    <header class="page-header">
      <a class="sub" href="/">Back to Auth</a>
      <h1 class="title">Agent tokens</h1>
      <p class="sub">Read-only access to Cloudflare Workers and deployment history. Tokens cannot access app data or change resources.</p>
    </header>
    <div class="token-layout">
      <section class="card" aria-labelledby="create-token-heading">
        <h2 id="create-token-heading">Create a token</h2>
        <p class="sub">Create one manually, or let your agent request access through browser approval.</p>
        ${issuedToken ? `<div class="issued-token" role="status"><p>Copy this token now. It is shown only once.</p><pre>${escapeHtml(issuedToken)}</pre></div>` : ""}
        <form method="post" action="/tokens">
          <label>Name <input name="name" required maxlength="80" placeholder="My agent" /></label>
          <label>Expires in days <input name="days" type="number" required min="1" max="90" value="30" /></label>
          <p class="sub">Permission: deployments:read</p>
          <button class="btn" type="submit">Create token</button>
        </form>
      </section>
      <section class="card" aria-labelledby="existing-token-heading">
        <h2 id="existing-token-heading">Existing tokens <span class="token-count">${tokens.length}</span></h2>
        <p class="sub">Signing out does not revoke these tokens. Revoke access here when you no longer need it.</p>
        <div class="token-list">${rows || '<p class="empty-state">No agent tokens yet. Approved agents will appear here.</p>'}</div>
      </section>
    </div>
  </main>`);
}

function renderPage(body: string, refresh = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${refresh ? '<meta http-equiv="refresh" content="2" />' : ""}
<title>Shedflare Auth</title>
<style>
  :root {
    --bg: #0f1117;
    --panel: #1a1d27;
    --text: #e4e4e8;
    --text-secondary: #7f8394;
    --line: rgba(255, 255, 255, 0.06);
    --accent: #2dd4a8;
    --danger: #e5484d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
  }
  .card {
    width: min(420px, 100%);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 32px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .eyebrow {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .title { font-size: 1.5rem; font-weight: 700; word-break: break-word; }
  .sub { color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; }
  .apps { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .app-link {
    display: block;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--text);
    font-size: 0.9rem;
    text-decoration: none;
  }
  .app-link:hover { border-color: var(--accent); }
  .btn {
    margin-top: 8px;
    padding: 10px 16px;
    border: none;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-danger:hover { opacity: 0.9; }
  label { display: block; margin: 12px 0; }
  input {
    display: block;
    width: 100%;
    padding: 10px;
    margin-top: 6px;
    border: 1px solid var(--text-secondary);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; }
  h2 { font-size: 1.1rem; }
  h3 { font-size: 1rem; }
  .token-page { width: min(960px, 100%); }
  .page-header { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
  .page-header .sub { max-width: 640px; }
  .token-layout { display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr); gap: 24px; align-items: start; }
  .token-layout .card { width: 100%; }
  .token-count { margin-left: 6px; color: var(--text-secondary); font-size: 0.85rem; font-weight: normal; }
  .token { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); padding: 20px 0; overflow-wrap: anywhere; }
  .token:first-child { border-top: none; padding-top: 8px; }
  .token:last-child { padding-bottom: 0; }
  .empty-state { color: var(--text-secondary); padding: 20px 0; line-height: 1.5; }
  .issued-token { padding: 16px; border: 1px solid var(--accent); border-radius: 8px; }
  .issued-token pre { margin-top: 12px; }
  @media (max-width: 720px) {
    .token-layout { grid-template-columns: minmax(0, 1fr); }
    .card { padding: 24px; }
  }
</style>
</head>
<body>${body}</body>
</html>`;
}

export function renderAgentApproval(input: {
  userCode: string;
  name?: string;
  status: "pending" | "approved" | "denied" | "consumed" | "invalid";
}): string {
  if (input.status === "approved") {
    return renderPage(
      `<div class="card"><p class="eyebrow">Access approved</p><h1 class="title">Connecting your agent</h1><p role="status">Waiting for your CLI to finish signing in.</p><p class="sub">This page updates automatically. Return to your terminal to check its progress.</p></div>`,
      true,
    );
  }
  if (input.status !== "pending") {
    const message =
      input.status === "consumed"
        ? "Approved. Return to your terminal; the CLI will finish signing in automatically."
        : input.status === "denied"
          ? "Request denied. The CLI will not receive access."
          : "This request expired or is unavailable. Start login again in your terminal.";
    return renderPage(
      `<div class="card"><h1 class="title">Agent access</h1><p role="status">${message}</p><a class="app-link" href="/tokens">Manage agent access</a></div>`,
    );
  }
  return renderPage(`<div class="card">
    <p class="eyebrow">Approve agent access</p>
    <h1 class="title">${escapeHtml(input.name ?? "Shedflare CLI")}</h1>
    <p class="sub">This name was supplied by the requesting CLI. Approve only if you started this login.</p>
    <p>Check that this code matches your terminal:</p><pre>${escapeHtml(input.userCode)}</pre>
    <p class="sub">Allows reading Cloudflare Worker names and deployment history. It cannot access app data or change resources.</p>
    <form method="post" action="/agent/authorize">
      <input type="hidden" name="userCode" value="${escapeHtml(input.userCode)}" />
      <label>Access expires in days <input name="days" type="number" required min="1" max="90" value="30" /></label>
      <button class="btn" type="submit" name="decision" value="approve">Approve</button>
      <button class="btn btn-danger" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
    </form>
    <p class="sub">You can revoke access from Agent tokens at any time.</p>
  </div>`);
}
