import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import {
  createCredentialCipher,
  loadConfig,
} from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  createGithubAppProvider,
  loadSettings,
  resolveGithubAppCredentials,
  repositories,
  systemSettings,
} from "../../../packages/database/src/index.js";
import {
  clearIssueDocuments,
  extractIssueSignals,
  getDocumentHash,
  indexIssueDocument,
  normalizedIndexText,
  type SqlTag,
} from "../../../packages/duplicate-detection/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";

/** How often a full re-index pass runs (content-hash dedupe keeps it cheap). */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 min
/** Setting key used by the API/WebUI to request an immediate index pass. */
const TRIGGER_KEY = "index_trigger";
/** Setting key requesting a full rebuild (clears the index first). */
const REBUILD_KEY = "index_rebuild";
/** Key holding the last pass summary as JSON. */
const LAST_PASS_KEY = "index_last_pass";
/** Embeddings are requested in batches; a whole repo stays inside one fetch. */
const EMBED_BATCH_SIZE = 16;
/**
 * nemotron-3-embed-1b caps a single input at a few thousand tokens. Truncate
 * each document conservatively on characters before batching so one oversized
 * issue cannot fail the whole batch (a 400 aborts the entire repo pass).
 */
const EMBED_MAX_CHARS = 3_000;

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}`;
const shutdown = new AbortController();

function embeddingConfigured(): boolean {
  const e = embeddingOverride;
  return Boolean(e && e.baseUrl && e.apiKey);
}

/**
 * Embedding endpoint may be set through the install wizard as runtime settings
 * (`embedding_base_url` / `embedding_api_key` / `embedding_model`). Load them
 * from the DB once per pass so a wizard change takes effect without a restart.
 */
let embeddingOverride: { baseUrl: string; apiKey: string; model: string } | null =
  null;
async function loadEmbeddingOverride(): Promise<void> {
  try {
    const map = await loadSettings(database.db, [
      "embedding_base_url",
      "embedding_api_key",
      "embedding_model",
    ]);
    embeddingOverride = {
      baseUrl: map.get("embedding_base_url") || config.embedding.baseUrl || "",
      apiKey: map.get("embedding_api_key") || config.embedding.apiKey || "",
      model: map.get("embedding_model") || config.embedding.model,
    };
  } catch {
    embeddingOverride = null;
  }
}

/**
 * GitHub App 凭据优先取 WebUI 保存到数据库的那份，env 兜底；换 App 不必重启。
 * 之前这里只读 env，于是用户在界面上配好了却依然「indexing disabled」。
 */
const githubProvider = createGithubAppProvider({
  logger,
  resolve: () =>
    resolveGithubAppCredentials(database.db, {
      opener: config.credentialMasterKey
        ? createCredentialCipher(config.credentialMasterKey)
        : null,
      env: {
        appId: config.githubAppId,
        privateKeyPath: config.githubAppPrivateKeyPath,
      },
    }),
  createClient: (credentials) =>
    createGitHubClient({
      appId: credentials.appId,
      privateKeyPem: credentials.privateKeyPem,
      ...(config.githubApiBaseUrl ? { apiBaseUrl: config.githubApiBaseUrl } : {}),
    }),
});

/** Deterministic fingerprint of the normalized text+signals for a document. */
function contentHashOf(input: {
  title: string;
  body: string;
  signals: ReturnType<typeof extractIssueSignals>;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Embeds a batch of texts, returning vectors aligned with the input order. */
async function embedBatch(texts: string[]): Promise<number[][]> {
  const e = embeddingOverride ?? {
    baseUrl: config.embedding.baseUrl ?? "",
    apiKey: config.embedding.apiKey ?? "",
    model: config.embedding.model,
  };
  const baseUrl = e.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${e.apiKey}`,
    },
    body: JSON.stringify({ model: e.model, input: texts }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`embeddings ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    data?: { embedding?: number[] }[];
  };
  const vectors = json.data ?? [];
  if (vectors.length === 0) throw new Error("empty embedding response");
  return texts.map((_text, index) => {
    const vector = vectors[index]?.embedding;
    if (!vector || vector.length === 0)
      throw new Error(`missing embedding for index ${index}`);
    return vector;
  });
}

/** Embeds only the documents whose content hash changed. */
async function embedChanged(
  texts: string[],
  hashes: (string | null)[],
  existing: (boolean | undefined)[],
): Promise<(number[] | undefined)[]> {
  const results: (number[] | undefined)[] = new Array(texts.length).fill(
    undefined,
  );
  const jobs: { index: number; text: string }[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    // Skip docs whose content hash is unchanged and already embedded.
    if (hashes[i] !== null && existing[i] === true) continue;
    jobs.push({ index: i, text: texts[i]! });
  }
  if (jobs.length === 0) return results;

  for (let offset = 0; offset < jobs.length; offset += EMBED_BATCH_SIZE) {
    if (shutdown.signal.aborted) break;
    const batch = jobs.slice(offset, offset + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(batch.map((job) => job.text));
    for (let k = 0; k < batch.length; k += 1) {
      results[batch[k]!.index] = vectors[k]!;
    }
    logger.debug({ count: batch.length }, "embedded batch");
  }
  return results;
}

/** Runs one indexing pass over every tracked repository. Returns a summary. */
async function runIndexPass(
  github: ReturnType<typeof createGitHubClient>,
): Promise<{
  repos: number;
  indexed: number;
  skippedUnchanged: number;
  embedded: number;
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
  await loadEmbeddingOverride();
  const useEmbedding = embeddingConfigured();
  const summary = {
    repos: repoRows.length,
    indexed: 0,
    skippedUnchanged: 0,
    embedded: 0,
    errors: [] as string[],
  };

  for (const repo of repoRows) {
    if (shutdown.signal.aborted) break;
    if (!repo.installationId) continue;
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

        const prepared = issues.map((issue) => {
          const signals = extractIssueSignals({
            title: issue.title,
            body: issue.body,
            labels: issue.labels,
          });
          const title = normalizedIndexText({ title: issue.title, body: "" });
          const body = normalizedIndexText({
            title: issue.title,
            body: issue.body,
          });
          return {
            issue,
            signals,
            title,
            body,
            contentHash: contentHashOf({ title, body, signals }),
          };
        });

        // Fetch existing hashes to decide which docs need re-embedding.
        const existing = await Promise.all(
          prepared.map((p) =>
            getDocumentHash(database.sql as unknown as SqlTag, {
              repositoryId: repo.id,
              issueNumber: p.issue.number,
            }),
          ),
        );

        const texts = prepared.map(
          (p) => `${p.title} ${p.body}`.slice(0, EMBED_MAX_CHARS),
        );
        const vectors = useEmbedding
          ? await embedChanged(
              texts,
              prepared.map((p) => p.contentHash),
              existing.map((e) => e?.hasEmbedding),
            )
          : [];

        for (let i = 0; i < prepared.length; i += 1) {
          if (shutdown.signal.aborted) break;
          const p = prepared[i]!;
          const prior = existing[i];
          const unchanged = prior?.contentHash === p.contentHash;
          await indexIssueDocument(database.sql as unknown as SqlTag, {
            repositoryId: repo.id,
            issueNumber: p.issue.number,
            title: p.title,
            body: p.body,
            signals: p.signals,
            contentHash: p.contentHash,
            ...(vectors[i] === undefined ? {} : { embedding: vectors[i] }),
          });
          summary.indexed += 1;
          if (unchanged) {
            summary.skippedUnchanged += 1;
          } else if (vectors[i] !== undefined) {
            summary.embedded += 1;
          }
        }

        if (issues.length < 100 || shutdown.signal.aborted) break;
        page += 1;
      }
    } catch (error) {
      summary.errors.push(
        `${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      logger.warn(
        { err: error, repo: `${repo.owner}/${repo.name}` },
        "repo index failed",
      );
    }
  }
  return summary;
}

/** Records the last pass summary so the API/WebUI can surface index health. */
async function recordLastPass(input: {
  pass: number;
  startedAt: number;
  summary: Awaited<ReturnType<typeof runIndexPass>>;
  rebuild: boolean;
}): Promise<void> {
  const value = JSON.stringify({
    pass: input.pass,
    rebuild: input.rebuild,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - input.startedAt,
    ...input.summary,
  });
  await database.db
    .insert(systemSettings)
    .values({ key: LAST_PASS_KEY, value })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, updatedAt: new Date() },
    })
    .catch((error: unknown) =>
      logger.warn({ err: error }, "index last-pass record failed"),
    );
}

async function loop(): Promise<void> {
  const intervalMs = Number(process.env.INDEX_INTERVAL_MS);
  const interval =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_INTERVAL_MS;

  let pass = 0;
  for (;;) {
    if (shutdown.signal.aborted) break;
    pass += 1;

    // A rebuild request clears the index before the pass so every repo re-indexes.
    const rebuild = await takeSetting(REBUILD_KEY);
    if (rebuild) {
      logger.info({ workerId }, "index rebuild requested; clearing index");
      await clearIssueDocuments(database.sql as unknown as SqlTag).catch(
        (error: unknown) =>
          logger.warn({ err: error }, "index clear failed during rebuild"),
      );
    }

    // 每轮开始前刷新凭据：用户可能刚在 WebUI 配好或换掉 GitHub App，
    // 不该必须重启容器。未配置时跳过本轮而不是退出进程 —— 退出的话之后配好了
    // 也永远不会再索引。
    const github = await githubProvider.get();
    if (!github) {
      await waitForNextRun(interval);
      continue;
    }

    const started = Date.now();
    const summary = await runIndexPass(github);
    logger.info(
      {
        workerId,
        pass,
        rebuild: Boolean(rebuild),
        ...summary,
        durationMs: Date.now() - started,
      },
      "index pass finished",
    );
    await recordLastPass({
      pass,
      startedAt: started,
      summary,
      rebuild: Boolean(rebuild),
    });

    // A manual trigger shortens the wait to the next pass.
    const wait = await waitForNextRun(interval);
    if (wait === "triggered") {
      await takeSetting(TRIGGER_KEY);
    }
  }
}

/** Waits until the interval elapses or a manual trigger/rebuild appears. */
async function waitForNextRun(
  intervalMs: number,
): Promise<"interval" | "triggered"> {
  const started = Date.now();
  for (;;) {
    if (shutdown.signal.aborted) return "interval";
    const elapsed = Date.now() - started;
    if (elapsed >= intervalMs) return "interval";
    const triggered =
      (await hasSetting(TRIGGER_KEY)) || (await hasSetting(REBUILD_KEY));
    if (triggered) return "triggered";
    await sleep(3_000, shutdown.signal);
  }
}

/** Reads and deletes a one-shot setting value (returns its raw value). */
async function takeSetting(key: string): Promise<string | null> {
  try {
    const rows = await database.db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .limit(1);
    const value = rows[0]?.value ?? null;
    await database.db.delete(systemSettings).where(eq(systemSettings.key, key));
    return value;
  } catch {
    return null;
  }
}

async function hasSetting(key: string): Promise<boolean> {
  try {
    const rows = await database.db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
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

void loop()
  .catch((error: unknown) => {
    logger.error({ err: error }, "index worker failed");
    process.exitCode = 1;
  })
  .finally(() => database.close());
