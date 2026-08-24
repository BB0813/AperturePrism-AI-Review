import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type DatabaseClient = {
  db: PostgresJsDatabase<typeof schema>;
  sql: Sql;
  close: () => Promise<void>;
};

/**
 * 连接池默认 5 而非 10：本项目有 6 个常驻进程（api、3 个 worker、scheduler，
 * 另有可选的 qq-bot 会建两个客户端），各自建池。10 × 6 已达 60，逼近
 * PostgreSQL 默认的 max_connections=100，在小机器上容易耗尽连接。
 * 实测稳态只有个位数 tps，5 足够；需要时用 DATABASE_POOL_MAX 覆盖。
 */
function poolMax(): number {
  const raw = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(raw) && raw > 0 && raw <= 50 ? raw : 5;
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const sql = postgres(databaseUrl, {
    max: poolMax(),
    idle_timeout: 20,
    connect_timeout: 5,
  });
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
