// Type definitions for Cloudflare Worker bindings
// Bindings are owned by alchemy.run.ts.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MONEY_DB: D1Database;
  UPLOADS: R2Bucket;
  APP_PUBLIC_URL: string;
  AUTH: import("@shedflare/auth-client/contract").AuthRpc;
  AUTH_URL: string;
  AUTH_CLIENT_ID: string;
  OWNER_EMAIL: string;
  DEV_AUTH_EMAIL?: string;
}
