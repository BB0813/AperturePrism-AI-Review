import { hostname } from "node:os";
import { loadConfig } from "../../../packages/config/src/index.js";
import { createDatabaseClient } from "../../../packages/database/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import {
  recoverExpiredLeases,
  releaseDueRetries,
} from "../../../packages/task-engine/src/index.js";
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

async function loop(): Promise<void> {
  logger.info({ workerId }, "scheduler starting");
  await sweep();
  void consolidationTick();
  let lastConsolidation = Date.now();
  while (!shutdown.signal.aborted) {
    await sleep(SWEEP_INTERVAL_MS, shutdown.signal);
    if (shutdown.signal.aborted) break;
    await sweep();
    if (Date.now() - lastConsolidation >= CONSOLIDATION_INTERVAL_MS) {
      lastConsolidation = Date.now();
      void consolidationTick();
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
