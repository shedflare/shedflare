// Client-safe auth helpers. This module is imported into browser bundles, so it
// must NOT pull in server-only dependencies (Worker bindings, session storage, etc.). It is also
// part of a package typechecked without the DOM lib, so `document` is reached
// through a narrowly-typed globalThis accessor rather than the ambient global.

/**
 * Non-HttpOnly cookie carrying the signed-in user's email. Written by the
 * server whenever a session is confirmed (see `consumer.ts`), it lets the
 * client paint the authenticated UI optimistically before `/api/session`
 * resolves. It is a hint, never an authority — the server probe always wins.
 */
export const AUTH_HINT_COOKIE = "auth_hint";

type DocumentLike = { cookie: string };

function getDocument(): DocumentLike | undefined {
  // SAFETY: this optional structural view only reads the cross-runtime document cookie API.
  return (globalThis as { document?: DocumentLike }).document;
}

/** Reads the auth hint cookie. Returns "" when absent, malformed, or off-DOM. */
export function readAuthHint(): string {
  const doc = getDocument();
  if (!doc) return "";
  const match = doc.cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_HINT_COOKIE}=([^;]+)`));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

/**
 * Clears the hint client-side. Call this the moment a probe contradicts it
 * (e.g. `/api/session` returns 401) so a stale hint can't paint the wrong UI
 * on a subsequent load before the server clears it.
 */
export function clearAuthHint(): void {
  const doc = getDocument();
  if (!doc) return;
  doc.cookie = `${AUTH_HINT_COOKIE}=; Max-Age=0; Path=/`;
}
