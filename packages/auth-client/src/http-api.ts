import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { createAuthHandlers, type AuthEnv, type Session } from "./consumer";

export interface HandlerContext<Params = unknown, Payload = unknown> {
  params?: Params;
  payload?: Payload;
}

export function createHttpApiAuth(env: AuthEnv) {
  const auth = createAuthHandlers(env);

  function requireSession(httpReq: HttpServerRequest.HttpServerRequest) {
    return Effect.gen(function* () {
      const webReq = yield* HttpServerRequest.toWeb(httpReq);
      return yield* Effect.tryPromise(() => auth.requireSession(webReq));
    });
  }

  function createProtectedHandler<Params = unknown, Payload = unknown, A = unknown>(
    fn: (webReq: Request, session: Session, ctx: HandlerContext<Params, Payload>) => Promise<A>,
  ) {
    return (ctx: {
      request: HttpServerRequest.HttpServerRequest;
      params?: Params;
      payload?: Payload;
    }) =>
      Effect.gen(function* () {
        const webReq = yield* HttpServerRequest.toWeb(ctx.request);
        const session = yield* requireSession(ctx.request);
        return yield* Effect.tryPromise(() =>
          fn(webReq, session, { params: ctx.params, payload: ctx.payload }),
        );
      }).pipe(
        Effect.catch((error) => {
          const actual = error instanceof Error && "cause" in error ? error.cause : error;
          if (actual instanceof Response) {
            return Effect.succeed(HttpServerResponse.fromWeb(actual));
          }
          return Effect.succeed(
            HttpServerResponse.fromWeb(new Response("Internal error", { status: 500 })),
          );
        }),
      );
  }

  return {
    loginRedirect: auth.loginRedirect,
    autoLoginRedirect: auth.autoLoginRedirect,
    handleCallback: auth.handleCallback,
    logout: auth.logout,
    sessionEndpoint: auth.sessionEndpoint,
    gateHtml: auth.gateHtml,
    requireSession,
    createProtectedHandler,
    withCookies: auth.withCookies,
    getCookie: auth.getCookie,
    isDocumentRequest: auth.isDocumentRequest,
    validateReturnTo: auth.validateReturnTo,
    serializeCookie: auth.serializeCookie,
  } as const;
}

export type HttpApiAuth = ReturnType<typeof createHttpApiAuth>;
