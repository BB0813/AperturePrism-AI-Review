#!/usr/bin/env node
/**
 * Applies pending Drizzle migrations to the configured database.
 * Requires DATABASE_URL (env or .env in the repo root).
 *
 *   node scripts/migrate.mjs
 *
 * Self-contained runner: reads `_journal.json` for the migration order, then
 * executes each pending `<tag>.sql` directly against PostgreSQL and records it
 * in the drizzle-compatible `drizzle.__drizzle_migrations` table. This avoids
 * `drizzle-kit migrate`, which silently fails on handwritten migrations that
 * lack snapshot files (the project maintains migrations as plain SQL).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "packages", "database", "migrations");

if (!process.env.DATABASE_URL) {
  console.error("migrate: DATABASE_URL is required (set it or put it in .env)");
  process.exit(1);
}

async function main() {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  if (entries.length === 0) {
    console.error("migrate: no journal entries found");
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);

    const appliedRows = await sql`select created_at from drizzle.__drizzle_migrations`;
    const applied = new Set(appliedRows.map((row) => String(row.created_at)));

    let appliedNow = 0;
    for (const entry of entries) {
      if (applied.has(String(entry.when))) continue;
      const file = join(MIGRATIONS_DIR, `${entry.tag}.sql`);
      const content = readFileSync(file, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      console.log(`migrate: applying ${entry.tag} ...`);
      await sql.unsafe(content);
      await sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${hash}, ${entry.when})
      `;
      appliedNow += 1;
      console.log(`migrate:   ok`);
    }

    console.log(
      `migrate: done (${appliedNow} applied, ${entries.length} total in journal)`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(
    "migrate failed:",
    error && error.message ? error.message : String(error),
  );
  process.exit(1);
});
