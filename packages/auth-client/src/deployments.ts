import {
  array,
  literal,
  maxValue,
  maxLength,
  minLength,
  minValue,
  number,
  object,
  optional,
  picklist,
  pipe,
  regex,
  safeInteger,
  string,
  trim,
  variant,
} from "valibot";

export const AgentTokenSchema = pipe(string(), regex(/^sf_agent_[A-Za-z0-9_-]{43}$/));
export const AgentNameSchema = pipe(string(), trim(), minLength(1), maxLength(80));
export const AgentDaysSchema = pipe(number(), safeInteger(), minValue(1), maxValue(90));
export const DeviceCodeSchema = pipe(string(), regex(/^[A-Za-z0-9_-]{43}$/));
export const UserCodeSchema = pipe(string(), regex(/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/));
export const DeviceStartSchema = object({ name: AgentNameSchema });
export const DevicePollRequestSchema = object({ deviceCode: DeviceCodeSchema });
export const DeviceApprovalSchema = variant("decision", [
  object({ userCode: UserCodeSchema, decision: literal("approve"), days: AgentDaysSchema }),
  object({ userCode: UserCodeSchema, decision: literal("deny") }),
]);
export const DeviceAuthorizationSchema = object({
  deviceCode: DeviceCodeSchema,
  userCode: UserCodeSchema,
  verificationUri: string(),
  verificationUriComplete: string(),
  expiresIn: pipe(number(), safeInteger(), minValue(1), maxValue(600)),
  interval: pipe(number(), safeInteger(), minValue(1), maxValue(60)),
});
export const DevicePollErrorSchema = object({
  error: picklist(["authorization_pending", "slow_down", "access_denied", "expired_token"]),
  interval: optional(pipe(number(), safeInteger(), minValue(1), maxValue(600))),
});
export const WorkerNameSchema = pipe(string(), regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/));
export const AgentSessionSchema = object({
  name: string(),
  scope: literal("deployments:read"),
  expiresAt: pipe(number(), safeInteger(), minValue(1), maxValue(8_640_000_000_000_000)),
});
export const DeviceTokenSchema = object({ token: AgentTokenSchema, ...AgentSessionSchema.entries });
export const WorkerSchema = object({
  id: string(),
  created_on: optional(string()),
  modified_on: optional(string()),
});
export const DeploymentSchema = object({
  id: string(),
  created_on: string(),
  source: optional(string()),
  strategy: optional(string()),
  versions: array(object({ version_id: string(), percentage: number() })),
});
export const WorkerInventorySchema = object({ workers: array(WorkerSchema) });
export const DeploymentHistorySchema = object({
  worker: WorkerNameSchema,
  deployments: array(DeploymentSchema),
});
