import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import {
  BOOLEAN_DEFAULTS,
  createCredentialCipher,
  loadConfig,
  parseBool,
  parseSpamHandling,
} from "../../../packages/config/src/index.js";
import {
  createDatabaseClient,
  externalPublications,
  createGithubAppProvider,
  getRepoMemorySummary,
  getRepositorySettingsFor,
  loadSettings,
  labelsForAnalysis,
  listLabelRules,
  syncAppliedLabels,
  modelRolePolicies,
  providerAccounts,
  repositories,
  resolveGithubAppCredentials,
  subjectResults,
  systemSettings,
  writeAuditLog,
  writeRepoMemory,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelMessage,
  type ModelProviderAdapter,
  type ModelRole,
} from "../../../packages/domain/src/index.js";
import { createGitHubClient, GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import {
  formatSuggestedTitle,
  type IssueAnalysisResult,
} from "../../../packages/contracts/src/index.js";
import {
  analyzeIssue,
  buildIssueAnalysisComment,
  buildIssueContext,
  buildFailureComment,
  buildPlaceholderComment,
  decideReanalysis,
  detectSpamIssue,
  DEFAULT_MIN_CHANGE_RATIO,
  isIssueEditEvent,
  ISSUE_RESULT_SECTIONS,
  issueCommentIdempotencyKey,
  parseIssueResultSections,
  parseIssueTaskPayload,
  parseMinChangeRatio,
  publishIssueComment,
  repositoryOwnerName,
  type IssueContext,
  type IssueResultSection,
  type PublicationStore,
} from "../../../packages/issue-analysis/src/index.js";
import {
  buildPrContext,
  parsePrReviewTaskPayload,
  publishAssessment,
  renderPrContextText,
  renderReviewBody,
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
  getIndexedIssueText,
  judgeDuplicates,
  normalizedIndexText,
  recallCandidatesWithRepos,
  type RelatedIssueRow,
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
  fail: async (task, errorCategory, errorMessage) => {
    await failTask(database.db, {
      taskId: task.id,
      workerId,
      errorCategory,
      retryDelayMs,
      ...(errorMessage === undefined ? {} : { errorMessage }),
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
      loadSettings(db.db, ["agent_team_enabled"]),
      db.db
        .select({ candidates: modelRolePolicies.candidates })
        .from(modelRolePolicies)
        .where(eq(modelRolePolicies.role, "expert_review"))
        .orderBy(desc(modelRolePolicies.createdAt))
        .limit(1),
    ]);
    if (
      !parseBool(
        flag.get("agent_team_enabled"),
        BOOLEAN_DEFAULTS.agent_team_enabled ?? false,
      )
    )
      return false;
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

  // GitHub App 凭据优先取 WebUI 保存到数据库的那份，env 兜底；换 App 不必重启。
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
        ...(config.githubApiBaseUrl
          ? { apiBaseUrl: config.githubApiBaseUrl }
          : {}),
      }),
  });
  // 首次解析：拿到初始客户端，同时把「未配置」尽早记进日志。
  let github = await githubProvider.get();

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
  // 环境变量提供初始基址，WebUI 里保存的 provider 基址覆盖同名项 ——
  // 否则界面新增的 provider 没有 adapter，路由会判为 model_not_found。
  const baseUrls = new Map<string, string>(
    Object.entries(config.modelProviderBaseUrls),
  );
  try {
    const rows = await database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(like(systemSettings.key, "model_provider_base_url:%"));
    for (const row of rows) {
      const provider = row.key.slice("model_provider_base_url:".length);
      if (provider && row.value.trim()) baseUrls.set(provider, row.value.trim());
    }
  } catch (error) {
    logger.warn(
      { err: error },
      "runtime provider base urls unavailable; using environment only",
    );
  }
  for (const [provider, baseUrl] of baseUrls) {
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

    shouldReanalyze: (task, context) => shouldReanalyzeIssue(task, context),

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
        ),
        body: buildPlaceholderComment(),
      });
    },

    // 用同一幂等键原位改写占位评论，不新增评论。
    publishFailure: async (task, errorCategory) => {
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
        ),
        body: buildFailureComment(errorCategory),
      });
    },

    analyze: async (context: IssueContext, signal) => {
      // 深度分析（读取仓库源码）默认关闭：会显著增加 token 消耗与耗时。
      const deep = await issueDeepAnalysisEnabled(
        `${context.repository.owner}/${context.repository.name}`,
      );
      const promptVersion = await resolveIssuePromptVersion();
      const promptMode = await resolveIssuePromptMode();
      const sections = await resolveIssueSections();
      return analyzeIssue(
        {
          adapters,
          candidates: issueCandidates,
          deadlineMs: analysisDeadlineMs,
          retryPolicy: analysisRetryPolicy,
          signal,
          // exactOptionalPropertyTypes：undefined 不能显式赋给可选属性，条件展开。
          ...(promptVersion === undefined ? {} : { promptVersion }),
          ...(promptMode === undefined ? {} : { promptMode }),
          ...(sections === undefined ? {} : { sections }),
          ...(deep
            ? {
                tools: {
                  context: {
                    client: assertGithub(github),
                    installationId: context.installationId,
                    owner: context.repository.owner,
                    name: context.repository.name,
                    // 默认分支：Issue 不像 PR 那样绑定某个 commit。
                    ref: "HEAD",
                  },
                  maxRounds: 4,
                },
              }
            : {}),
        },
        context,
      );
    },

    recallRelated: async (context) => {
      let recalled: RelatedIssueRow[] = [];
      try {
        recalled = await recallCandidatesWithRepos(
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
            // 只在同一仓库内召回历史 Issue，避免把其他项目的 Issue 当作“相关”。
            repository: context.repository,
            // 当前 Issue 在召回前已入库，不排除会把自己列为最相关项。
            excludeIssueNumber: context.issue.number,
          },
        );
      } catch (error) {
        logger.warn({ err: error }, "related-issue recall skipped");
        return [];
      }
      if (recalled.length === 0) return [];

      // 让模型裁决召回候选，只保留确认相关/重复的，避免「文本相似但实际无关」
      // 的误关联（曾把提示词注入测试与获取模型失败这两个无关 issue 列在一起）。
      // 裁决失败或模型判定无关时一律不列出，而不是退回原始召回。
      try {
        const outcome = await judgeDuplicates(
          {
            adapters,
            candidates: issueCandidates,
            deadlineMs: analysisDeadlineMs,
            retryPolicy: analysisRetryPolicy,
          },
          {
            lead: {
              issueNumber: context.issue.number,
              title: context.issue.title,
              body: context.issue.body,
            },
            candidates: recalled.map((row) => ({
              issueNumber: row.issueNumber,
              title: row.title,
              body: row.body,
            })),
          },
        );
        if (outcome.outcome !== "valid") return [];
        if (
          outcome.judgment.decision === "not_duplicate" ||
          outcome.judgment.decision === "insufficient_evidence"
        )
          return [];
        const confirmed = new Set(outcome.judgment.relatedIssues);
        return recalled.filter((row) => confirmed.has(row.issueNumber));
      } catch (error) {
        logger.warn(
          { err: error },
          "related-issue adjudication failed; listing none",
        );
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
        ),
        body: buildIssueAnalysisComment(analysis, related),
      });
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "issue",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result:
          related.length > 0
            ? { ...analysis, related }
            : analysis,
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
      // Issue 增强：自动指派 + 标题改写（best-effort，受运行时设置控制）。
      await applyIssueEnhancements({
        github: assertGithub(github),
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        issueNumber: payload.subjectNumber,
        analysis: analysis.result,
      }).catch((error: unknown) =>
        logger.warn({ err: error, taskId: task.id }, "issue enhancement skipped"),
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

  // --- 增量审查续跑：按仓库+PR 持久化最近的审查对话，供下一次 push 续跑 ---
  const REVIEW_HISTORY_PREFIX = "pr_review_history:";

  async function loadReviewHistory(
    repoFullName: string,
    number: number,
    currentRevision: string,
  ): Promise<readonly ModelMessage[] | undefined> {
    try {
      const rows = await database.db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(
          eq(
            systemSettings.key,
            `${REVIEW_HISTORY_PREFIX}${repoFullName}:${number}`,
          ),
        )
        .limit(1);
      const raw = rows[0]?.value;
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as {
        revision?: string;
        messages?: ModelMessage[];
      };
      // 已是同一 revision，无需续跑。
      if (parsed.revision === currentRevision) return undefined;
      if (!Array.isArray(parsed.messages) || parsed.messages.length === 0)
        return undefined;
      return parsed.messages;
    } catch {
      return undefined;
    }
  }

  async function persistReviewHistory(
    repoFullName: string,
    number: number,
    revision: string,
    messages: readonly ModelMessage[],
  ): Promise<void> {
    const capped = messages.slice(-40).map((m) => ({
      role: m.role,
      content:
        m.content.length > 4_000
          ? `${m.content.slice(0, 4_000)}…`
          : m.content,
    }));
    const key = `${REVIEW_HISTORY_PREFIX}${repoFullName}:${number}`;
    const value = JSON.stringify({ revision, messages: capped });
    await database.db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

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
      const history = await loadReviewHistory(
        payload.repositoryFullName,
        payload.subjectNumber,
        payload.subjectRevision ?? "HEAD",
      );
      return {
        ...context,
        ...(repoMemory ? { repoMemory, rendered: { ...context.rendered, repoMemory } } : {}),
        ...(history ? { reviewHistory: history } : {}),
        toolsContext: {
          client: github,
          installationId: payload.installationId,
          owner: identity.owner,
          name: identity.name,
          ref: payload.subjectRevision ?? "HEAD",
        },
      };
    },

    review: async (context: PrReviewContext, signal) => {
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
      const outcome = await reviewPullRequest(
        {
          adapters,
          candidates: reviewCandidates,
          deadlineMs: reviewDeadlineMs,
          retryPolicy: reviewRetryPolicy,
          signal,
          ...(context.toolsContext
            ? { tools: { context: context.toolsContext } }
            : {}),
          ...(context.reviewHistory
            ? { history: context.reviewHistory }
            : {}),
        },
        context.rendered,
      );
      // 持久化本次审查对话，供下一次 push 增量续跑。
      if (outcome.messages && context.toolsContext) {
        const { owner, name } = context.toolsContext;
        const revision = context.toolsContext.ref;
        void persistReviewHistory(
          `${owner}/${name}`,
          context.pullRequest.number,
          revision,
          outcome.messages,
        ).catch((error: unknown) =>
          logger.warn({ err: error }, "persist review history failed"),
        );
      }
      return outcome;
    },

    publishFinal: async (task, review) => {
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      const cfg = await prReviewConfig();
      if (cfg.autoReview) {
        // 正式 review（含行内 comments），幂等；行内锚点失败自动降级。
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
              comments,
            }) =>
              githubClient.createPullRequestReview({
                installationId,
                owner,
                name,
                pullNumber,
                commitId: revision,
                body,
                event,
                ...(comments && comments.length > 0 ? { comments } : {}),
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
      } else {
        // 自动审查关闭：不提交正式 review，只发一条摘要评论（幂等）。
        const key = `pr-comment:${identity.owner}/${identity.name}#${payload.subjectNumber}:${payload.subjectRevision}`;
        const existing = await publicationStore.findExternalObjectId(key);
        if (existing === null) {
          const comment = await githubClient.createIssueComment({
            installationId: payload.installationId,
            owner: identity.owner,
            name: identity.name,
            number: payload.subjectNumber,
            body: renderReviewBody(review),
          });
          await publicationStore.insert({
            taskId: task.id,
            idempotencyKey: key,
            externalObjectId: String(comment.id),
            channel: "github_issue_comment",
          });
        } else {
          await publicationStore.touch(key);
        }
      }
      await persistSubjectResult({
        taskId: task.id,
        subjectType: "pr",
        subjectNumber: payload.subjectNumber,
        repositoryFullName: payload.repositoryFullName,
        revision: payload.subjectRevision,
        result: review,
      });
    },

    beginCheckRun: async (task) => {
      const cfg = await prReviewConfig();
      if (!cfg.checkRun) return;
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      const key = `check-run:${identity.owner}/${identity.name}#${payload.subjectNumber}:${payload.subjectRevision}`;
      const existing = await publicationStore.findExternalObjectId(key);
      if (existing !== null) return;
      const run = await githubClient.createCheckRun({
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        headSha: payload.subjectRevision,
        runName: "AperturePrism AI Review",
        status: "in_progress",
        title: "AI 代码审查进行中",
        summary: "正在分析 PR 的变更与上下文，请稍候…",
      });
      await publicationStore.insert({
        taskId: task.id,
        idempotencyKey: key,
        externalObjectId: String(run.id),
        channel: "check_run",
      });
    },

    finishCheckRun: async (task, review) => {
      const cfg = await prReviewConfig();
      if (!cfg.checkRun) return;
      const { payload, identity } = prIdentity(task);
      const githubClient = assertGithub(github);
      const key = `check-run:${identity.owner}/${identity.name}#${payload.subjectNumber}:${payload.subjectRevision}`;
      const runId = await publicationStore.findExternalObjectId(key);
      if (runId === null) return;
      const findings = review.findings.length;
      const severe = review.findings.some((finding) =>
        finding.severity === "critical" || finding.severity === "high",
      );
      const conclusion = severe || findings > 0 ? "failure" : "success";
      await githubClient.updateCheckRun({
        installationId: payload.installationId,
        owner: identity.owner,
        name: identity.name,
        checkRunId: Number(runId),
        status: "completed",
        conclusion,
        title: findings > 0 ? `发现 ${findings} 个问题` : "未发现明显问题",
        summary: `结论：${review.overallTone}；变更 ${review.changedFileCount} 个文件（+${review.additions}/-${review.deletions}）；findings ${findings}。`,
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

  const handler: TaskHandler = async (task, signal) => {
    // 每个任务开始前刷新一次凭据：用户在 WebUI 换了 GitHub App 之后，worker
    // 不该必须重启才认新凭据。指纹未变时这只是一次轻量查询。
    github = await githubProvider.get();
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
      if (event.type === "failed") {
        // A failed attempt must leave a diagnosable trace: log the surfaced
        // error (already sanitized/truncated by the loop) at error level.
        taskLogger.error(
          { event: event.type, errorCategory: event.errorCategory, error: event.error },
          "worker event failed",
        );
        return;
      }
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
  analysis: IssueAnalysisResult;
}): Promise<void> {
  const rules = await listLabelRules(database.db);
  // 标签来源 = 规则引擎匹配（category/severity/priority/quality）∪ 模型建议。
  // 此前模型在评论里输出的「建议标签」从不落到 GitHub（issue #23 用户误解的根源）：
  // 评论说了建议标签、Issue 上却没有。合并后言行一致；GitHub 会对不存在的
  // 标签自动创建。
  const ruleLabels = labelsForAnalysis(
    {
      category: input.analysis.category,
      severity: input.analysis.severity,
      priority: input.analysis.priority,
      quality: input.analysis.quality,
    },
    rules,
  );
  const labels = [
    ...new Set(
      [...ruleLabels, ...input.analysis.suggestedLabels].map((label) =>
        label.trim(),
      ),
    ),
  ].filter((label) => label.length > 0);
  // 契约上限：规则映射 + 模型建议各 ≤10；再兜底一层防爆量。
  const capped = labels.slice(0, 15);
  if (capped.length === 0) return;
  logger.info(
    { owner: input.owner, name: input.name, issueNumber: input.issueNumber, labels: capped },
    "applying configured labels",
  );
  await input.github.addIssueLabels({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
    labels: capped,
  });
  // issue #31：把实际打上的标签同步进本地标签配置，WebUI「标签配置」页可见。
  // best-effort：失败只告警，不影响打标与分析任务。
  await syncAppliedLabels(database.db, capped).catch((error: unknown) =>
    logger.warn({ err: error }, "applied label sync failed"),
  );
}

/**
 * 分析行为设置的取值：仓库级覆盖优先，其次全局 `system_settings`，都没有时返回
 * undefined 让调用方套用应用默认（不同开关的默认值不同，这一层不猜）。
 *
 * 同一实例常同时接入个人项目与协作项目 —— 自动改标题在后者未必受欢迎，所以这
 * 些开关必须能按仓库分别控制（issue #54）。仓库未入库或读取失败时退回全局。
 */
async function resolveIssueSettings(
  repositoryFullName: string | null,
  keys: readonly string[],
): Promise<Map<string, string>> {
  let globals: Map<string, string>;
  try {
    globals = await loadSettings(database.db, keys);
  } catch (error) {
    logger.warn({ err: error }, "global settings read failed");
    throw error;
  }

  if (!repositoryFullName) return globals;
  try {
    const repositoryId = await resolveRepositoryId(repositoryFullName);
    if (!repositoryId) return globals;
    const overrides = await getRepositorySettingsFor(
      database.db,
      repositoryId,
      keys,
    );
    // 覆盖优先：仓库级有值就盖掉全局，没有的键保持全局值。
    for (const [key, value] of overrides) globals.set(key, value);
    return globals;
  } catch (error) {
    // 仓库级覆盖不可读时退回全局，而不是让整次分析失败。
    logger.warn(
      { err: error, repo: repositoryFullName },
      "repository settings read failed; using global settings",
    );
    return globals;
  }
}

/**
 * 是否允许 Issue 分析读取仓库源码。默认关闭：探索会显著增加 token 消耗与
 * 单任务耗时，需用户显式开启。读取失败时按关闭处理，不因设置不可用而改变行为。
 */
async function issueDeepAnalysisEnabled(
  repositoryFullName: string | null,
): Promise<boolean> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_deep_analysis",
    ]);
    return parseBool(
      settings.get("issue_deep_analysis"),
      BOOLEAN_DEFAULTS.issue_deep_analysis ?? false,
    );
  } catch {
    return false;
  }
}

/**
 * 当前 Issue 分析的提示词版本。读「分析设置 → Issue 提示词版本」；
 * 缺省或读取失败回落到当前版本（analysis-worker 每轮 pass 重新读，改设置即生效）。
 */
async function resolveIssuePromptVersion(): Promise<string | undefined> {
  try {
    const settings = await resolveIssueSettings(null, [
      "issue_prompt_version",
    ]);
    const raw = settings.get("issue_prompt_version");
    return raw && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 当前 Issue 分析的强度模式（adaptive / light / full）。读「分析设置 →
 * Issue 提示词模式」；缺省或读取失败返回 undefined（默认 adaptive）。
 */
async function resolveIssuePromptMode(): Promise<"adaptive" | "light" | "full" | undefined> {
  try {
    const settings = await resolveIssueSettings(null, ["issue_prompt_mode"]);
    const raw = settings.get("issue_prompt_mode");
    if (raw === "light" || raw === "full" || raw === "adaptive") return raw;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 当前 Issue 分析的结果区块开关（summary / probable_cause / missing_information / …）。
 * 读「分析设置 → Issue 结果区块」；缺省 / 读取失败 / 全非法时回落到全开
 * （parseIssueResultSections 内部处理），这里只在解析结果非全开时才显式传入。
 */
async function resolveIssueSections(): Promise<
  ReadonlySet<IssueResultSection> | undefined
> {
  try {
    const settings = await resolveIssueSettings(null, [
      "issue_result_sections",
    ]);
    const parsed = parseIssueResultSections(
      settings.get("issue_result_sections"),
    );
    return parsed.size === ISSUE_RESULT_SECTIONS.length ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/**
 * 编辑 Issue 后是否重新分析。只有 webhook 的 `issues.edited` 受限制：改一个
 * 错别字就重跑完整分析，既花掉一次模型调用，又会用新结论覆盖既有评论。
 *
 * 比较对象是索引任务写进 `issue_documents` 的归一化正文，所以当前正文必须用
 * 同一套 `normalizedIndexText` 归一化 —— 只改图片或链接不会被算成改动。
 *
 * 任何一步失败都按「分析」处理：宁可多花一次调用，也不要静默吞掉真实修改。
 */
async function shouldReanalyzeIssue(
  task: { payload: unknown },
  context: IssueContext,
): Promise<boolean> {
  if (!isIssueEditEvent(task.payload)) return true;
  try {
    const { payload } = issueIdentity(task);
    const repositoryId = await resolveRepositoryId(payload.repositoryFullName);
    const snapshot = await getIndexedIssueText(
      database.sql as unknown as SqlTag,
      { repositoryId, issueNumber: payload.subjectNumber },
    );
    const revisionAt = new Date(payload.subjectRevision);
    const decision = decideReanalysis({
      gated: true,
      snapshot,
      revisionAt: Number.isNaN(revisionAt.getTime()) ? null : revisionAt,
      currentText: normalizedIndexText({
        title: context.issue.title,
        body: context.issue.body,
      }),
      minChangeRatio: await issueMinChangeRatio(payload.repositoryFullName),
    });
    logger.info(
      {
        repo: payload.repositoryFullName,
        issueNumber: payload.subjectNumber,
        reanalyze: decision.reanalyze,
        reason: decision.reason,
        changeRatio: decision.changeRatio,
      },
      decision.reanalyze
        ? "issue edit will be reanalyzed"
        : "issue edit skipped as a minor change",
    );
    return decision.reanalyze;
  } catch (error) {
    logger.warn(
      { err: error },
      "reanalysis gate failed; analyzing the edit anyway",
    );
    return true;
  }
}

/** 重新分析的最小变化比例（`issue_reanalyze_min_change`），可按仓库覆盖。 */
async function issueMinChangeRatio(
  repositoryFullName: string | null,
): Promise<number> {
  try {
    const settings = await resolveIssueSettings(repositoryFullName, [
      "issue_reanalyze_min_change",
    ]);
    return parseMinChangeRatio(settings.get("issue_reanalyze_min_change"));
  } catch {
    return DEFAULT_MIN_CHANGE_RATIO;
  }
}

async function issueEnhancementConfig(repositoryFullName: string | null): Promise<{
  autoAssign: boolean;
  assignee: string;
  rewriteTitle: boolean;
}> {
  try {
    const map = await resolveIssueSettings(repositoryFullName, [
      "issue_auto_assign",
      "issue_assignee",
      "issue_rewrite_title",
    ]);
    return {
      autoAssign: parseBool(
        map.get("issue_auto_assign"),
        BOOLEAN_DEFAULTS.issue_auto_assign ?? false,
      ),
      assignee: (map.get("issue_assignee") ?? "").trim(),
      // 默认开启：含糊的标题（如只写「bug」）让维护者在列表页无法判断内容，
      // 改写成 [标签][重要度]清晰标题 才是用户期望的默认行为。显式设为
      // "false" 可关闭（全局或按仓库）。
      rewriteTitle: parseBool(
        map.get("issue_rewrite_title"),
        BOOLEAN_DEFAULTS.issue_rewrite_title ?? true,
      ),
    };
  } catch {
    // 读取设置失败时不改写标题：宁可不动，也不要基于未知配置改写用户的 Issue。
    return { autoAssign: false, assignee: "", rewriteTitle: false };
  }
}

/** PR 审查交互开关（运行时设置，可在 WebUI「系统配置」热更新）。 */
async function prReviewConfig(): Promise<{ checkRun: boolean; autoReview: boolean }> {
  try {
    const map = await loadSettings(database.db, [
      "pr_check_run",
      "pr_auto_review",
    ]);
    return {
      checkRun: parseBool(
        map.get("pr_check_run"),
        BOOLEAN_DEFAULTS.pr_check_run ?? true,
      ),
      autoReview: parseBool(
        map.get("pr_auto_review"),
        BOOLEAN_DEFAULTS.pr_auto_review ?? true,
      ),
    };
  } catch {
    return { checkRun: true, autoReview: true };
  }
}

/** GitHub 单个 Issue 最多接受 10 个 assignee，超出会整请求失败。 */
const maxIssueAssignees = 10;

/**
 * 解析指派名单：配置了 issue_assignee 就只用它；留空时默认「仓库所有者 +
 * 协作者」（issue #7）。始终排除 Issue 作者——把问题派回给报告者没有意义。
 * 拉取协作者需要额外权限，失败时降级为仅所有者，不让指派整体失效。
 */
async function resolveIssueAssignees(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  configured: string;
  author: string | null;
}): Promise<string[]> {
  if (input.configured) {
    return input.configured === input.author ? [] : [input.configured];
  }

  let collaborators: string[] = [];
  try {
    collaborators = await input.github.listCollaborators({
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
    });
  } catch (error) {
    logger.warn(
      { err: error, repo: `${input.owner}/${input.name}` },
      "collaborator lookup failed; assigning the owner only",
    );
  }

  const seen = new Set<string>();
  const assignees: string[] = [];
  for (const login of [input.owner, ...collaborators]) {
    if (login === input.author || seen.has(login)) continue;
    seen.add(login);
    assignees.push(login);
    if (assignees.length === maxIssueAssignees) break;
  }
  return assignees;
}

/**
 * Issue 增强：自动指派（issue_assignee 留空时默认仓库所有者与协作者，跳过
 * 作者本人）与标题改写（issue_rewrite_title 开启时应用 suggestedTitle）。
 * 全部 best-effort：失败只告警，不影响分析任务状态。
 */
async function applyIssueEnhancements(input: {
  github: ReturnType<typeof createGitHubClient>;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  analysis: Pick<
    IssueAnalysisResult,
    "severity" | "priority" | "suggestedLabels" | "suggestedTitle"
  >;
}): Promise<void> {
  const cfg = await issueEnhancementConfig(`${input.owner}/${input.name}`);
  // 标题按 [标签][重要度]标题 格式拼装（issue #5），前缀由服务端生成。
  const suggested = formatSuggestedTitle(input.analysis) ?? "";
  if (!cfg.autoAssign && !(cfg.rewriteTitle && suggested)) return;

  // 需要作者（跳过自己）与当前标题（避免无效改写）时再拉取一次 Issue。
  const issue = await input.github.getIssue({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
  });

  const patches: { title?: string; assignees?: string[] } = {};
  if (cfg.autoAssign) {
    const assignees = await resolveIssueAssignees({
      github: input.github,
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
      configured: cfg.assignee,
      author: issue.author,
    });
    if (assignees.length > 0) patches.assignees = assignees;
  }
  if (cfg.rewriteTitle && suggested && suggested !== issue.title) {
    patches.title = suggested;
  }
  if (Object.keys(patches).length === 0) return;

  await input.github.updateIssue({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    number: input.issueNumber,
    ...patches,
  });
  logger.info(
    {
      repo: `${input.owner}/${input.name}`,
      issueNumber: input.issueNumber,
      patches,
    },
    "issue enhancement applied",
  );
}

/** Reads the ad/spam handling policy from `system_settings`; defaults to close. */
async function spamHandlingMode(): Promise<"none" | "close" | "delete"> {
  try {
    const settings = await loadSettings(database.db, ["spam_handling"]);
    return parseSpamHandling(settings.get("spam_handling"));
  } catch (error) {
    logger.warn(
      { err: error },
      "spam handling setting read failed; using close",
    );
    return "close";
  }
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
