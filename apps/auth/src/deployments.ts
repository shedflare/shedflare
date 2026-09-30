import { array, boolean, object, parse, safeParse } from "valibot";
import {
  DeploymentSchema,
  WorkerNameSchema,
  WorkerSchema,
} from "@shedflare/auth-client/deployments";
const WorkersResponseSchema = object({ success: boolean(), result: array(WorkerSchema) });
const DeploymentsResponseSchema = object({
  success: boolean(),
  result: object({ deployments: array(DeploymentSchema) }),
});

export type DeploymentEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string;
  DEPLOYMENTS_CF_API_TOKEN?: string;
};

function unavailable(message: string) {
  return Response.json({ error: message }, { status: 503, headers: { "retry-after": "5" } });
}

export async function inspectDeployments(request: Request, env: DeploymentEnv): Promise<Response> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.DEPLOYMENTS_CF_API_TOKEN)
    return unavailable("Deployment inspection is not configured.");
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID))
    return unavailable("Deployment inspection is not configured.");
  const worker = new URL(request.url).searchParams.get("worker");
  if (worker !== null && !safeParse(WorkerNameSchema, worker).success)
    return Response.json({ error: "Invalid Worker name." }, { status: 400 });
  // A fixed, GET-only allowlist. Never proxy arbitrary paths, bindings, source,
  // credentials, database contents, or write operations to Cloudflare.
  const path = worker ? `/${encodeURIComponent(worker)}/deployments` : "";
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts${path}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${env.DEPLOYMENTS_CF_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 && worker)
      return Response.json({ error: "Worker not found." }, { status: 404 });
    if (!response.ok) return unavailable("Cloudflare deployment inspection failed. Please retry.");
    const body: unknown = await response.json();
    if (worker) {
      const parsed = parse(DeploymentsResponseSchema, body);
      if (!parsed.success)
        return unavailable("Cloudflare deployment inspection failed. Please retry.");
      return Response.json({ worker, deployments: parsed.result.deployments });
    }
    const parsed = parse(WorkersResponseSchema, body);
    if (!parsed.success)
      return unavailable("Cloudflare deployment inspection failed. Please retry.");
    return Response.json({ workers: parsed.result });
  } catch {
    return unavailable("Cloudflare deployment inspection failed. Please retry.");
  }
}
