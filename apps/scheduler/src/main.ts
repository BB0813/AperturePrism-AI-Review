import { hostname } from "node:os";
import {
  createCredentialCipher,
  loadConfig,
} from "../../../packages/config/src/index.js";
import { createDatabaseClient } from "../../../packages/database/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import {
  recoverExpiredLeases,
  releaseDueRetries,
} from "../../../packages/task-engine/src/index.js";
import { starAidSweep } from "../../../packages/star-aid/src/sweep.js";
import { memoryConsolidationSweep } from "./consolidation.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}`;
const shutdown = new AbortController();

/** How often lease recovery and retry-release sweep runs. */
const SWEEP_INTERVAL_MS = 10_000;
/** How often the memory-consolidation agent merges pending reflections. */
const CONSOLIDATION_INTERVAL_MS = 10 * 60 * 1_000;
/** How often the star-aid agent stars pending target repositories. */
const STAR_AID_INTERVAL_MS = 15 * 60 * 1_000;

/** Runs one maintenance sweep over the task table. */
async function sweep(): Promise<void> {
  const [recovered, released] = await Promise.all([
    recoverExpiredLeases(database.db).catch((error: unknown) => {
      logger.warn({ err: error }, "lease recovery sweep failed");
      return 0;
    }),
    releaseDueRetries(database.db).catch((error: unknown) => {
      logger.warn({ err: error }, "retry release sweep failed");
      return 0;
    }),
  ]);
  if (recovered > 0 || released > 0) {
    logger.info({ recovered, released }, "task maintenance sweep");
  }
}

/**
 * Runs one memory-consolidation pass. Fire-and-forget from the caller so a
 * slow model call never blocks lease recovery; failures are logged inside.
 */
async function consolidationTick(): Promise<void> {
  const result = await memoryConsolidationSweep(database, logger).catch(
    (error: unknown) => {
      logger.warn({ err: error }, "memory consolidation sweep failed");
      return null;
    },
  );
  if (result && (result.repositories > 0 || result.rules > 0)) {
    logger.info(result, "memory consolidation sweep");
  }
}

/**
 * Stars pending star-aid targets once. Fire-and-forget; a failure only warns
 * so the scheduler loop stays alive. Skipped when no credential master key is
 * configured (the stored PATs cannot be decrypted).
 */
async function starAidTick(): Promise<void> {
  if (!config.credentialMasterKey) {
    logger.warn("star-aid sweep skipped: CREDENTIAL_MASTER_KEY not configured");
    return;
  }
  const result = await starAidSweep(database.db, {
    cipher: createCredentialCipher(config.credentialMasterKey),
    apiBaseUrl: config.githubApiBaseUrl,
  }).catch((error: unknown) => {
    logger.warn({ err: error }, "star-aid sweep failed");
    return null;
  });
  if (result && result.processed > 0) {
    logger.info(result, "star-aid sweep");
  }
}

async function loop(): Promise<void> {
  logger.info({ workerId }, "scheduler starting");
  await sweep();
  void consolidationTick();
  void starAidTick();
  let lastConsolidation = Date.now();
  let lastStarAid = Date.now();
  while (!shutdown.signal.aborted) {
    await sleep(SWEEP_INTERVAL_MS, shutdown.signal);
    if (shutdown.signal.aborted) break;
    await sweep();
    if (Date.now() - lastConsolidation >= CONSOLIDATION_INTERVAL_MS) {
      lastConsolidation = Date.now();
      void consolidationTick();
    }
    if (Date.now() - lastStarAid >= STAR_AID_INTERVAL_MS) {
      lastStarAid = Date.now();
      void starAidTick();
    }
  }
  await database.close();
  logger.info({ workerId }, "scheduler stopped");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function requestShutdown(signal: string): void {
  logger.info({ signal, workerId }, "shutting down");
  shutdown.abort();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

void loop().catch((error: unknown) => {
  logger.error({ err: error }, "scheduler failed");
  process.exitCode = 1;
});
