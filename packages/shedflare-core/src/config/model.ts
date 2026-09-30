export interface LegacyAppSelection {
  readonly enabled?: boolean;
  readonly subdomain: string;
}

export interface AppSelection {
  readonly subdomain?: string;
  readonly vars?: Readonly<Record<string, string>>;
  /** Existing production consumers whose Alchemy ownership uses a legacy stage. */
  readonly productionAliases?: Readonly<Record<string, string>>;
}

export interface ShedflareConfigV1 {
  readonly $schema?: string;
  readonly configVersion: 1;
  readonly domain: string;
  readonly ownerEmail: string;
  readonly apps: Readonly<Record<string, LegacyAppSelection>>;
  readonly vars: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly resources: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface ShedflareConfigV2 {
  readonly $schema?: string;
  readonly configVersion: 2;
  readonly domain: string;
  readonly ownerEmail: string;
  readonly apps: Readonly<Record<string, AppSelection>>;
}

export type ShedflareConfig = ShedflareConfigV1 | ShedflareConfigV2;

export interface ResolvedAppConfig {
  readonly appId: string;
  readonly authStage: string;
  readonly domain: string;
  readonly configuredSubdomain: string;
  readonly stageSubdomain: string;
  readonly url: string;
  readonly ownerEmail: string;
  readonly vars: Readonly<Record<string, string>>;
}

export interface ConfigInspection {
  readonly configPath: string;
  readonly present: boolean;
  readonly config?: ShedflareConfig;
  readonly warnings: readonly string[];
}

export interface ConfigMigrationWarning {
  readonly code: "LEGACY_RESOURCES_PRESENT";
  readonly message: string;
}

export interface ConfigMigration {
  readonly sourcePath: string;
  readonly sourceText?: string;
  readonly oldVersion: 1 | 2;
  readonly config: ShedflareConfigV2;
  readonly warnings: readonly ConfigMigrationWarning[];
  readonly diff: string;
  readonly canWrite: boolean;
}

export interface AppSelectionPatch {
  readonly subdomain?: string | null;
  readonly vars?: Readonly<Record<string, string | null>> | null;
  readonly productionAliases?: Readonly<Record<string, string | null>> | null;
}

export interface ConfigPatch {
  readonly domain?: string;
  readonly ownerEmail?: string;
  readonly apps?: Readonly<Record<string, AppSelectionPatch | null>>;
}
