import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { desc, eq } from "drizzle-orm";
import {
  createCredentialCipher,
  loadConfig,
} from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  externalPublications,
  modelRolePolicies,
  providerAccounts,
} from "../../../packages/database/src/index.js";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  analyzeIssue,
  buildIssueAnalysisComment,
  buildIssueContext,
  buildPlaceholderComment,
  issueCommentIdempotencyKey,
  parseIssueTaskPayload,
  publishIssueComment,
  repositoryOwnerName,
  type IssueContext,
  type PublicationStore,
} from "../../../packages/issue-analysis/src/index.js";
import { createOpenAICompatibleAdapter } from "../../../packages/model-router/src/index.js";
import {
  createLogger,
  withCorrelation,
} from "../../../packages/observability/src/index.js";
import {
  beginPublishing,
  claimTask,
  completeTask,
  failTask,
  heartbeatTask,
  recordAttemptUsage,
  startTask,
} from "../../../packages/task-engine/src/index.js";
import { createIssueAnalysisHandler } from "./handler.js";
import { runWorkerLoop, type TaskEngineOperations } from "./loop.js";

const leaseDurationMs = 60_000;
const heartbeatIntervalMs = 20_000;
const idleDelayMs = 2_000;
const retryDelayMs = 30_000;
/** Shared logical deadline for the main analysis call and the bounded repair. */
const analysisDeadlineMs = 300_000;
const analysisRetryPolicy = {
  maxAttemptsPerCandidate: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const shutdown = new AbortController();

const engine: TaskEngineOperations = {
  claim: () => claimTask(database.db, { workerId, leaseDurationMs }),
  start: (task) => startTask(database.db, { taskId: task.id, workerId }),
  heartbeat: async (task) =>
    (await heartbeatTask(database.db, {
      taskId: task.id,
      workerId,
      leaseDurationMs,
    })) !== null,
  beginPublishing: (task) =>
    beginPublishing(database.db, { taskId: task.id, workerId }),
  complete: (task) => completeTask(database.db, { taskId: task.id, workerId }),
  fail: async (task, errorCategory) => {
    await failTask(database.db, {
      taskId: task.id,
      workerId,
      errorCategory,
      retryDelayMs,
    });
  },
};

async function loadIssueCandidates(): Promise<ModelCandidate[]> {
  const rows = await database.db
    .select({ candidates: modelRolePolicies.candidates })
    .from(modelRolePolicies)
    .where(eq(modelRolePolicies.role, "issue_analysis"))
    .orderBy(desc(modelRolePolicies.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || !Array.isArray(row.candidates)) return [];
  const candidates: ModelCandidate[] = [];
  for (const entry of row.candidates) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (
      typeof value.provider === "string" &&
      typeof value.model === "string" &&
      typeof value.accountName === "string"
    ) {
      candidates.push({
        provider: value.provider,
        model: value.model,
        accountName: value.accountName,
      });
    }
  }
  return candidates;
}

function issueIdentity(task: { payload: unknown }) {
  const payload = parseIssueTaskPayload(task.payload);
  if (!payload) throw new Error("task payload is missing issue identity");
  const identity = repositoryOwnerName(payload.repositoryFullName);
  if (!identity)
    throw new Error(
      `invalid repository name in payload: ${payload.repositoryFullName}`,
    );
  return { payload, identity };
}

const publicationStore: PublicationStore = {
  findExternalObjectId: async (idempotencyKey) => {
    const rows = await database.db
      .select({ externalObjectId: externalPublications.externalObjectId })
      .from(externalPublications)
      .where(eq(externalPublications.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0]?.externalObjectId ?? null;
  },
  insert: async (input) => {
    await database.db
      .insert(externalPublications)
      .values({
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        externalObjectId: input.externalObjectId,
        channel: input.channel,
      })
      .onConflictDoNothing({ target: externalPublications.idempotencyKey });
  },
  touch: async (idempotencyKey) => {
    await database.db
      .update(externalPublications)
      .set({ updatedAt: new Date() })
      .where(eq(externalPublications.idempotencyKey, idempotencyKey));
  },
};

async function main(): Promise<void> {
  logger.info({ workerId }, "analysis worker starting");

  let github = null;
  if (config.githubAppId && config.githubAppPrivateKeyPath) {
    const privateKeyPem = await readFile(
      config.githubAppPrivateKeyPath,
      "utf8",
    );
    github = createGitHubClient({
      appId: config.githubAppId,
      privateKeyPem,
      ...(config.githubApiBaseUrl
        ? { apiBaseUrl: config.githubApiBaseUrl }
        : {}),
    });
  } else {
    logger.warn("GitHub App is not configured; issue tasks will fail");
  }

  const cipher = config.credentialMasterKey
    ? createCredentialCipher(config.credentialMasterKey)
    : null;
  const resolveApiKey = async (accountName: string): Promise<string> => {
    if (!cipher)
      throw new ModelInvocationError(
        "authentication_failed",
        "provider credentials are not configured",
      );
    const rows = await database.db
      .select({ encryptedCredential: providerAccounts.encryptedCredential })
      .from(providerAccounts)
      .where(eq(providerAccounts.name, accountName))
      .limit(1);
    const row = rows[0];
    if (!row)
      throw new ModelInvocationError(
        "authentication_failed",
        `no provider credential for account ${accountName}`,
      );
    return cipher.open(row.encryptedCredential);
  };

  const adapters = new Map<string, ModelProviderAdapter>();
  for (const [provider, baseUrl] of Object.entries(
    config.modelProviderBaseUrls,
  )) {
    adapters.set(
      provider,
      createOpenAICompatibleAdapter({ provider, baseUrl, resolveApiKey }),
    );
  }

  const candidates = await loadIssueCandidates();
  if (candidates.length === 0)
    logger.warn(
      "no issue_analysis model candidates configured in the database",
    );
  if (adapters.size === 0)
    logger.warn("MODEL_PROVIDER_BASE_URLS is empty; model calls will fail");

  const handler = createIssueAnalysisHandler({
    buildContext: async (task, signal) => {
      if (!github) throw new Error("GitHub App is not configured");
      const { payload, identity } = issueIdentity(task);
      return buildIssueContext(
        github,
        {
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          number: payload.subjectNumber,
        },
        undefined,
        signal,
      );
    },

    publishPlaceholder: async (task) => {
      const { payload, identity } = issueIdentity(task);
      await publishIssueComment({
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
          payload.subjectRevision,
        ),
        body: buildPlaceholderComment(),
      });
    },

    analyze: (context: IssueContext, signal) =>
      analyzeIssue(
        {
          adapters,
          candidates,
          deadlineMs: analysisDeadlineMs,
          retryPolicy: analysisRetryPolicy,
          signal,
        },
        context,
      ),

    publishFinal: async (task, analysis) => {
      const { payload, identity } = issueIdentity(task);
      await publishIssueComment({
        store: publicationStore,
        github: assertGithub(github),
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        idempotencyKey: issueCommentIdempotencyKey(
          payload.repositoryFullName,
          payload.subjectNumber,
          payload.subjectRevision,
        ),
        body: buildIssueAnalysisComment(analysis),
      });
    },

    recordUsage: async (task, outcome) => {
      const lastAttempt = outcome.attempts.at(-1);
      await recordAttemptUsage(database.db, {
        taskId: task.id,
        workerId,
        attemptNumber: task.attemptNumber,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        durationMs: outcome.durationMs,
        provider: lastAttempt?.candidate.provider ?? "",
        model: lastAttempt?.candidate.model ?? "",
      });
    },
  });

  await runWorkerLoop({
    engine,
    handler,
    heartbeatIntervalMs,
    idleDelayMs,
    shutdownSignal: shutdown.signal,
    onEvent: (event) => {
      if (event.type === "idle") return;
      const taskLogger =
        "taskId" in event
          ? withCorrelation(logger, { taskId: event.taskId })
          : logger;
      taskLogger.info({ event: event.type }, "worker event");
    },
  });
  await database.close();
  logger.info({ workerId }, "analysis worker stopped");
}

function assertGithub(github: ReturnType<typeof createGitHubClient> | null) {
  if (!github) throw new Error("GitHub App is not configured");
  return github;
}

function requestShutdown(signal: string): void {
  logger.info({ signal, workerId }, "shutting down");
  shutdown.abort();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

void main().catch((error: unknown) => {
  logger.error({ err: error }, "analysis worker failed");
  process.exitCode = 1;
});
