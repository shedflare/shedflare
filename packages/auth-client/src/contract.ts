import { number, object, string, type InferOutput } from "valibot";

export const SessionSchema = object({ email: string(), expiresAt: number() });
export type Session = InferOutput<typeof SessionSchema>;

export const ClientSchema = object({ clientId: string(), origin: string() });
export const SessionRequestSchema = object({ ...ClientSchema.entries, token: string() });
export const ExchangeRequestSchema = object({
  ...ClientSchema.entries,
  code: string(),
  verifier: string(),
});
export type SessionRequest = InferOutput<typeof SessionRequestSchema>;
export type ExchangeRequest = InferOutput<typeof ExchangeRequestSchema>;
export type SessionResult = { kind: "authenticated"; session: Session } | { kind: "invalid" };
export type ExchangeResult =
  | { kind: "authenticated"; session: Session; token: string }
  | { kind: "invalid" };

/** Implemented by the Auth Worker. No application issues its own credentials. */
export interface AuthRpc {
  validateSession(input: SessionRequest): Promise<SessionResult>;
  exchangeCode(input: ExchangeRequest): Promise<ExchangeResult>;
  revokeSession(input: SessionRequest): Promise<void>;
}

export const SESSION_COOKIE = "__Host-shedflare_session";
export const STATE_COOKIE = "__Host-shedflare_login";
export const LOGIN_TTL_SECONDS = 600;

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Token hashes are also S256 proofs for the browser's single-use handoff. */
export async function hashToken(token: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  );
}

export function isToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
