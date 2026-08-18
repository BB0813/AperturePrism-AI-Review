import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../../packages/database/src/client.js";
import {
  analysisTasks,
  taskAttempts,
  taskEvents,
} from "../../../packages/database/src/schema.js";
import type { DatabaseClient } from "../../../packages/database/src/client.js";
import {
  beginPublishing,
  cancelTask,
  claimTask,
  completeTask,
  createAnalysisTask,
  failTask,
  startTask,
} from "./index.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("task state PostgreSQL integration", () => {
  const prefix = `m3-state:${randomUUID()}`;
  let client: DatabaseClient;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
  });

  afterAll(async () => {
    if (!client) return;
    await client.sql.begin(async (sql) => {
      await sql`delete from task_events where task_id in (
        select id from analysis_tasks where dedupe_key like ${`${prefix}%`}
      )`;
      await sql`delete from task_attempts where task_id in (
        select id from analysis_tasks where dedupe_key like ${`${prefix}%`}
      )`;
      await sql`delete from analysis_tasks where dedupe_key like ${`${prefix}%`}`;
    });
    await client.close();
  });

  it("requires publishing before completion and closes the attempt", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      subjectRevision: "revision-complete",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:complete`,
      payload: {},
      priority: 1_000_000,
    });
    const leased = await claimTask(client.db, {
      workerId: "worker-complete",
      leaseDurationMs: 60_000,
    });

    expect(leased?.id).toBe(created.task.id);
    expect(
      await startTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(true);
    expect(
      await completeTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(false);
    expect(
      await beginPublishing(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(true);
    expect(
      await completeTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-complete",
      }),
    ).toBe(true);

    const [task] = await client.db
      .select({ status: analysisTasks.status })
      .from(analysisTasks)
      .where(sql`${analysisTasks.id} = ${created.task.id}`);
    const [attempt] = await client.db
      .select({ finishedAt: taskAttempts.finishedAt })
      .from(taskAttempts)
      .where(sql`${taskAttempts.taskId} = ${created.task.id}`);
    const events = await client.db
      .select({ eventType: taskEvents.eventType })
      .from(taskEvents)
      .where(sql`${taskEvents.taskId} = ${created.task.id}`);

    expect(task?.status).toBe("completed");
    expect(attempt?.finishedAt).toBeInstanceOf(Date);
    expect(events.map(({ eventType }) => eventType)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
      "task.publishing",
      "task.completed",
    ]);
    expect(
      await cancelTask(client.db, {
        taskId: created.task.id,
        reason: "terminal task must remain completed",
      }),
    ).toBe(false);
  });

  it("cancels queued and running tasks exactly once", async () => {
    const queued = await createAnalysisTask(client.db, {
      taskType: "issue_analysis",
      subjectRevision: "revision-queued",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:queued`,
      payload: {},
      priority: 1_000_000,
    });
    expect(
      await cancelTask(client.db, {
        taskId: queued.task.id,
        reason: "superseded",
      }),
    ).toBe(true);
    expect(
      await cancelTask(client.db, {
        taskId: queued.task.id,
        reason: "duplicate cancellation",
      }),
    ).toBe(false);

    const running = await createAnalysisTask(client.db, {
      taskType: "pr_review",
      subjectRevision: "revision-running",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:running`,
      payload: {},
      priority: 1_000_000,
    });
    const leased = await claimTask(client.db, {
      workerId: "worker-cancel",
      leaseDurationMs: 60_000,
    });
    expect(leased?.id).toBe(running.task.id);
    expect(
      await startTask(client.db, {
        taskId: running.task.id,
        workerId: "worker-cancel",
      }),
    ).toBe(true);
    expect(
      await cancelTask(client.db, {
        taskId: running.task.id,
        reason: "user requested cancellation",
      }),
    ).toBe(true);

    const [task] = await client.db
      .select({ status: analysisTasks.status })
      .from(analysisTasks)
      .where(sql`${analysisTasks.id} = ${running.task.id}`);
    const [attempt] = await client.db
      .select({
        finishedAt: taskAttempts.finishedAt,
        errorCategory: taskAttempts.errorCategory,
      })
      .from(taskAttempts)
      .where(sql`${taskAttempts.taskId} = ${running.task.id}`);
    const cancellationEvents = await client.db
      .select({ data: taskEvents.data })
      .from(taskEvents)
      .where(
        sql`${taskEvents.taskId} = ${running.task.id}
          and ${taskEvents.eventType} = 'task.canceled'`,
      );

    expect(task?.status).toBe("canceled");
    expect(attempt?.finishedAt).toBeInstanceOf(Date);
    expect(attempt?.errorCategory).toBe("canceled");
    expect(cancellationEvents).toEqual([
      {
        data: expect.objectContaining({
          reason: "user requested cancellation",
        }),
      },
    ]);
  });

  it("does not cancel a failed task", async () => {
    const created = await createAnalysisTask(client.db, {
      taskType: "repository_index",
      subjectRevision: "revision-failed",
      policyVersion: "policy-v1",
      dedupeKey: `${prefix}:failed`,
      payload: {},
      priority: 1_000_000,
      maxAttempts: 1,
    });
    const leased = await claimTask(client.db, {
      workerId: "worker-failed",
      leaseDurationMs: 60_000,
    });
    expect(leased?.id).toBe(created.task.id);
    expect(
      await startTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-failed",
      }),
    ).toBe(true);
    expect(
      await failTask(client.db, {
        taskId: created.task.id,
        workerId: "worker-failed",
        errorCategory: "invalid_output",
        retryDelayMs: 0,
      }),
    ).toEqual({ status: "failed", nextAttemptAt: null });
    expect(
      await cancelTask(client.db, {
        taskId: created.task.id,
        reason: "terminal task must remain failed",
      }),
    ).toBe(false);
  });
});
