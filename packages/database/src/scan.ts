import { and, asc, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type ScanConfig = {
  repositoryId: string;
  enabled: boolean;
  intervalMinutes: number;
  maxIssues: number;
  maxPrs: number;
  autoAnalyzeIssues: boolean;
  autoAnalyzePrs: boolean;
  createTrackingIssues: boolean;
  updatedAt: Date | null;
};

/** Defaults applied when a repository has no explicit scan_config row. */
export const DEFAULT_SCAN_CONFIG = {
  enabled: true,
  intervalMinutes: 1440,
  maxIssues: 50,
  maxPrs: 20,
  autoAnalyzeIssues: true,
  autoAnalyzePrs: true,
  createTrackingIssues: false,
} as const;

export type ScanRun = {
  id: string;
  repositoryId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: "running" | "completed" | "failed";
  trigger: "scheduled" | "manual";
  scannedIssues: number;
  scannedPrs: number;
  createdIssueTasks: number;
  createdPrTasks: number;
  createdTrackingIssues: number;
  skipped: number;
  error: string | null;
};

export type ScanRunResult = Omit<
  ScanRun,
  "id" | "repositoryId" | "startedAt" | "finishedAt" | "status" | "trigger" | "error"
>;

/** Effective per-repository config: explicit row merged over defaults. */
export async function getScanConfig(
  db: Database,
  repositoryId: string,
): Promise<ScanConfig> {
  const rows = await db
    .select()
    .from(schema.scanConfigs)
    .where(eq(schema.scanConfigs.repositoryId, repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row)
    return {
      repositoryId,
      ...DEFAULT_SCAN_CONFIG,
      updatedAt: null,
    };
  return {
    repositoryId: row.repositoryId,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    maxIssues: row.maxIssues,
    maxPrs: row.maxPrs,
    autoAnalyzeIssues: row.autoAnalyzeIssues,
    autoAnalyzePrs: row.autoAnalyzePrs,
    createTrackingIssues: row.createTrackingIssues,
    updatedAt: row.updatedAt,
  };
}

/** Upserts a repository scan config; only the provided fields are changed. */
export async function upsertScanConfig(
  db: Database,
  input: Partial<ScanConfig> & { repositoryId: string },
): Promise<void> {
  const base = input.repositoryId;
  const current = await getScanConfig(db, base);
  const merged = { ...current, ...input, repositoryId: base };
  await db
    .insert(schema.scanConfigs)
    .values({
      repositoryId: merged.repositoryId,
      enabled: merged.enabled,
      intervalMinutes: merged.intervalMinutes,
      maxIssues: merged.maxIssues,
      maxPrs: merged.maxPrs,
      autoAnalyzeIssues: merged.autoAnalyzeIssues,
      autoAnalyzePrs: merged.autoAnalyzePrs,
      createTrackingIssues: merged.createTrackingIssues,
    })
    .onConflictDoUpdate({
      target: schema.scanConfigs.repositoryId,
      set: {
        enabled: merged.enabled,
        intervalMinutes: merged.intervalMinutes,
        maxIssues: merged.maxIssues,
        maxPrs: merged.maxPrs,
        autoAnalyzeIssues: merged.autoAnalyzeIssues,
        autoAnalyzePrs: merged.autoAnalyzePrs,
        createTrackingIssues: merged.createTrackingIssues,
        updatedAt: new Date(),
      },
    });
}

/** All scan configs (used by the WebUI scan page to render per-repo rows). */
export async function listScanConfigs(db: Database): Promise<ScanConfig[]> {
  const rows = await db
    .select()
    .from(schema.scanConfigs)
    .orderBy(asc(schema.scanConfigs.repositoryId));
  return rows.map((row) => ({
    repositoryId: row.repositoryId,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    maxIssues: row.maxIssues,
    maxPrs: row.maxPrs,
    autoAnalyzeIssues: row.autoAnalyzeIssues,
    autoAnalyzePrs: row.autoAnalyzePrs,
    createTrackingIssues: row.createTrackingIssues,
    updatedAt: row.updatedAt,
  }));
}

export async function insertScanRun(
  db: Database,
  input: { repositoryId: string; trigger: "scheduled" | "manual" },
): Promise<{ id: string; startedAt: Date }> {
  const rows = await db
    .insert(schema.scanRuns)
    .values({
      repositoryId: input.repositoryId,
      trigger: input.trigger,
      status: "running",
    })
    .returning({ id: schema.scanRuns.id, startedAt: schema.scanRuns.startedAt });
  const row = rows[0];
  if (!row) throw new Error("scan run insert returned no row");
  return { id: row.id, startedAt: row.startedAt };
}

export async function finishScanRun(
  db: Database,
  id: string,
  result: ScanRunResult,
): Promise<void> {
  await db
    .update(schema.scanRuns)
    .set({
      status: "completed",
      finishedAt: new Date(),
      scannedIssues: result.scannedIssues,
      scannedPrs: result.scannedPrs,
      createdIssueTasks: result.createdIssueTasks,
      createdPrTasks: result.createdPrTasks,
      createdTrackingIssues: result.createdTrackingIssues,
      skipped: result.skipped,
    })
    .where(eq(schema.scanRuns.id, id));
}

export async function failScanRun(
  db: Database,
  id: string,
  error: string,
): Promise<void> {
  await db
    .update(schema.scanRuns)
    .set({ status: "failed", finishedAt: new Date(), error: error.slice(0, 500) })
    .where(eq(schema.scanRuns.id, id));
}

/** Newest completed/latest scan start time for a repository (interval gating). */
export async function latestScanRunAt(
  db: Database,
  repositoryId: string,
): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: schema.scanRuns.startedAt })
    .from(schema.scanRuns)
    .where(eq(schema.scanRuns.repositoryId, repositoryId))
    .orderBy(desc(schema.scanRuns.startedAt))
    .limit(1);
  return rows[0]?.startedAt ?? null;
}

/** Scan run history, newest first (WebUI scan history list). */
export async function listScanRuns(
  db: Database,
  opts: { limit?: number; offset?: number } = {},
): Promise<ScanRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select()
    .from(schema.scanRuns)
    .orderBy(desc(schema.scanRuns.startedAt), desc(schema.scanRuns.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({
    id: row.id,
    repositoryId: row.repositoryId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    status: row.status as ScanRun["status"],
    trigger: row.trigger as ScanRun["trigger"],
    scannedIssues: row.scannedIssues,
    scannedPrs: row.scannedPrs,
    createdIssueTasks: row.createdIssueTasks,
    createdPrTasks: row.createdPrTasks,
    createdTrackingIssues: row.createdTrackingIssues,
    skipped: row.skipped,
    error: row.error,
  }));
}

/** Whether a tracking issue was already auto-created for this subject. */
export async function hasScanTracking(
  db: Database,
  repositoryId: string,
  subjectType: "issue" | "pr",
  subjectNumber: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.scanTracking.id })
    .from(schema.scanTracking)
    .where(
      and(
        eq(schema.scanTracking.repositoryId, repositoryId),
        eq(schema.scanTracking.subjectType, subjectType),
        eq(schema.scanTracking.subjectNumber, subjectNumber),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function addScanTracking(
  db: Database,
  input: {
    repositoryId: string;
    subjectType: "issue" | "pr";
    subjectNumber: number;
    trackingIssueNumber: number;
  },
): Promise<void> {
  await db
    .insert(schema.scanTracking)
    .values({
      repositoryId: input.repositoryId,
      subjectType: input.subjectType,
      subjectNumber: input.subjectNumber,
      trackingIssueNumber: input.trackingIssueNumber,
    })
    .onConflictDoNothing();
}
