import type { InferOutput } from "valibot";
import type { ResourceDescriptorSchema } from "./schema.ts";

export type Lifecycle = "beta" | "experimental";

export type AppCategory =
  | "platform"
  | "productivity"
  | "files"
  | "finance"
  | "knowledge"
  | "media"
  | "developer";

export type DataSensitivity = "low" | "personal" | "high";

export type VarSource = "url" | "appUrl" | "ownerEmail" | "user" | "appId" | "computed";

export interface VarDefinition {
  readonly from: VarSource;
  readonly description: string;
  readonly app?: string;
  readonly default?: string;
}

export interface SecretDefinition {
  readonly description: string;
  readonly required: boolean;
  readonly source: "operator" | "generated";
}

export interface KvResourceDescriptor {
  readonly type: "kv";
  readonly binding: string;
  readonly name?: string;
  readonly idField?: string;
}

export interface D1ResourceDescriptor {
  readonly type: "d1";
  readonly binding: string;
  readonly name?: string;
  readonly idField?: string;
}

export interface R2ResourceDescriptor {
  readonly type: "r2";
  readonly binding: string;
  readonly name?: string;
  readonly idField?: string;
}

export interface DurableObjectResourceDescriptor {
  readonly type: "durable_object";
  readonly binding: string;
  readonly name?: string;
  readonly idField?: string;
}

export interface BrowserResourceDescriptor {
  readonly type: "browser";
  readonly binding: string;
  readonly manualEnable?: boolean;
}

export type ServiceResourceDescriptor = Extract<
  InferOutput<typeof ResourceDescriptorSchema>,
  { type: "service" }
>;

export type ResourceDescriptor =
  | ServiceResourceDescriptor
  | KvResourceDescriptor
  | D1ResourceDescriptor
  | R2ResourceDescriptor
  | DurableObjectResourceDescriptor
  | BrowserResourceDescriptor;

export interface AppManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly lifecycle: Lifecycle;
  readonly category: AppCategory;
  readonly dataSensitivity: DataSensitivity;
  readonly dependsOn: readonly string[];
  readonly defaultSubdomain: string;
  readonly vars: Readonly<Record<string, VarDefinition>>;
  readonly secrets: Readonly<Record<string, SecretDefinition>>;
  readonly resources: readonly ResourceDescriptor[];
}

export interface ManifestCatalog {
  readonly appIds: readonly string[];
  readonly manifests: ReadonlyMap<string, AppManifest>;
}
