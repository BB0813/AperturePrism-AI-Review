import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import {
  BOOLEAN_DEFAULTS,
  createCredentialCipher,
  loadConfig,
  parseBool,
} from "../../../packages/config/src/index.js";
import {
  addScanTracking,
  createDatabaseClient,
  createGithubAppProvider,
  loadSettings,
  resolveGithubAppCredentials,
  failScanRun,
  finishScanRun,
  getScanConfig,
  hasScanTracking,
  insertScanRun,
  latestScanRunAt,
  repositories,
  systemSettings,
  type ScanRunResult,
} from "../../../packages/database/src/index.js";
import { createGitHubClient } from "../../../packages/github-adapter/src/index.js";
import { ISSUE_ANALYSIS_POLICY_VERSION } from "../../../packages/issue-analysis/src/index.js";
import { PR_REVIEW_POLICY_VERSION } from "../../../packages/pr-review/src/index.js";
import { createAnalysisTask } from "../../../packages/task-engine/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";

/** How often the worker wakes up to check which repos are due for a scan. */
const DEFAULT_LOOP_MS = 60 * 1000; // 1 min
/** Setting key: any value requests a full manual scan pass (WebUI button). */
const TRIGGER_KEY = "scan_trigger";
/** Setting key: "false" disables scheduled scanning (manual trigger still works). */
const GLOBAL_ENABLED_KEY = "scan_enabled";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}`;
const shutdown = new AbortController();

/**
 * GitHub App 凭据优先取 WebUI 保存到数据库的那份，env 兜底；换 App 不必重启。
 * 之前这里只读 env，于是用户在界面上配好了却依然「scanning disabled」。
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

type RepoRow = {
  id: string;
  githubId: string;
  owner: string;
  name: string;
  installationId: string | null;
};

/**
 * Scans one repository: lists open issues + PRs, auto-enqueues analysis tasks
 * for subjects not already queued (deduped by the task engine), and optionally
 * auto-creates GitHub tracking issues for new PRs. Records a scan_runs row.
 */
async function scanRepository(
  github: ReturnType<typeof createGitHubClient>,
  repo: RepoRow,
  trigger: "scheduled" | "manual",
): Promise<ScanRunResult> {
  const scanConfig = await getScanConfig(database.db, repo.id);
  const result: ScanRunResult = {
    scannedIssues: 0,
    scannedPrs: 0,
    createdIssueTasks: 0,
    createdPrTasks: 0,
    createdTrackingIssues: 0,
    skipped: 0,
  };
  const run = await insertScanRun(database.db, {
    repositoryId: repo.id,
    trigger,
  });
  const installationId = repo.installationId!;
  const owner = repo.owner;
  const name = repo.name;
  const fullName = `${owner}/${name}`;

  try {
    const [issues, prs] = await Promise.all([
      github.listIssues({
        installationId,
        owner,
        name,
        state: "open",
        perPage: 100,
        page: 1,
      }),
      github.listPullRequests({
        installationId,
        owner,
        name,
        state: "open",
        perPage: 100,
        page: 1,
      }),
    ]);

    for (const issue of issues.slice(0, scanConfig.maxIssues)) {
      if (shutdown.signal.aborted) break;
      result.scannedIssues += 1;
      if (!scanConfig.autoAnalyzeIssues) {
        result.skipped += 1;
        continue;
      }
      // Revision = issue.updatedAt so an unchanged issue dedupes across scans
      // while an edited issue is re-analyzed.
      const subjectRevision = issue.updatedAt || new Date().toISOString();
      const outcome = await createAnalysisTask(database.db, {
        taskType: "issue_analysis",
        repositoryId: repo.id,
        subjectNumber: issue.number,
        subjectRevision,
        policyVersion: ISSUE_ANALYSIS_POLICY_VERSION,
        dedupeKey: `issue-analysis:${repo.id}:${issue.number}:${subjectRevision}:${ISSUE_ANALYSIS_POLICY_VERSION}`,
        payload: {
          installationId,
          repositoryExternalId: repo.githubId,
          repositoryFullName: fullName,
          subjectNumber: issue.number,
          subjectRevision,
          sourceEvent: "scan",
          subjectType: "issue",
        },
      });
      if (outcome.outcome === "created") result.createdIssueTasks += 1;
      else result.skipped += 1;
    }

    for (const pr of prs.slice(0, scanConfig.maxPrs)) {
      if (shutdown.signal.aborted) break;
      result.scannedPrs += 1;
      let alreadyAnalyzed = false;
      if (scanConfig.autoAnalyzePrs) {
        const outcome = await createAnalysisTask(database.db, {
          taskType: "pr_review",
          repositoryId: repo.id,
          subjectNumber: pr.number,
          subjectRevision: pr.headSha,
          policyVersion: PR_REVIEW_POLICY_VERSION,
          dedupeKey: `pr-review:${repo.id}:${pr.number}:${pr.headSha}:${PR_REVIEW_POLICY_VERSION}`,
          payload: {
            installationId,
            repositoryExternalId: repo.githubId,
            repositoryFullName: fullName,
            subjectNumber: pr.number,
            subjectRevision: pr.headSha,
            sourceEvent: "scan",
            subjectType: "pr",
          },
        });
        if (outcome.outcome === "created") result.createdPrTasks += 1;
        else {
          result.skipped += 1;
          alreadyAnalyzed = true;
        }
      }
      // Optional GitHub tracking issue for a PR we haven't reported before.
      if (
        scanConfig.createTrackingIssues &&
        !(await hasScanTracking(database.db, repo.id, "pr", pr.number))
      ) {
        try {
          const created = await github.createIssue({
            installationId,
            owner,
            name,
            title: `[AperturePrism] 新 PR #${pr.number}：${pr.title}`,
            body: [
              "AperturePrism 扫描发现新的 Pull Request，将自动进行代码审查。",
              "",
              `- **PR**：[#${pr.number} ${pr.title}](https://github.com/${fullName}/pull/${pr.number})`,
              `- **Head SHA**：\`${pr.headSha}\``,
              `- **状态**：${alreadyAnalyzed ? "已加入审查队列" : "待审查"}`,
              `- **扫描时间**：${new Date().toISOString()}`,
              "",
              "> 本 Issue 由仓库扫描自动创建，用于跟踪该 PR 的审查进展。",
            ].join("\n"),
          });
          await addScanTracking(database.db, {
            repositoryId: repo.id,
            subjectType: "pr",
            subjectNumber: pr.number,
            trackingIssueNumber: created.number,
          });
          result.createdTrackingIssues += 1;
        } catch (error) {
          logger.warn(
            { err: error, repo: fullName, pr: pr.number },
            "tracking issue creation failed",
          );
        }
      }
    }

    await finishScanRun(database.db, run.id, result);
    logger.info({ repo: fullName, trigger, ...result }, "repository scanned");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failScanRun(database.db, run.id, message);
    logger.warn(
      { err: error, repo: fullName, trigger },
      "repository scan failed",
    );
    throw error;
  }
}

/** True when scheduled scanning is globally enabled (default: enabled). */
async function scanGloballyEnabled(): Promise<boolean> {
  try {
    const settings = await loadSettings(database.db, [GLOBAL_ENABLED_KEY]);
    return parseBool(
      settings.get(GLOBAL_ENABLED_KEY),
      BOOLEAN_DEFAULTS.scan_enabled ?? true,
    );
  } catch {
    return true;
  }
}

/**
 * Runs one scan pass over every installed repository. `force` (manual trigger)
 * scans all enabled repos immediately, ignoring the per-repo interval.
 */
async function runScanPass(
  github: ReturnType<typeof createGitHubClient>,
  force: boolean,
): Promise<{ repos: number; scanned: number; skipped: number; errors: string[] }> {
  const repoRows = await database.db
    .select({
      id: repositories.id,
      githubId: repositories.githubId,
      owner: repositories.owner,
      name: repositories.name,
      installationId: repositories.installationId,
    })
    .from(repositories)
    .orderBy(repositories.name);

  const summary = {
    repos: repoRows.length,
    scanned: 0,
    skipped: 0,
    errors: [] as string[],
  };

  for (const repo of repoRows) {
    if (shutdown.signal.aborted) break;
    if (!repo.installationId) continue;
    const scanConfig = await getScanConfig(database.db, repo.id);
    if (!scanConfig.enabled) {
      summary.skipped += 1;
      continue;
    }
    if (!force) {
      const last = await latestScanRunAt(database.db, repo.id);
      const intervalMs = scanConfig.intervalMinutes * 60_000;
      if (last && Date.now() - last.getTime() < intervalMs) {
        summary.skipped += 1;
        continue;
      }
    }
    try {
      await scanRepository(github, repo, force ? "manual" : "scheduled");
      summary.scanned += 1;
    } catch (error) {
      summary.errors.push(
        `${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return summary;
}

async function loop(): Promise<void> {
  const intervalMsRaw = Number(process.env.SCAN_INTERVAL_MS);
  const loopMs =
    Number.isFinite(intervalMsRaw) && intervalMsRaw > 0
      ? intervalMsRaw
      : DEFAULT_LOOP_MS;

  for (;;) {
    if (shutdown.signal.aborted) break;
    // A manual trigger (WebUI button) forces a full pass regardless of interval.
    const force = (await takeSetting(TRIGGER_KEY)) !== null;
    if (!force && !(await scanGloballyEnabled())) {
      logger.debug("scan disabled globally; waiting");
      await sleep(loopMs, shutdown.signal);
      continue;
    }
    // 每轮开始前刷新凭据：用户可能刚在 WebUI 配好或换掉 GitHub App，不该必须
    // 重启容器。未配置时跳过本轮而不是退出进程 —— 退出的话之后配好了也永远
    // 不会再扫描。
    const github = await githubProvider.get();
    if (!github) {
      await sleep(loopMs, shutdown.signal);
      continue;
    }
    const started = Date.now();
    try {
      const summary = await runScanPass(github, force);
      logger.info(
        { workerId, force, ...summary, durationMs: Date.now() - started },
        "scan pass finished",
      );
    } catch (error) {
      logger.error({ err: error }, "scan pass failed");
    }
    await sleep(loopMs, shutdown.signal);
  }
}

/** Reads and deletes a one-shot setting value. */
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
    logger.error({ err: error }, "scan worker failed");
    process.exitCode = 1;
  })
  .finally(() => database.close());
