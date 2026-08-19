import { inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { CredentialCipher } from "../../../packages/config/src/index.js";
import * as schema from "../../../packages/database/src/schema.js";
import {
  listPendingStarTargets,
  markTargetError,
  markTargetStarred,
} from "../../../packages/database/src/star-aid.js";
import { decryptToken } from "./encrypt.js";
import { starGitHubRepo } from "./github.js";

type Database = PostgresJsDatabase<typeof schema>;

export type StarAidSweepDeps = {
  /** AES-GCM credential cipher used to open the stored PATs. */
  cipher: CredentialCipher;
  /** GitHub API base URL; falls back to api.github.com inside github.ts. */
  apiBaseUrl: string | undefined;
  /** Injectable clock (unused by the current flow; kept for testability). */
  now?: () => Date;
  /** Optional pacing hook between star calls to respect GitHub rate limits. */
  sleep?: (ms: number) => Promise<void>;
};

export type StarAidSweepResult = {
  processed: number;
  starred: number;
  failed: number;
};

function splitFullName(fullName: string): [string, string] {
  const idx = fullName.indexOf("/");
  if (idx <= 0 || idx === fullName.length - 1)
    throw new Error(`invalid repository full name: ${fullName}`);
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

/**
 * Stars every pending target (belonging to enabled accounts) one at a time.
 * Each target is independent: a single failure is recorded on the row and never
 * aborts the sweep. Returns aggregate counts; never throws.
 */
export async function starAidSweep(
  db: Database,
  deps: StarAidSweepDeps,
): Promise<StarAidSweepResult> {
  const pending = await listPendingStarTargets(db);
  if (pending.length === 0) return { processed: 0, starred: 0, failed: 0 };

  const accountIds = [...new Set(pending.map((target) => target.accountId))];
  const tokenRows = await db
    .select({
      id: schema.starAidAccounts.id,
      encryptedToken: schema.starAidAccounts.encryptedToken,
    })
    .from(schema.starAidAccounts)
    .where(inArray(schema.starAidAccounts.id, accountIds));
  const tokenByAccount = new Map(
    tokenRows.map((row) => [row.id, row.encryptedToken]),
  );

  let starred = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += 1) {
    const target = pending[i]!;
    const encrypted = tokenByAccount.get(target.accountId);
    if (!encrypted) {
      await markTargetError(db, target.id, "account token missing");
      failed += 1;
    } else {
      try {
        const [owner, repo] = splitFullName(target.fullName);
        const token = decryptToken(deps.cipher, encrypted);
        await starGitHubRepo(deps.apiBaseUrl, token, owner, repo);
        await markTargetStarred(db, target.id);
        starred += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markTargetError(db, target.id, message);
        failed += 1;
      }
    }
    if (deps.sleep && i < pending.length - 1) await deps.sleep(0);
  }
  return { processed: pending.length, starred, failed };
}
