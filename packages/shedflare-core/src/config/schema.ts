import {
  boolean,
  literal,
  nullable,
  optional,
  pipe,
  record,
  regex,
  strictObject,
  string,
} from "valibot";

export const AppIdSchema = pipe(string(), regex(/^[a-z0-9][a-z0-9-]*$/));
export const EnvNameSchema = pipe(string(), regex(/^[A-Z][A-Z0-9_]*$/));
export const DomainSchema = pipe(
  string(),
  regex(/^(?!https?:\/\/)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
);
export const EmailSchema = pipe(string(), regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/));
export const SubdomainSchema = pipe(string(), regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/));

const VarsSchema = record(EnvNameSchema, string());
const LegacyProductionStageSchema = pipe(string(), regex(/^(?!prod$|e2e[-_])[a-z0-9][a-z0-9_-]*$/));

export const LegacyAppSelectionSchema = strictObject({
  enabled: optional(boolean()),
  subdomain: SubdomainSchema,
});

export const AppSelectionSchema = strictObject({
  subdomain: optional(SubdomainSchema),
  vars: optional(VarsSchema),
  productionAliases: optional(record(LegacyProductionStageSchema, SubdomainSchema)),
});

export const ShedflareConfigV1Schema = strictObject({
  $schema: optional(string()),
  domain: DomainSchema,
  ownerEmail: EmailSchema,
  apps: record(AppIdSchema, LegacyAppSelectionSchema),
  vars: optional(record(AppIdSchema, VarsSchema)),
  resources: optional(record(AppIdSchema, record(string(), string()))),
});

export const ShedflareConfigV2Schema = strictObject({
  $schema: optional(string()),
  configVersion: literal(2),
  domain: DomainSchema,
  ownerEmail: EmailSchema,
  apps: record(AppIdSchema, AppSelectionSchema),
});

export const AppSelectionPatchSchema = strictObject({
  subdomain: optional(nullable(SubdomainSchema)),
  vars: optional(nullable(record(EnvNameSchema, nullable(string())))),
  productionAliases: optional(
    nullable(record(LegacyProductionStageSchema, nullable(SubdomainSchema))),
  ),
});

export const ConfigPatchSchema = strictObject({
  domain: optional(DomainSchema),
  ownerEmail: optional(EmailSchema),
  apps: optional(record(AppIdSchema, nullable(AppSelectionPatchSchema))),
});
