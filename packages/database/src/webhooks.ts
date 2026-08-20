import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { NormalizedGitHubEvent } from "../../../packages/github-adapter/src/index.js";
import { mapGitHubEventToTask } from "../../../packages/github-adapter/src/index.js";
import { createAnalysisTaskInTransaction } from "../../../packages/task-engine/src/index.js";
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
  | { outcome: "task_created" | "task_duplicate"; taskId: string };

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
