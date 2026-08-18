import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  repositories,
  systemSettings,
} from "../../../packages/database/src/index.js";
import {
  extractIssueSignals,
  indexIssueDocument,
  normalizedIndexText,
  type SqlTag,
} from "../../../packages/duplicate-detection/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";

/** How often a full re-index pass runs (no-embedding fast path is harmless). */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 min
/** Setting key used by the API/WebUI to request an immediate index pass. */
const TRIGGER_KEY = "index_trigger";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}`;
const shutdown = new AbortController();

function embeddingConfigured(): boolean {
  return Boolean(config.embedding.baseUrl && config.embedding.apiKey);
}

async function createGithub() {
  if (!config.githubAppId || !config.githubAppPrivateKeyPath) {
    logger.warn("GitHub App not configured; indexing disabled");
    return null;
  }
  const privateKeyPem = await readFile(config.githubAppPrivateKeyPath, "utf8");
  return createGitHubClient({
    appId: config.githubAppId,
    privateKeyPem,
    ...(config.githubApiBaseUrl ? { apiBaseUrl: config.githubApiBaseUrl } : {}),
  });
}

/** Runs one indexing pass over every tracked repository. Returns a summary. */
async function runIndexPass(github: NonNullable<Awaited<ReturnType<typeof createGithub>>>): Promise<{
  repos: number;
  indexed: number;
  skippedNoInstall: number;
  errors: string[];
}> {
  const repoRows = await database.db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .orderBy(repositories.name);
  const useEmbedding = embeddingConfigured();
  const summary = { repos: repoRows.length, indexed: 0, skippedNoInstall: 0, errors: [] as string[] };

  for (const repo of repoRows) {
    if (shutdown.signal.aborted) break;
    if (!repo.installationId) {
      summary.skippedNoInstall += 1;
      continue;
    }
    logger.info(
      { owner: repo.owner, name: repo.name, embedding: useEmbedding },
      "indexing repository",
    );
    try {
      let page = 1;
      for (;;) {
        const issues = await github.listIssues({
          installationId: repo.installationId,
          owner: repo.owner,
          name: repo.name,
          state: "all",
          perPage: 100,
          page,
        });
        if (issues.length === 0) break;
        for (const issue of issues) {
          if (shutdown.signal.aborted) break;
          const signals = extractIssueSignals({
            title: issue.title,
            body: issue.body,
            labels: issue.labels,
          });
          const indexText = normalizedIndexText({
            title: issue.title,
            body: issue.body,
          });
          let embedding: number[] | undefined;
          if (useEmbedding) {
            try {
              const result = await embedOneSafe(indexText);
              embedding = result;
            } catch (error) {
              logger.warn(
                { err: error, repo: `${repo.owner}/${repo.name}`, issue: issue.number },
                "embedding failed; indexing without vector",
              );
            }
          }
          await indexIssueDocument(database.sql as unknown as SqlTag, {
            repositoryId: repo.id,
            issueNumber: issue.number,
            title: normalizedIndexText({ title: issue.title, body: "" }),
            body: indexText,
            signals,
            ...(embedding === undefined ? {} : { embedding }),
          });
          summary.indexed += 1;
        }
        if (issues.length < 100 || shutdown.signal.aborted) break;
        page += 1;
      }
    } catch (error) {
      summary.errors.push(
        `${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      logger.warn({ err: error, repo: `${repo.owner}/${repo.name}` }, "repo index failed");
    }
  }
  return summary;
}

/** Embeds a single normalized document; returns the 4096-d vector. */
async function embedOneSafe(text: string): Promise<number[]> {
  const response = await fetch(
    `${config.embedding.baseUrl?.replace(/\/+$/, "") ?? ""}/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.embedding.apiKey ?? ""}`,
      },
      body: JSON.stringify({ model: config.embedding.model, input: [text] }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`embeddings ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    data?: { embedding?: number[] }[];
  };
  const vector = json.data?.[0]?.embedding;
  if (!vector || vector.length === 0) throw new Error("empty embedding response");
  return vector;
}

async function loop(): Promise<void> {
  const github = await createGithub();
  if (!github) {
    logger.warn("index worker has no GitHub App; idle");
    return;
  }
  const intervalMs = Number(process.env.INDEX_INTERVAL_MS);
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;

  // Always run once at startup, then every interval.
  let pass = 0;
  for (;;) {
    if (shutdown.signal.aborted) break;
    pass += 1;
    const started = Date.now();
    const summary = await runIndexPass(github);
    logger.info(
      { workerId, pass, ...summary, durationMs: Date.now() - started },
      "index pass finished",
    );

    // A manual trigger (API/WebUI writes index_trigger=<iso>) shortens the wait.
    const wait = await waitForNextRun(interval);
    if (wait === "triggered") {
      await database.db
        .delete(systemSettings)
        .where(eq(systemSettings.key, TRIGGER_KEY))
        .catch(() => undefined);
    }
  }
}

/** Waits until the interval elapses or a manual trigger appears. */
async function waitForNextRun(intervalMs: number): Promise<"interval" | "triggered"> {
  const started = Date.now();
  for (;;) {
    if (shutdown.signal.aborted) return "interval";
    const elapsed = Date.now() - started;
    if (elapsed >= intervalMs) return "interval";
    const triggered = await hasTrigger();
    if (triggered) return "triggered";
    await sleep(3_000, shutdown.signal);
  }
}

async function hasTrigger(): Promise<boolean> {
  try {
    const rows = await database.db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(eq(systemSettings.key, TRIGGER_KEY))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function requestShutdown(signal: string): void {
  logger.info({ signal, workerId }, "shutting down");
  shutdown.abort();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

void loop()
  .catch((error: unknown) => {
    logger.error({ err: error }, "index worker failed");
    process.exitCode = 1;
  })
  .finally(() => database.close());