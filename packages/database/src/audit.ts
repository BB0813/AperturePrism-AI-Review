import { desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
};

/**
 * Appends an audit log row. Best-effort: callers wrap this so a logging
 * failure never breaks the underlying sensitive operation.
 */
export async function writeAuditLog(
  db: Database,
  entry: {
    actor: string;
    action: string;
    target?: string | undefined;
    detail?: Record<string, unknown> | undefined;
    ip?: string | undefined;
  },
): Promise<void> {
  await db.insert(schema.auditLogs).values({
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
    detail: entry.detail ?? {},
    ip: entry.ip ?? null,
  });
}

/** Lists audit entries newest first, bounded + offset paginated. */
export async function listAuditLogs(
  db: Database,
  options: { limit?: number; offset?: number } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = await db
    .select({
      id: schema.auditLogs.id,
      actor: schema.auditLogs.actor,
      action: schema.auditLogs.action,
      target: schema.auditLogs.target,
      detail: schema.auditLogs.detail,
      ip: schema.auditLogs.ip,
      createdAt: schema.auditLogs.createdAt,
    })
    .from(schema.auditLogs)
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({
    ...row,
    detail: row.detail as Record<string, unknown>,
  }));
}
