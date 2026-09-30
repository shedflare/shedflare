import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parse, safeParse, type InferOutput } from "valibot";
import {
  AgentNameSchema,
  DeviceAuthorizationSchema,
  DevicePollErrorSchema,
  DeviceTokenSchema,
  type DeviceStartSchema,
  type DevicePollRequestSchema,
} from "@shedflare/auth-client/deployments";
import { AgentCliError } from "./agent-auth.js";

type DeviceRequestInput =
  | InferOutput<typeof DeviceStartSchema>
  | InferOutput<typeof DevicePollRequestSchema>;

async function request(
  authUrl: string,
  route: string,
  input: DeviceRequestInput,
  signal: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(new URL(route, authUrl), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  } catch {
    if (signal.aborted) throw new AgentCliError("cancelled", "Login cancelled.");
    throw new AgentCliError(
      "service_unavailable",
      "Auth service could not be reached securely. Please retry.",
    );
  }
  if (response.status === 404)
    throw new AgentCliError(
      "not_found",
      "Browser login is not available on this Auth service. Deploy the updated Auth version first.",
    );
  if (response.status === 429)
    throw new AgentCliError("rate_limited", "Too many login requests. Try again later.");
  if (response.status >= 500)
    throw new AgentCliError(
      "service_unavailable",
      "Auth service is temporarily unavailable. Please retry.",
    );
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(result.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { ok: response.ok, body };
  } catch {
    if (signal.aborted) throw new AgentCliError("cancelled", "Login cancelled.");
    throw new AgentCliError("invalid_response", "Auth returned an invalid browser login response.");
  }
}

export async function browserLogin(input: {
  authUrl: string;
  name?: string;
}): Promise<InferOutput<typeof DeviceTokenSchema>> {
  const name = safeParse(AgentNameSchema, input.name ?? `Shedflare CLI on ${hostname()}`);
  if (!name.success)
    throw new AgentCliError("invalid_input", "Use an agent name between 1 and 80 characters.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  try {
    const start = await request(
      input.authUrl,
      "/api/agent/device/start",
      { name: name.output },
      controller.signal,
    );
    let grant: InferOutput<typeof DeviceAuthorizationSchema>;
    try {
      if (!start.ok) throw new Error();
      grant = parse(DeviceAuthorizationSchema, start.body);
      const expected = new URL("/agent/authorize", input.authUrl);
      if (grant.verificationUri !== expected.href) throw new Error();
      expected.searchParams.set("user_code", grant.userCode);
      if (grant.verificationUriComplete !== expected.href) throw new Error();
    } catch {
      throw new AgentCliError("invalid_response", "Auth returned an invalid approval link.");
    }
    // Progress goes to stderr so --json stdout remains one final result. Neither
    // the polling secret nor the eventual credential is printed in any mode.
    console.error(
      `Open this link to approve agent access:\n${grant.verificationUriComplete}\n\nCheck code: ${grant.userCode}\nWaiting for approval (expires in ${Math.ceil(grant.expiresIn / 60)} minutes)…`,
    );
    const deadline = Date.now() + grant.expiresIn * 1000;
    let interval = grant.interval;
    while (Date.now() < deadline) {
      try {
        await delay(Math.min(interval * 1000, deadline - Date.now()), undefined, {
          signal: controller.signal,
        });
      } catch {
        throw new AgentCliError("cancelled", "Login cancelled.");
      }
      if (Date.now() >= deadline) break;
      let result: Awaited<ReturnType<typeof request>>;
      try {
        result = await request(
          input.authUrl,
          "/api/agent/device/poll",
          { deviceCode: grant.deviceCode },
          controller.signal,
        );
      } catch (error) {
        if (error instanceof AgentCliError && error.code === "service_unavailable") {
          interval = Math.min(interval * 2, 60);
          continue;
        }
        throw error;
      }
      if (result.ok) {
        const issued = safeParse(DeviceTokenSchema, result.body);
        if (!issued.success || issued.output.expiresAt <= Date.now())
          throw new AgentCliError("invalid_response", "Auth returned an invalid agent credential.");
        return issued.output;
      }
      const pending = safeParse(DevicePollErrorSchema, result.body);
      if (!pending.success)
        throw new AgentCliError("invalid_response", "Auth returned an invalid approval status.");
      if (pending.output.error === "access_denied")
        throw new AgentCliError("access_denied", "Agent access was denied in the browser.");
      if (pending.output.error === "expired_token") break;
      if (pending.output.error === "slow_down")
        interval = Math.max(interval + 5, pending.output.interval ?? 0);
    }
    throw new AgentCliError(
      "expired_request",
      "The approval request expired or was already used. Run auth login again.",
    );
  } finally {
    process.off("SIGINT", cancel);
  }
}
