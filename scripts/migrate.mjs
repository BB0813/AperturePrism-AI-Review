#!/usr/bin/env node
/**
 * Applies pending Drizzle migrations to the configured database.
 * Requires DATABASE_URL (env or .env in the repo root).
 *
 *   node scripts/migrate.mjs
 */
import { spawnSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";

loadDotenv();

if (!process.env.DATABASE_URL) {
  console.error("migrate: DATABASE_URL is required (set it or put it in .env)");
  process.exit(1);
}

console.log("migrate: applying pending migrations…");
const result = spawnSync(
  "npx",
  [
    "drizzle-kit",
    "migrate",
    "--config",
    "packages/database/drizzle.config.ts",
  ],
  { stdio: "inherit", env: process.env, shell: process.platform === "win32" },
);
if (result.status !== 0) {
  console.error(`migrate: drizzle-kit exited with code ${result.status ?? "null"}`);
  process.exit(result.status ?? 1);
}
console.log("migrate: done");

// Re-export for tooling that imports the file (keeps it side-effect aware).
export default undefined;
