import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analysisTasks,
  repositories,
  taskEvents,
  webhookDeliveries,
} from "./schema.js";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import { normalizeGitHubEvent } from "../../../packages/github-adapter/src/index.js";
import { ingestGitHubWebhook } from "./webhooks.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("GitHub webhook ingestion PostgreSQL integration", () => {
  const prefix = `m4-${randomUUID()}`;
  const githubRepositoryId = `${prefix}-repository`;
  let client: DatabaseClient;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
  });

  afterAll(async () => {
    if (!client) return;
    const repositoryRows = await client.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.githubId, githubRepositoryId));
    if (repositoryRows.length > 0) {
      const repositoryIds = repositoryRows.map(({ id }) => id);
      const tasks = await client.db
        .select({ id: analysisTasks.id })
        .from(analysisTasks)
        .where(inArray(analysisTasks.repositoryId, repositoryIds));
      if (tasks.length > 0) {
        const taskIds = tasks.map(({ id }) => id);
        await client.db
          .delete(taskEvents)
          .where(inArray(taskEvents.taskId, taskIds));
        await client.db
          .delete(analysisTasks)
          .where(inArray(analysisTasks.id, taskIds));
      }
    }
    await client.db
      .delete(webhookDeliveries)
      .where(like(webhookDeliveries.deliveryId, `${prefix}%`));
    await client.db
      .delete(repositories)
      .where(eq(repositories.githubId, githubRepositoryId));
    await client.close();
  });

  function issueEvent(deliveryId: string, revision: string) {
    return normalizeGitHubEvent("issues", deliveryId, {
      action: "edited",
      installation: { id: 42 },
      repository: {
        id: githubRepositoryId,
        full_name: `${prefix}/repository`,
      },
      issue: { number: 7, updated_at: revision },
    });
  }

  it("deduplicates deliveries and subject revisions independently", async () => {
    const first = await ingestGitHubWebhook(
      client.db,
      issueEvent(`${prefix}-delivery-1`, "2026-08-17T01:00:00Z"),
      "policy-v1",
    );
    const repeatedDelivery = await ingestGitHubWebhook(
      client.db,
      issueEvent(`${prefix}-delivery-1`, "2026-08-17T01:00:00Z"),
      "policy-v1",
    );
    const repeatedRevision = await ingestGitHubWebhook(
      client.db,
      issueEvent(`${prefix}-delivery-2`, "2026-08-17T01:00:00Z"),
      "policy-v1",
    );
    const editedRevision = await ingestGitHubWebhook(
      client.db,
      issueEvent(`${prefix}-delivery-3`, "2026-08-17T02:00:00Z"),
      "policy-v1",
    );

    expect(first.outcome).toBe("task_created");
    expect(repeatedDelivery).toEqual({ outcome: "delivery_duplicate" });
    expect(repeatedRevision.outcome).toBe("task_duplicate");
    expect(editedRevision.outcome).toBe("task_created");

    const repositoryRows = await client.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.githubId, githubRepositoryId));
    expect(repositoryRows).toHaveLength(1);
    const tasks = await client.db
      .select({ id: analysisTasks.id })
      .from(analysisTasks)
      .where(eq(analysisTasks.repositoryId, repositoryRows[0]!.id));
    expect(tasks).toHaveLength(2);
    const createdEvents = await client.db
      .select({ taskId: taskEvents.taskId })
      .from(taskEvents)
      .where(
        inArray(
          taskEvents.taskId,
          tasks.map(({ id }) => id),
        ),
      );
    expect(createdEvents).toHaveLength(2);

    const deliveries = await client.db
      .select({
        status: webhookDeliveries.processingStatus,
        reason: webhookDeliveries.outcomeReason,
        taskId: webhookDeliveries.taskId,
      })
      .from(webhookDeliveries)
      .where(like(webhookDeliveries.deliveryId, `${prefix}%`));
    expect(deliveries).toHaveLength(3);
    expect(deliveries.map(({ reason }) => reason).sort()).toEqual([
      "task_created",
      "task_created",
      "task_duplicate",
    ]);
    expect(
      deliveries.every(
        ({ status, taskId }) => status === "processed" && taskId,
      ),
    ).toBe(true);
  });

  it("persists ignored and invalid events without creating tasks", async () => {
    const ping = normalizeGitHubEvent("ping", `${prefix}-ping`, {});
    const comment = normalizeGitHubEvent("issue_comment", `${prefix}-comment`, {
      action: "created",
    });
    const invalid = normalizeGitHubEvent("issues", `${prefix}-invalid`, {
      action: "opened",
      repository: {
        id: githubRepositoryId,
        full_name: `${prefix}/repository`,
      },
      issue: { number: 9 },
    });

    expect(await ingestGitHubWebhook(client.db, ping, "policy-v1")).toEqual({
      outcome: "ignored",
      reason: "ping",
    });
    expect(await ingestGitHubWebhook(client.db, comment, "policy-v1")).toEqual({
      outcome: "ignored",
      reason: "comment_commands_not_enabled",
    });
    expect(await ingestGitHubWebhook(client.db, invalid, "policy-v1")).toEqual({
      outcome: "invalid",
      reason: "missing_subject_revision",
    });

    const rows = await client.db
      .select({
        deliveryId: webhookDeliveries.deliveryId,
        status: webhookDeliveries.processingStatus,
      })
      .from(webhookDeliveries)
      .where(like(webhookDeliveries.deliveryId, `${prefix}%`));
    const pingRow = rows.find(
      ({ deliveryId }) => deliveryId === `${prefix}-ping`,
    );
    expect(pingRow).toEqual({
      deliveryId: `${prefix}-ping`,
      status: "ignored",
    });
  });

  it("cancels active analysis tasks when the issue is closed or deleted", async () => {
    const opened = normalizeGitHubEvent("issues", `${prefix}-cancel-open`, {
      action: "opened",
      installation: { id: 42 },
      repository: {
        id: githubRepositoryId,
        full_name: `${prefix}/repository`,
      },
      issue: { number: 77, updated_at: "2026-08-17T01:00:00Z" },
    });
    const created = await ingestGitHubWebhook(client.db, opened, "policy-v1");
    expect(created.outcome).toBe("task_created");

    const repositoryRows = await client.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.githubId, githubRepositoryId));
    const repositoryId = repositoryRows[0]!.id;
    const before = await client.db
      .select({ status: analysisTasks.status })
      .from(analysisTasks)
      .where(
        eq(analysisTasks.repositoryId, repositoryId),
      )
      .then((list) => list.find((t) => t.status === "queued" || t.status === "leased" || t.status === "running"));
    expect(before).toBeDefined();

    const closed = normalizeGitHubEvent("issues", `${prefix}-cancel-close`, {
      action: "closed",
      installation: { id: 42 },
      repository: {
        id: githubRepositoryId,
        full_name: `${prefix}/repository`,
      },
      issue: { number: 77, updated_at: "2026-08-17T02:00:00Z" },
    });
    const result = await ingestGitHubWebhook(client.db, closed, "policy-v1");
    expect(result.outcome).toBe("task_canceled");
    if (result.outcome === "task_canceled") {
      expect(result.canceledCount).toBeGreaterThan(0);
    }

    const after = await client.db
      .select({ status: analysisTasks.status })
      .from(analysisTasks)
      .where(eq(analysisTasks.repositoryId, repositoryId));
    const canceled = after.filter((t) => t.status === "canceled");
    expect(canceled.length).toBeGreaterThan(0);
  });
});
