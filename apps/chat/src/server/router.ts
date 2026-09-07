import { createHttpApiWebHandler } from "@shedflare/alchemy";
import { createAuthHandlers } from "@shedflare/auth-client/consumer";
import { setRuntimeEnv } from "#/runtime";
import { chatApi } from "./definitions";
import { createBootstrapGroup, createModelsGroup, createUploadsGroup } from "./impl/all";
import {
  handleChatBackup,
  handleChatBackupDownload,
  handleChatBackupRestore,
} from "../api/backups";
import { handleChat } from "../api/chat";
import { handleSync } from "../api/sync";
import { handleUploadBlobPut, handleUploadBlobGet } from "../api/uploads-blob";
import { BUILD_INFO } from "../lib/build-info";
import { createStructuredLogger } from "#/effect";

const logger = createStructuredLogger("chat-worker");

type WorkerResponseInit = ResponseInit & { webSocket?: WebSocket };
export const createVersionedResponseInit = (response: Response): WorkerResponseInit => {
  const init: WorkerResponseInit = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  // SAFETY: Cloudflare's WebSocket upgrade Response carries its socket in this runtime extension.
  const webSocket = (response as Response & { readonly webSocket?: WebSocket }).webSocket;
  if (webSocket) init.webSocket = webSocket;
  return init;
};

const withVersionHeader = (response: Response) => {
  const wrapped = new Response(response.body, createVersionedResponseInit(response));
  wrapped.headers.set("x-shedflare-version", BUILD_INFO.version);
  return wrapped;
};

type RawEnv = {
  APP_PUBLIC_URL: string;
  AUTH_ISSUER_URL?: string;
  AUTH_CLIENT_ID?: string;
  OWNER_EMAIL: string;
  OPENCODE_GO_API_KEY: string;
  UPLOAD_TOKEN_SECRET: string;
  EXA_API_KEY?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  UPLOADS: R2Bucket;
  SYNC_ENGINE: DurableObjectNamespace;
};

export function createRouter(env: RawEnv) {
  const auth = createAuthHandlers({
    AUTH_ISSUER_URL: env.AUTH_ISSUER_URL ?? env.APP_PUBLIC_URL,
    AUTH_CLIENT_ID: env.AUTH_CLIENT_ID ?? "shedflare-chat",
    APP_PUBLIC_URL: env.APP_PUBLIC_URL,
    OWNER_EMAIL: env.OWNER_EMAIL,
  });

  const wh = createHttpApiWebHandler(chatApi, [
    createBootstrapGroup(),
    createModelsGroup(),
    createUploadsGroup(),
  ]);

  return {
    async fetch(request: Request): Promise<Response> {
      try {
        setRuntimeEnv(env);

        const url = new URL(request.url);
        const { pathname } = url;
        const method = request.method;
        const appHost = new URL(env.APP_PUBLIC_URL).hostname;
        const localHost =
          url.hostname === "localhost" ||
          url.hostname === "127.0.0.1" ||
          url.hostname === "0.0.0.0";

        if (!localHost && url.hostname !== appHost) {
          return withVersionHeader(new Response("Not found", { status: 404 }));
        }

        if (pathname.startsWith("/api/")) {
          if (pathname === "/api/auth/login" && method === "GET") {
            const startedAt = Date.now();
            const returnTo = auth.validateReturnTo(url.searchParams.get("returnTo"));
            const response =
              url.searchParams.get("auto") === "1"
                ? await auth.autoLoginRedirect(returnTo)
                : await auth.loginRedirect(returnTo);
            logger.log("auth_login_redirect_created", { durationMs: Date.now() - startedAt });
            return withVersionHeader(response);
          }

          if (pathname === "/api/auth/callback" && method === "GET") {
            if (url.searchParams.get("error") === "no_session") {
              const redirectUrl = new URL("/", url.origin);
              redirectUrl.searchParams.set("error", "no_session");
              const headers = new Headers({ Location: redirectUrl.toString() });
              headers.append("Set-Cookie", auth.serializeCookie("auth_state", "", { maxAge: 0 }));
              return withVersionHeader(new Response(null, { status: 302, headers }));
            }
            const startedAt = Date.now();
            const response = await auth.handleCallback(request);
            logger.log("auth_callback_completed", { durationMs: Date.now() - startedAt });
            return withVersionHeader(response);
          }

          if (pathname === "/api/auth/logout" && method === "POST") {
            return withVersionHeader(auth.logout());
          }

          if (pathname === "/api/session" && method === "GET") {
            return withVersionHeader(await auth.sessionEndpoint(request));
          }

          if (pathname === "/api/chat" || pathname.startsWith("/api/chat")) {
            return withVersionHeader(await handleChat(request));
          }

          if (pathname.startsWith("/api/sync/")) {
            return withVersionHeader(await handleSync(request));
          }

          if (pathname === "/api/backups/chat") {
            return withVersionHeader(await handleChatBackup(request));
          }

          if (pathname === "/api/backups/chat/download") {
            return withVersionHeader(await handleChatBackupDownload(request));
          }

          if (pathname === "/api/backups/chat/restore") {
            return withVersionHeader(await handleChatBackupRestore(request));
          }

          if (pathname.startsWith("/api/uploads/blob/")) {
            if (method === "PUT") return withVersionHeader(await handleUploadBlobPut(request));
            if (method === "GET") return withVersionHeader(await handleUploadBlobGet(request));
            return wh.handler(request);
          }

          return wh.handler(request);
        }

        const gate = await auth.gateHtml(request, { publicPaths: ["/forbidden"] });
        if (gate.kind === "redirect") return withVersionHeader(gate.response);

        let assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status === 404 && auth.isDocumentRequest(request)) {
          assetResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
        }

        const headers = new Headers(assetResponse.headers);
        for (const cookie of gate.setCookies) headers.append("Set-Cookie", cookie);
        headers.set("cache-control", "public, max-age=31536000, immutable");
        headers.set("x-shedflare-version", BUILD_INFO.version);
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers,
          webSocket: assetResponse.webSocket,
        });
      } catch (error) {
        if (error instanceof Response) return withVersionHeader(error);
        logger.log(
          "unhandled_error",
          { error: error instanceof Error ? error.message : String(error) },
          "error",
        );
        return withVersionHeader(new Response("Internal Server Error", { status: 500 }));
      }
    },
  };
}
