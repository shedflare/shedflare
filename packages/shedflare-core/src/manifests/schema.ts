import {
  array,
  boolean,
  literal,
  looseObject,
  minLength,
  optional,
  picklist,
  pipe,
  record,
  regex,
  strictObject,
  string,
  variant,
} from "valibot";

const AppIdSchema = pipe(string(), minLength(1), regex(/^[a-z0-9][a-z0-9-]*$/));
const EnvNameSchema = pipe(string(), regex(/^[A-Z][A-Z0-9_]*$/));
const HostLabelSchema = pipe(string(), minLength(1), regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/));

export const VarDefinitionSchema = strictObject({
  from: picklist(["url", "appUrl", "ownerEmail", "user", "appId", "computed"]),
  description: pipe(string(), minLength(1)),
  app: optional(AppIdSchema),
  default: optional(string()),
});

export const SecretDefinitionSchema = strictObject({
  description: pipe(string(), minLength(1)),
  required: boolean(),
  source: optional(picklist(["operator", "generated"]), "operator"),
});

const LegacyResourceFields = {
  binding: EnvNameSchema,
  name: optional(pipe(string(), minLength(1))),
  idField: optional(EnvNameSchema),
};

export const ResourceDescriptorSchema = variant("type", [
  strictObject({ type: literal("service"), binding: EnvNameSchema, app: AppIdSchema }),
  strictObject({ type: literal("kv"), ...LegacyResourceFields }),
  strictObject({ type: literal("d1"), ...LegacyResourceFields }),
  strictObject({ type: literal("r2"), ...LegacyResourceFields }),
  strictObject({ type: literal("durable_object"), ...LegacyResourceFields }),
  strictObject({
    type: literal("browser"),
    binding: EnvNameSchema,
    manualEnable: optional(boolean()),
  }),
]);

export const AppManifestSchema = looseObject({
  $schema: optional(string()),
  id: AppIdSchema,
  name: pipe(string(), minLength(1)),
  description: pipe(string(), minLength(1)),
  lifecycle: picklist(["beta", "experimental"]),
  category: picklist([
    "platform",
    "productivity",
    "files",
    "finance",
    "knowledge",
    "media",
    "developer",
  ]),
  dataSensitivity: picklist(["low", "personal", "high"]),
  dependsOn: optional(array(AppIdSchema)),
  defaultSubdomain: HostLabelSchema,
  vars: optional(record(EnvNameSchema, VarDefinitionSchema)),
  secrets: optional(record(EnvNameSchema, SecretDefinitionSchema)),
  resources: optional(array(ResourceDescriptorSchema)),
});
