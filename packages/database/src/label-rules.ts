import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type LabelRule = {
  key: string;
  label: string;
  enabled: boolean;
};

/** The analysis fields a rule key can address, e.g. `severity:S1`. */
export const LABEL_RULE_PREFIXES = [
  "category",
  "severity",
  "priority",
  "quality",
] as const;

/** 默认常用标签规则（首次进入标签配置为空时自动填充，用户可改可删）。 */
export const DEFAULT_LABEL_RULES = [
  { key: "category:bug", label: "bug" },
  { key: "category:security", label: "security" },
  { key: "category:performance", label: "performance" },
  { key: "category:dependency", label: "dependency" },
  { key: "category:documentation", label: "documentation" },
  { key: "category:testing", label: "testing" },
  { key: "category:refactor", label: "refactor" },
  { key: "category:enhancement", label: "enhancement" },
  { key: "severity:S1", label: "critical" },
  { key: "severity:S2", label: "major" },
  { key: "severity:S3", label: "minor" },
] as const;

/** 写入默认标签规则（幂等，仅在表为空时调用）。 */
export async function seedDefaultLabelRules(db: Database): Promise<void> {
  for (const rule of DEFAULT_LABEL_RULES) {
    await upsertLabelRule(db, {
      key: rule.key,
      label: rule.label,
      enabled: true,
    });
  }
}

export async function listLabelRules(db: Database): Promise<LabelRule[]> {
  const rows = await db
    .select({
      key: schema.labelRules.key,
      label: schema.labelRules.label,
      enabled: schema.labelRules.enabled,
    })
    .from(schema.labelRules)
    .orderBy(asc(schema.labelRules.key));
  return rows;
}

/** Upserts a rule keyed on `key`; an empty `label` deletes the rule. */
export async function upsertLabelRule(
  db: Database,
  input: { key: string; label: string; enabled: boolean },
): Promise<void> {
  if (input.key.trim().length === 0) throw new Error("label rule key is empty");
  if (input.label.trim().length === 0) {
    await db.delete(schema.labelRules).where(eq(schema.labelRules.key, input.key));
    return;
  }
  await db
    .insert(schema.labelRules)
    .values({
      key: input.key.trim(),
      label: input.label.trim(),
      enabled: input.enabled,
    })
    .onConflictDoUpdate({
      target: schema.labelRules.key,
      set: {
        label: input.label.trim(),
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    });
}

export async function deleteLabelRule(db: Database, key: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.labelRules)
    .where(and(eq(schema.labelRules.key, key)))
    .returning({ id: schema.labelRules.id });
  return deleted.length > 0;
}

export type AnalysisFields = {
  category: string;
  severity: string;
  priority: string;
  quality: string;
};

/**
 * Returns the enabled rule labels whose key matches an analysis field value,
 * e.g. an analysis with severity `S1` and a rule `severity:S1` → its label.
 * Deduplicated, order follows the rule listing order.
 */
export function labelsForAnalysis(
  analysis: AnalysisFields,
  rules: readonly LabelRule[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const candidates = [
    `category:${analysis.category}`,
    `severity:${analysis.severity}`,
    `priority:${analysis.priority}`,
    `quality:${analysis.quality}`,
  ];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!candidates.includes(rule.key)) continue;
    const label = rule.label.trim();
    if (label.length === 0 || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
}
