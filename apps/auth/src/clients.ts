import { array, parse, record, string } from "valibot";
import { isToken } from "@shedflare/auth-client/contract";

export function allowedClients(json: string) {
  return parse(record(string(), array(string())), JSON.parse(json));
}

export function isAllowedClient(json: string, clientId: string, origin: string): boolean {
  if (!/^shedflare-[a-z0-9][a-z0-9-]*$/.test(clientId)) return false;
  const clients = allowedClients(json);
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      url.origin === origin &&
      (clients[clientId]?.includes(origin) ?? false)
    );
  } catch {
    return false;
  }
}

export function authorizationInput(request: Request, clients: string) {
  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  let origin: string;
  try {
    origin = new URL(redirectUri).origin;
  } catch {
    return null;
  }
  if (
    !isAllowedClient(clients, clientId, origin) ||
    redirectUri !== `${origin}/api/auth/callback` ||
    !isToken(state) ||
    !isToken(challenge)
  )
    return null;
  return { clientId, origin, appState: state, challenge };
}
