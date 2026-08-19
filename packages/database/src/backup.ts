import { asc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export const BACKUP_VERSION = "apertureprism-backup/v1";

/**
 * Setting keys whose values are secrets. A backup export never includes the
 * value (only `hasValue`), so credentials never leave the process; on import
 * these keys are skipped (they come from env or the WebUI settings form).
 */
const SECRET_SETTING_KEYS = new Set(["webui_api_token", "github_webhook_secret"]);
/** Non-secret settings that an import may restore. */
const IMPORTABLE_SETTING_KEYS = new Set(["github_webhook_enabled", "log_level"]);
/** Roles the restore path may re-create (avoids importing arbitrary rows). */
const IMPORTABLE_POLICY_ROLES = new Set([
  "issue_analysis",
  "pr_review",
  "duplicate_judgment",
]);

type Database = PostgresJsDatabase<typeof schema>;

export type BackupSetting = {
  key: string;
  value: string | null;
  hasValue: boolean;
};

export type BackupPolicy = {
  role: string;
  version: string;
  candidates: unknown;
};

export type BackupSnapshot = {
  version: string;
  exportedAt: string;
  settings: BackupSetting[];
  policies: BackupPolicy[];
  providers: string[];
};

export type BackupApplyResult = {
  settings: number;
  policies: number;
  skippedSecrets: string[];
  skippedProviders: string[];
};

/**
 * Captures the runtime configuration: hot-overridable settings (secrets
 * masked), model role policies and provider account names. This is a
 * configuration backup — provider credentials stay in the database and are
 * never exported.
 */
export async function buildBackupSnapshot(db: Database): Promise<BackupSnapshot> {
  const [settings, policies, providers] = await Promise.all([
    db
      .select({ key: schema.systemSettings.key, value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .orderBy(asc(schema.systemSettings.key)),
    db
      .select({
        role: schema.modelRolePolicies.role,
        version: schema.modelRolePolicies.version,
        candidates: schema.modelRolePolicies.candidates,
      })
      .from(schema.modelRolePolicies)
      .orderBy(asc(schema.modelRolePolicies.role)),
    db
      .select({ name: schema.providerAccounts.name })
      .from(schema.providerAccounts)
      .orderBy(asc(schema.providerAccounts.name)),
  ]);
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: settings.map((row) => ({
      key: row.key,
      value: SECRET_SETTING_KEYS.has(row.key) ? null : row.value,
      hasValue: row.value.trim().length > 0,
    })),
    policies,
    providers: providers.map((row) => row.name),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBackupPolicy(value: unknown): value is BackupPolicy {
  if (!isRecord(value)) return false;
  if (typeof value.role !== "string" || value.role.length === 0) return false;
  if (typeof value.version !== "string" || value.version.length === 0) return false;
  return Array.isArray(value.candidates);
}

/**
 * Restores a previously exported snapshot. Only non-secret settings and the
 * known model role policies are applied; provider accounts are informational
 * (their encrypted credentials live in the database and are never restored
 * from a backup). Returns a per-section count plus what was skipped.
 */
export async function applyBackupSnapshot(
  db: Database,
  snapshot: unknown,
): Promise<BackupApplyResult> {
  if (!isRecord(snapshot)) throw new Error("backup snapshot must be an object");
  if (snapshot.version !== BACKUP_VERSION)
    throw new Error(`unsupported backup version: ${String(snapshot.version)}`);
  if (!Array.isArray(snapshot.settings) || !Array.isArray(snapshot.policies))
    throw new Error("backup snapshot is missing settings/policies arrays");

  const skippedSecrets: string[] = [];
  let settingsApplied = 0;
  for (const entry of snapshot.settings) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    if (SECRET_SETTING_KEYS.has(entry.key)) {
      skippedSecrets.push(entry.key);
      continue;
    }
    if (!IMPORTABLE_SETTING_KEYS.has(entry.key)) continue;
    const value = typeof entry.value === "string" ? entry.value : "";
    await db
      .insert(schema.systemSettings)
      .values({ key: entry.key, value })
      .onConflictDoUpdate({
        target: schema.systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
    settingsApplied += 1;
  }

  const policies = snapshot.policies.filter(isBackupPolicy);
  const imported = policies.filter((policy) =>
    IMPORTABLE_POLICY_ROLES.has(policy.role),
  );
  await db.delete(schema.modelRolePolicies);
  for (const policy of imported) {
    await db.insert(schema.modelRolePolicies).values({
      role: policy.role,
      version: policy.version,
      candidates: policy.candidates,
    });
  }

  const providers = Array.isArray(snapshot.providers)
    ? snapshot.providers.filter((name): name is string => typeof name === "string")
    : [];

  return {
    settings: settingsApplied,
    policies: imported.length,
    skippedSecrets,
    skippedProviders: providers,
  };
}
