import { eq, inArray, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { NormalizedGitHubEvent } from "../../../packages/github-adapter/src/index.js";
import { mapGitHubEventToTask } from "../../../packages/github-adapter/src/index.js";
import {
  cancelSubjectTasks,
  createAnalysisTaskInTransaction,
} from "../../../packages/task-engine/src/index.js";
import * as schema from "./schema.js";

export type WebhookDelivery = {
  deliveryId: string;
  eventName: string;
  payload: unknown;
};

export type WebhookIngestionResult =
  | { outcome: "delivery_duplicate" }
  | { outcome: "ignored"; reason: string }
  | { outcome: "invalid"; reason: string }
  | { outcome: "task_created" | "task_duplicate"; taskId: string }
  | { outcome: "task_canceled"; canceledCount: number };

/** Issue 生命周期事件：关闭 / 删除时取消该 issue 的活跃分析任务（借鉴 PR#540）。 */
const issueCancelActions = new Set(["closed", "deleted"]);

export async function recordWebhookDelivery(
  db: PostgresJsDatabase<typeof schema>,
  delivery: WebhookDelivery,
): Promise<"created" | "duplicate"> {
  const inserted = await db.transaction(async (tx) =>
    tx
      .insert(schema.webhookDeliveries)
      .values({
        deliveryId: delivery.deliveryId,
        eventName: delivery.eventName,
        payload: delivery.payload,
      })
      .onConflictDoNothing({ target: schema.webhookDeliveries.deliveryId })
      .returning({ id: schema.webhookDeliveries.id }),
  );

  return inserted.length > 0 ? "created" : "duplicate";
}

function repositoryName(
  fullName: string,
): { owner: string; name: string } | null {
  const separator = fullName.indexOf("/");
  if (separator <= 0 || separator === fullName.length - 1) return null;
  return {
    owner: fullName.slice(0, separator),
    name: fullName.slice(separator + 1),
  };
}

/** A repository returned by the GitHub App installation sync, before upsert. */
export type InstalledRepositoryRow = {
  id: number;
  owner: string;
  name: string;
};

/**
 * Upserts repositories discovered from `GET /installation/repositories` into
 * the `repositories` table, keyed on the unique `github_id`. Returns the number
 * of repositories written.
 */
export async function upsertInstalledRepositories(
  db: PostgresJsDatabase<typeof schema>,
  installationId: string,
  repos: readonly InstalledRepositoryRow[],
): Promise<number> {
  let count = 0;
  for (const repo of repos) {
    await db
      .insert(schema.repositories)
      .values({
        githubId: String(repo.id),
        owner: repo.owner,
        name: repo.name,
        installationId,
      })
      .onConflictDoUpdate({
        target: schema.repositories.githubId,
        set: {
          owner: repo.owner,
          name: repo.name,
          installationId,
          updatedAt: new Date(),
        },
      });
    count += 1;
  }
  return count;
}

/**
 * 删除单个仓库及其全部从属数据（按外键依赖顺序清理）。删除是幂等的：目标
 * 不存在时直接返回。调用方只在拿到 GitHub 的权威安装/仓库列表后才删除，避免
 * 因一次同步失败误删仍在授权的仓库。
 */
export async function removeRepository(
  db: PostgresJsDatabase<typeof schema>,
  repoId: string,
): Promise<void> {
  // 先取任务 id 数组：postgres-js 对 `inArray(col, subquery)` 会按参数绑定而
  // 非内联，导致 SQL 语法错误，这里显式取回再按数组绑定。
  const taskRows = await db
    .select({ id: schema.analysisTasks.id })
    .from(schema.analysisTasks)
    .where(eq(schema.analysisTasks.repositoryId, repoId));
  const taskIds = taskRows.map((row) => row.id);
  await db.transaction(async (tx) => {
    if (taskIds.length > 0) {
      await tx
        .delete(schema.taskAttempts)
        .where(inArray(schema.taskAttempts.taskId, taskIds));
      await tx
        .delete(schema.taskEvents)
        .where(inArray(schema.taskEvents.taskId, taskIds));
      await tx
        .delete(schema.externalPublications)
        .where(inArray(schema.externalPublications.taskId, taskIds));
      await tx
        .delete(schema.subjectResults)
        .where(inArray(schema.subjectResults.taskId, taskIds));
    }
    await tx
      .delete(schema.analysisTasks)
      .where(eq(schema.analysisTasks.repositoryId, repoId));
    await tx
      .delete(schema.issueDocuments)
      .where(eq(schema.issueDocuments.repositoryId, repoId));
    await tx
      .delete(schema.repoMemory)
      .where(eq(schema.repoMemory.repositoryId, repoId));
    await tx
      .delete(schema.scanConfigs)
      .where(eq(schema.scanConfigs.repositoryId, repoId));
    await tx
      .delete(schema.scanRuns)
      .where(eq(schema.scanRuns.repositoryId, repoId));
    await tx
      .delete(schema.scanTracking)
      .where(eq(schema.scanTracking.repositoryId, repoId));
    await tx
      .delete(schema.repositorySettings)
      .where(eq(schema.repositorySettings.repositoryId, repoId));
    await tx.delete(schema.repositories).where(eq(schema.repositories.id, repoId));
  });
}

/**
 * 同步后的清理：删除「安装已整个移除」或「仓库已从安装中取消」的仓库。
 * 只有当对应安装本次成功拉取过仓库列表时才会删仓库，避免误删。
 */
export async function pruneRepositories(
  db: PostgresJsDatabase<typeof schema>,
  activeInstallations: readonly string[],
  installedByInstallation: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<number> {
  const rows = await db
    .select({
      id: schema.repositories.id,
      githubId: schema.repositories.githubId,
      installationId: schema.repositories.installationId,
    })
    .from(schema.repositories)
    .where(isNotNull(schema.repositories.installationId));
  const active = new Set(activeInstallations);
  let removed = 0;
  for (const row of rows) {
    const installationId = row.installationId;
    if (!installationId) continue;
    // 整个安装已被移除 → 无条件删除。
    if (!active.has(installationId)) {
      await removeRepository(db, row.id);
      removed += 1;
      continue;
    }
    // 安装还在但仓库不在本次拉取的列表里 → 仓库已被取消授权。
    const installed = installedByInstallation.get(installationId);
    if (installed && !installed.has(row.githubId)) {
      await removeRepository(db, row.id);
      removed += 1;
    }
  }
  return removed;
}


export async function ingestGitHubWebhook(
  db: PostgresJsDatabase<typeof schema>,
  event: NormalizedGitHubEvent,
  policyVersion: string,
): Promise<WebhookIngestionResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.webhookDeliveries)
      .values({
        deliveryId: event.deliveryId,
        eventName: event.eventName,
        payload: event.payload,
      })
      .onConflictDoNothing({ target: schema.webhookDeliveries.deliveryId })
      .returning({ id: schema.webhookDeliveries.id });
    const delivery = inserted[0];
    if (!delivery) return { outcome: "delivery_duplicate" };

    // Issue 关闭 / 删除：取消该 issue 的活跃分析任务，不再让 worker 继续跑或补发评论。
    // 需要在 mapGitHubEventToTask 之前拦截（后者会把 closed/deleted 判为 unsupported_action）。
    if (
      event.eventName === "issues" &&
      event.action &&
      issueCancelActions.has(event.action) &&
      event.repositoryId &&
      event.subjectNumber !== null &&
      event.repositoryFullName
    ) {
      const identity = repositoryName(event.repositoryFullName);
      if (identity) {
        const repositories = await tx
          .insert(schema.repositories)
          .values({
            githubId: event.repositoryId,
            owner: identity.owner,
            name: identity.name,
            installationId: event.installationId ?? undefined,
          })
          .onConflictDoUpdate({
            target: schema.repositories.githubId,
            set: {
              owner: identity.owner,
              name: identity.name,
              installationId: event.installationId ?? undefined,
              updatedAt: new Date(),
            },
          })
          .returning({ id: schema.repositories.id });
        const repository = repositories[0];
        if (repository) {
          const canceledCount = await cancelSubjectTasks(tx, {
            taskType: "issue_analysis",
            repositoryId: repository.id,
            subjectNumber: event.subjectNumber,
            reason: `issue_${event.action}`,
          });
          const now = new Date();
          await tx
            .update(schema.webhookDeliveries)
            .set({
              processingStatus: "processed",
              outcomeReason: `task_canceled:${canceledCount}`,
              processedAt: now,
            })
            .where(eq(schema.webhookDeliveries.id, delivery.id));
          return { outcome: "task_canceled", canceledCount };
        }
      }
    }

    const ignoredMapping = mapGitHubEventToTask(
      event,
      "pending",
      policyVersion,
    );
    if (ignoredMapping.outcome !== "task") {
      const now = new Date();
      await tx
        .update(schema.webhookDeliveries)
        .set({
          processingStatus: ignoredMapping.outcome,
          outcomeReason: ignoredMapping.reason,
          processedAt: now,
        })
        .where(eq(schema.webhookDeliveries.id, delivery.id));
      return ignoredMapping;
    }

    if (!event.repositoryId || !event.repositoryFullName)
      throw new Error("task mapping is missing repository identity");
    const identity = repositoryName(event.repositoryFullName);
    if (!identity) {
      await tx
        .update(schema.webhookDeliveries)
        .set({
          processingStatus: "invalid",
          outcomeReason: "invalid_repository_name",
          processedAt: new Date(),
        })
        .where(eq(schema.webhookDeliveries.id, delivery.id));
      return { outcome: "invalid", reason: "invalid_repository_name" };
    }

    const repositories = await tx
      .insert(schema.repositories)
      .values({
        githubId: event.repositoryId,
        owner: identity.owner,
        name: identity.name,
        installationId: event.installationId ?? undefined,
      })
      .onConflictDoUpdate({
        target: schema.repositories.githubId,
        set: {
          owner: identity.owner,
          name: identity.name,
          installationId: event.installationId ?? undefined,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.repositories.id });
    const repository = repositories[0];
    if (!repository) throw new Error("repository upsert returned no row");

    const mapping = mapGitHubEventToTask(event, repository.id, policyVersion);
    if (mapping.outcome !== "task")
      throw new Error("validated event no longer maps to a task");
    const taskResult = await createAnalysisTaskInTransaction(tx, mapping.task);
    await tx
      .update(schema.webhookDeliveries)
      .set({
        processingStatus: "processed",
        taskId: taskResult.task.id,
        outcomeReason:
          taskResult.outcome === "created" ? "task_created" : "task_duplicate",
        processedAt: new Date(),
      })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    return {
      outcome:
        taskResult.outcome === "created" ? "task_created" : "task_duplicate",
      taskId: taskResult.task.id,
    };
  });
}
