import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { and, desc, eq } from "drizzle-orm";
import {
  createCredentialCipher,
  loadConfig,
} from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  externalPublications,
  getRepoMemorySummary,
  labelsForAnalysis,
  listLabelRules,
  modelRolePolicies,
  providerAccounts,
  repositories,
  subjectResults,
  systemSettings,
  writeAuditLog,
  writeRepoMemory,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelProviderAdapter,
  type ModelRole,
} from "../../../packages/domain/src/index.js";
import { createGitHubClient, GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import {
  analyzeIssue,
  buildIssueAnalysisComment,
  buildIssueContext,
  buildPlaceholderComment,
  detectSpamIssue,
  issueCommentIdempotencyKey,
  parseIssueTaskPayload,
  publishIssueComment,
  repositoryOwnerName,
  type IssueContext,
  type PublicationStore,
} from "../../../packages/issue-analysis/src/index.js";
import {
  buildPrContext,
  parsePrReviewTaskPayload,
  publishAssessment,
  renderPrContextText,
  reviewPullRequest,
  type PrReviewContext,
} from "../../../packages/pr-review/src/index.js";
import { createOpenAICompatibleAdapter } from "../../../packages/model-router/src/index.js";
import {
  runExpertReview,
  selectSkills,
} from "../../../packages/agent-capabilities/src/index.js";
import {
  extractIssueSignals,
  recallCandidatesWithRepos,
  type SqlTag,
} from "../../../packages/duplicate-detection/src/index.js";
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
import { createPrReviewHandler } from "./pr-review-handler.js";
import {
  runWorkerLoop,
  type TaskEngineOperations,
  type TaskHandler,
} from "./loop.js";

const leaseDurationMs = 60_000;
const heartbeatIntervalMs = 20_000;
const idleDelayMs = 2_000;
const retryDelayMs = 30_000;
/** Shared logical deadline for the main analysis call and the bounded repair. */
const analysisDeadlineMs = 300_000;
const analysisRetryPolicy = {
  maxAttemptsPerCandidate: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  // The newapi CDN gateway intermittently answers 401 under load; bounded
  // retries let a flaky response recover instead of failing the whole task.
  retryAuthentication: true,
};
const reviewDeadlineMs = 300_000;
const reviewRetryPolicy = analysisRetryPolicy;

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

/** A model role policy row; `expert_review` is an optional agent-team role. */
type PolicyRole = ModelRole | "expert_review" | "spam_detection";

async function loadCandidates(role: PolicyRole): Promise<ModelCandidate[]> {
  const rows = await database.db
    .select({ candidates: modelRolePolicies.candidates })
    .from(modelRolePolicies)
    .where(eq(modelRolePolicies.role, role))
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

/**
 * Whether the Agent 专家团队 pipeline is active: the `agent_team_enabled`
 * runtime setting must be "true" AND an `expert_review` model role policy with
 * candidates must exist. A database failure degrades to "disabled" rather than
 * breaking the worker.
 */
async function isExpertTeamEnabled(db: DatabaseClient): Promise<boolean> {
  try {
    const [flag, policy] = await Promise.all([
      db.db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, "agent_team_enabled"))
        .limit(1),
      db.db
        .select({ candidates: modelRolePolicies.candidates })
        .from(modelRolePolicies)
        .where(eq(modelRolePolicies.role, "expert_review"))
        .orderBy(desc(modelRolePolicies.createdAt))
        .limit(1),
    ]);
    if (flag[0]?.value !== "true") return false;
    const candidates = policy[0]?.candidates;
    return Array.isArray(candidates) && candidates.length > 0;
  } catch (error) {
    logger.warn({ err: error }, "expert team flag check failed; disabled");
    return false;
  }
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

/** Looks up the internal repository id for an owner/name pair, if ingested. */
async function resolveRepositoryId(fullName: string): Promise<string | null> {
  const identity = repositoryOwnerName(fullName);
  if (!identity) return null;
  const rows = await database.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.owner, identity.owner),
        eq(repositories.name, identity.name),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Consolidated repo memory of a repository as reference text, or undefined
 * when the repo is unknown / has no consolidated memory yet. Best-effort: a
 * database failure degrades to "no memory" instead of breaking the analysis.
 */
async function repoMemoryText(fullName: string): Promise<string | undefined> {
  try {
    const repositoryId = await resolveRepositoryId(fullName);
    if (!repositoryId) return undefined;
    const text = await getRepoMemorySummary(database.db, repositoryId);
    return text.length > 0 ? text : undefined;
  } catch (error) {
    logger.warn({ err: error, fullName }, "repo memory backfill skipped");
    return undefined;
  }
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

  const issueCandidates = await loadCandidates("issue_analysis");
  if (issueCandidates.length === 0)
    logger.warn(
      "no issue_analysis model candidates configured in the database",
    );
  // Ad/spam detection uses its own role when configured, else issue_analysis.
  const spamCandidates = await loadCandidates("spam_detection");
  const reviewCandidates = await loadCandidates("pr_review");
  if (reviewCandidates.length === 0)
    logger.warn("no pr_review model candidates configured in the database");
  const expertTeamEnabled = await isExpertTeamEnabled(database);
  const expertReviewCandidates = expertTeamEnabled
    ? await loadCandidates("expert_review")
    : [];
  if (adapters.size === 0)
    logger.warn("MODEL_PROVIDER_BASE_URLS is empty; model calls will fail");

  const issueHandler = createIssueAnalysisHandler({
    buildContext: async (task, signal) => {
      if (!github) throw new Error("GitHub App is not configured");
      const { payload, identity } = issueIdentity(task);
      const [context, repoMemory] = await Promise.all([
        buildIssueContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            number: payload.subjectNumber,
          },
          undefined,
          signal,
        ),
        repoMemoryText(payload.repositoryFullName),
      ]);
      return repoMemory ? { ...context, repoMemory } : context;
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
          candidates: issueCandidates,
          deadlineMs: analysisDeadlineMs,
          retryPolicy: analysisRetryPolicy,
          signal,
        },
        context,
      ),

    recallRelated: async (context) => {
      try {
        return await recallCandidatesWithRepos(
          database.sql as unknown as SqlTag,
          {
            title: context.issue.title,
            body: context.issue.body,
            signals: extractIssueSignals({
              title: context.issue.title,
              body: context.issue.body,
              labels: context.issue.labels,
            }),
            topK: 5,
          },
        );
      } catch (error) {
        logger.warn({ err: error }, "related-issue recall skipped");
        return [];
      }
    },

    publishFinal: async (task, analysis, related) => {
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
        body: buildIssueAnalysisComment(analysis, related),
      });
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "issue",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result: analysis,
      });
      // Apply configured label rules to the issue (best-effort, idempotent).
      await applyConfiguredLabels({
        github: assertGithub(github),
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        analysis: analysis.result,
      }).catch((error: unknown) =>
        logger.warn({ err: error, taskId: task.id }, "label application skipped"),
      );
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

    recordMemory: async (task, analysis) => {
      try {
        const { payload } = issueIdentity(task);
        const repositoryId = await resolveRepositoryId(
          payload.repositoryFullName,
        );
        const result = analysis.result;
        const evidence = result.evidence
          .map((entry) => `[${entry.kind}] ${entry.excerpt}`)
          .join("\n");
        const content = [
          `摘要：${result.summary}`,
          `类别：${result.category}；严重度：${result.severity}；优先级：${result.priority}；质量：${result.quality}`,
          ...(evidence.length > 0 ? [`证据：\n${evidence}`] : []),
          ...(result.suggestedActions.length > 0
            ? [`建议动作：${result.suggestedActions.join("、")}`]
            : []),
        ].join("\n");
        await writeRepoMemory(database.db, {
          repositoryId: repositoryId ?? undefined,
          kind: "reflection",
          title: `Issue #${payload.subjectNumber} · ${result.category}/${result.severity} ${result.summary.slice(0, 50)}`,
          content,
          sourceType: "issue_analysis",
          sourceRef: `#${payload.subjectNumber}`,
        });
      } catch (error) {
        logger.warn(
          { err: error, taskId: task.id },
          "issue memory reflection skipped",
        );
      }
    },

    detectSpam: async (task, signal) => {
      try {
        if (!github) return null;
        const candidates =
          spamCandidates.length > 0 ? spamCandidates : issueCandidates;
        if (candidates.length === 0) return null;
        const { payload, identity } = issueIdentity(task);
        const context = await buildIssueContext(
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
        const outcome = await detectSpamIssue(
          {
            adapters,
            candidates,
            deadlineMs: analysisDeadlineMs,
            retryPolicy: analysisRetryPolicy,
            signal,
          },
          context,
        );
        return outcome.outcome === "valid" ? outcome.verdict : null;
      } catch (error) {
        logger.warn({ err: error, taskId: task.id }, "spam detection skipped");
        return null;
      }
    },

    handleSpam: async (task, verdict) => {
      const { payload, identity } = issueIdentity(task);
      const githubClient = assertGithub(github);
      const target = `${payload.repositoryFullName}#${payload.subjectNumber}`;
      let action: "none" | "close" | "delete" = "none";
      try {
        action = await spamHandlingMode();
        if (action === "close") {
          await closeSpamIssue(githubClient, payload, identity, verdict.reason);
        } else if (action === "delete") {
          try {
            await githubClient.deleteIssue({
              installationId: payload.installationId,
              owner: identity.owner,
              name: identity.name,
              number: payload.subjectNumber,
            });
          } catch (error) {
            if (
              error instanceof GitHubApiError &&
              error.category === "authentication_failed"
            ) {
              logger.warn(
                { err: error, target },
                "spam delete not permitted; falling back to close",
              );
              await closeSpamIssue(
                githubClient,
                payload,
                identity,
                verdict.reason,
              );
            } else {
              throw error;
            }
          }
        }
        // "none": no GitHub action; only the audit trail below.
      } catch (error) {
        logger.warn(
          { err: error, target, action },
          "spam handling failed",
        );
      }
      try {
        await writeAuditLog(database.db, {
          actor: "system",
          action: "issue.spam_handled",
          target,
          detail: {
            action,
            reason: verdict.reason,
            confidence: verdict.confidence,
          },
        });
      } catch (error) {
        logger.warn(
          { err: error, target },
          "spam audit log write failed",
        );
      }
    },
  });

  const prReviewHandler = createPrReviewHandler({
    buildContext: async (task, signal) => {
      if (!github) throw new Error("GitHub App is not configured");
      const { payload, identity } = prIdentity(task);
      const [context, repoMemory] = await Promise.all([
        buildPrContext(
          github,
          {
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            pullNumber: payload.subjectNumber,
          },
          undefined,
          signal,
        ),
        repoMemoryText(payload.repositoryFullName),
      ]);
      return {
        ...context,
        ...(repoMemory ? { repoMemory, rendered: { ...context.rendered, repoMemory } } : {}),
        toolsContext: {
          client: github,
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          ref: payload.headSha ?? "HEAD",
        },
      };
    },

    review: (context: PrReviewContext, signal) => {
      const renderedText = renderPrContextText(context.rendered);
      if (expertTeamEnabled) {
        return runExpertReview(
          {
            adapters,
            // Prefer expert_review candidates; fall back to pr_review's.
            candidates:
              expertReviewCandidates.length > 0
                ? expertReviewCandidates
                : reviewCandidates,
            deadlineMs: reviewDeadlineMs,
            retryPolicy: reviewRetryPolicy,
            signal,
          },
          {
            appliesTo: "pr",
            rendered: renderedText,
            skills: selectSkills("pr", renderedText),
          },
        );
      }
      return reviewPullRequest(
        {
          adapters,
          candidates: reviewCandidates,
          deadlineMs: reviewDeadlineMs,
          retryPolicy: reviewRetryPolicy,
          signal,
          ...(context.toolsContext
            ? { tools: { context: context.toolsContext } }
            : {}),
        },
        context.rendered,
      );
    },

    publishFinal: async (task, review) => {
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      await publishAssessment({
        store: publicationStore,
        github: {
          publishReview: ({
            installationId,
            owner,
            name,
            pullNumber,
            revision,
            body,
            event,
          }) =>
            githubClient.createPullRequestReview({
              installationId,
              owner,
              name,
              pullNumber,
              commitId: revision,
              body,
              event,
            }),
        },
        taskId: task.id,
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        pullNumber: payload.subjectNumber,
        revision: payload.subjectRevision,
        review,
      });
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "pr",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result: review,
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

    recordMemory: async (task, review) => {
      try {
        const { payload } = prIdentity(task);
        const repositoryId = await resolveRepositoryId(
          payload.repositoryFullName,
        );
        const findings = review.findings
          .slice(0, 3)
          .map(
            (finding) =>
              `- [${finding.severity}] ${finding.file}: ${finding.message.slice(0, 120)}`,
          )
          .join("\n");
        const content = [
          `总结：${review.summary.slice(0, 200)}`,
          `总体结论：${review.overallTone}；变更 ${review.changedFileCount} 文件（+${review.additions}/-${review.deletions}）`,
          ...(findings.length > 0 ? [`主要发现：\n${findings}`] : []),
        ].join("\n");
        await writeRepoMemory(database.db, {
          repositoryId: repositoryId ?? undefined,
          kind: "reflection",
          title: `PR #${payload.subjectNumber} · ${review.overallTone}`,
          content,
          sourceType: "pr_review",
          sourceRef: `#${payload.subjectNumber}`,
        });
      } catch (error) {
        logger.warn(
          { err: error, taskId: task.id },
          "pr memory reflection skipped",
        );
      }
    },
  });

  logger.info(
    {
      expertTeamEnabled,
      expertCandidates: expertReviewCandidates.length,
      reviewCandidates: reviewCandidates.length,
    },
    "agent expert team status",
  );

  const handler: TaskHandler = (task, signal) => {
    if (task.taskType === "pr_review") return prReviewHandler(task, signal);
    return issueHandler(task, signal);
  };

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

function prIdentity(task: { payload: unknown }) {
  const payload = parsePrReviewTaskPayload(task.payload);
  if (!payload) throw new Error("task payload is missing PR identity");
  const identity = repositoryOwnerName(payload.repositoryFullName);
  if (!identity)
    throw new Error(
      `invalid repository name in payload: ${payload.repositoryFullName}`,
    );
  return { payload, identity };
}

/** Persists a structured issue/PR result once per task (idempotent on taskId). */
async function persistSubjectResult(input: {
  taskId: string;
  subjectType: "issue" | "pr";
  subjectNumber: number;
  repositoryFullName: string;
  revision: string;
  result: unknown;
}): Promise<void> {
  await database.db
    .insert(subjectResults)
    .values({
      taskId: input.taskId,
      subjectType: input.subjectType,
      subjectNumber: input.subjectNumber,
      repositoryFullName: input.repositoryFullName,
      revision: input.revision,
      result: input.result,
      published: true,
    })
    .onConflictDoNothing({ target: subjectResults.taskId });
}

function assertGithub(github: ReturnType<typeof createGitHubClient> | null) {
  if (!github) throw new Error("GitHub App is not configured");
  return github;
}

/** Applies configured label rules to an analyzed issue (idempotent). */
async function applyConfiguredLabels(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  analysis: { category: string; severity: string; priority: string; quality: string };
}): Promise<void> {
  const rules = await listLabelRules(database.db);
  if (rules.length === 0) return;
  const labels = labelsForAnalysis(
    {
      category: input.analysis.category,
      severity: input.analysis.severity,
      priority: input.analysis.priority,
      quality: input.analysis.quality,
    },
    rules,
  );
  if (labels.length === 0) return;
  logger.info(
    { owner: input.owner, name: input.name, issueNumber: input.issueNumber, labels },
    "applying configured labels",
  );
  await input.github.addIssueLabels({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
    labels,
  });
}

/** Reads the ad/spam handling policy from `system_settings`; defaults to close. */
async function spamHandlingMode(): Promise<"none" | "close" | "delete"> {
  try {
    const rows = await database.db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "spam_handling"))
      .limit(1);
    const value = rows[0]?.value;
    if (value === "none" || value === "delete" || value === "close")
      return value;
  } catch (error) {
    logger.warn(
      { err: error },
      "spam handling setting read failed; using close",
    );
  }
  return "close";
}

/** Posts an explanatory comment and closes the flagged spam issue. */
async function closeSpamIssue(
  githubClient: ReturnType<typeof createGitHubClient>,
  payload: { installationId: string; subjectNumber: number },
  identity: { owner: string; name: string },
  reason: string,
): Promise<void> {
  await githubClient.createIssueComment({
    installationId: payload.installationId,
    owner: identity.owner,
    name: identity.name,
    number: payload.subjectNumber,
    body: spamCloseComment(reason),
  });
  await githubClient.closeIssue({
    installationId: payload.installationId,
    owner: identity.owner,
    name: identity.name,
    number: payload.subjectNumber,
  });
}

function spamCloseComment(reason: string): string {
  return `该 Issue 被识别为广告 / 垃圾内容，已自动关闭。\n\n判定理由：${reason}\n\n如果这是误判，请重新打开 Issue 并补充说明，维护者会复核。`;
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
