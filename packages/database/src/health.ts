import type { Sql } from "postgres";
import type { RedisClient } from "./redis.js";

export type DependencyHealth =
  { status: "ok" } | { status: "error"; reason: string };

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("health check timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown dependency error";
}

export async function checkDatabase(
  sql: Sql,
  timeoutMs: number,
): Promise<DependencyHealth> {
  try {
    const rows = await withTimeout(
      sql<
        { migrationApplied: boolean }[]
      >`select to_regclass('public.analysis_tasks') is not null as "migrationApplied"`,
      timeoutMs,
    );
    return rows[0]?.migrationApplied
      ? { status: "ok" }
      : { status: "error", reason: "database migration is not applied" };
  } catch (error) {
    return { status: "error", reason: failureReason(error) };
  }
}

export async function checkRedis(
  client: RedisClient,
  timeoutMs: number,
): Promise<DependencyHealth> {
  try {
    if (client.status === "wait")
      await withTimeout(client.connect(), timeoutMs);
    const response = await withTimeout(client.ping(), timeoutMs);
    return response === "PONG"
      ? { status: "ok" }
      : { status: "error", reason: "unexpected Redis response" };
  } catch (error) {
    return { status: "error", reason: failureReason(error) };
  }
}
