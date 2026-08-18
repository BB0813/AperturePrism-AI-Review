import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as databaseSchema from "../../../packages/database/src/schema.js";
import {
  analysisTasks,
  taskAttempts,
  taskEvents,
} from "../../../packages/database/src/schema.js";
import {
  taskAnalysisUsageEventType,
  taskCreatedEventType,
  taskCanceledEventType,
  taskCompletedEventType,
  taskFailedEventType,
  taskHeartbeatEventType,
  taskLeaseRecoveredEventType,
  taskLeasedEventType,
  taskPublishingEventType,
  taskRetryReadyEventType,
  taskRetryScheduledEventType,
  taskStartedEventType,
  type CancelTaskInput,
  type ClaimTaskInput,
  type CreateTaskInput,
  type FailTaskInput,
  type FailureResult,
  type HeartbeatTaskInput,
  type LeasedTask,
  type OwnedTaskInput,
  type TaskCreationResult,
  type TaskType,
} from "../../../packages/domain/src/index.js";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type TaskDatabase = Pick<Database, "insert" | "select">;

export type RecordAttemptUsageInput = OwnedTaskInput & {
  attemptNumber: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  provider: string;
  model: string;
};

type PersistedTask = {
  id: string;
  taskType: string;
  status:
    | "queued"
    | "leased"
    | "running"
    | "publishing"
    | "completed"
    | "retry_wait"
    | "failed"
    | "canceled";
  dedupeKey: string;
};

type LeasedTaskRow = PersistedTask & {
  leaseOwner: string;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  attemptNumber: number;
  payload: unknown;
};

function toAnalysisTask(task: PersistedTask) {
  return {
    id: task.id,
    taskType: task.taskType as TaskType,
    status: task.status,
    dedupeKey: task.dedupeKey,
  };
}

function toLeasedTask(task: LeasedTaskRow): LeasedTask {
  return {
    ...toAnalysisTask(task),
    leaseOwner: task.leaseOwner,
    leaseExpiresAt: task.leaseExpiresAt,
    heartbeatAt: task.heartbeatAt,
    attemptNumber: task.attemptNumber,
    payload: task.payload,
  };
}

function leaseExpiry(now: Date, leaseDurationMs: number): Date {
  return new Date(now.getTime() + leaseDurationMs);
}

export async function createAnalysisTaskInTransaction(
  db: TaskDatabase,
  input: CreateTaskInput,
): Promise<TaskCreationResult> {
  const inserted = await db
    .insert(analysisTasks)
    .values({
      taskType: input.taskType,
      ...(input.repositoryId === undefined
        ? {}
        : { repositoryId: input.repositoryId }),
      ...(input.subjectNumber === undefined
        ? {}
        : { subjectNumber: input.subjectNumber }),
      subjectRevision: input.subjectRevision,
      policyVersion: input.policyVersion,
      dedupeKey: input.dedupeKey,
      priority: input.priority ?? 0,
      payload: input.payload,
      maxAttempts: input.maxAttempts ?? 3,
    })
    .onConflictDoNothing({ target: analysisTasks.dedupeKey })
    .returning({
      id: analysisTasks.id,
      taskType: analysisTasks.taskType,
      status: analysisTasks.status,
      dedupeKey: analysisTasks.dedupeKey,
    });

  if (inserted.length === 0) {
    const existing = await db
      .select({
        id: analysisTasks.id,
        taskType: analysisTasks.taskType,
        status: analysisTasks.status,
        dedupeKey: analysisTasks.dedupeKey,
      })
      .from(analysisTasks)
      .where(eq(analysisTasks.dedupeKey, input.dedupeKey))
      .limit(1);
    const task = existing[0];
    if (!task) throw new Error("task disappeared after dedupe conflict");
    return {
      outcome: "duplicate",
      task: toAnalysisTask(task),
    };
  }

  const task = inserted[0];
  if (!task) throw new Error("task insert returned no row");

  await db.insert(taskEvents).values({
    taskId: task.id,
    eventType: taskCreatedEventType,
    data: {
      taskId: task.id,
      taskType: task.taskType,
      dedupeKey: task.dedupeKey,
      status: task.status,
    },
  });

  return {
    outcome: "created",
    task: toAnalysisTask(task),
  };
}

export async function createAnalysisTask(
  db: Database,
  input: CreateTaskInput,
): Promise<TaskCreationResult> {
  return db.transaction((tx) => createAnalysisTaskInTransaction(tx, input));
}

export async function claimTask(
  db: Database,
  input: ClaimTaskInput,
): Promise<LeasedTask | null> {
  const now = input.now ?? new Date();
  const expiresAt = leaseExpiry(now, input.leaseDurationMs);

  return db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: string }>(sql`
      select id
      from analysis_tasks
      where status = 'queued'
        and next_attempt_at <= ${now.toISOString()}::timestamptz
      order by priority desc, next_attempt_at asc, created_at asc
      for update skip locked
      limit 1
    `);
    const candidate = candidates[0];
    if (!candidate) return null;

    const claimed = await tx
      .update(analysisTasks)
      .set({
        status: "leased",
        leaseOwner: input.workerId,
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        attemptCount: sql`${analysisTasks.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(eq(analysisTasks.id, candidate.id))
      .returning({
        id: analysisTasks.id,
        taskType: analysisTasks.taskType,
        status: analysisTasks.status,
        dedupeKey: analysisTasks.dedupeKey,
        leaseOwner: analysisTasks.leaseOwner,
        leaseExpiresAt: analysisTasks.leaseExpiresAt,
        heartbeatAt: analysisTasks.heartbeatAt,
        attemptNumber: analysisTasks.attemptCount,
        payload: analysisTasks.payload,
      });
    const task = claimed[0];
    if (!task || !task.leaseOwner || !task.leaseExpiresAt || !task.heartbeatAt)
      throw new Error("claimed task is missing lease fields");

    await tx.insert(taskAttempts).values({
      taskId: task.id,
      attemptNumber: task.attemptNumber,
      workerId: input.workerId,
      startedAt: now,
    });
    await tx.insert(taskEvents).values({
      taskId: task.id,
      eventType: taskLeasedEventType,
      data: {
        taskId: task.id,
        workerId: input.workerId,
        attemptNumber: task.attemptNumber,
        leaseExpiresAt: task.leaseExpiresAt.toISOString(),
      },
    });

    return toLeasedTask({
      ...task,
      leaseOwner: task.leaseOwner,
      leaseExpiresAt: task.leaseExpiresAt,
      heartbeatAt: task.heartbeatAt,
    });
  });
}

export async function heartbeatTask(
  db: Database,
  input: HeartbeatTaskInput,
): Promise<LeasedTask | null> {
  const now = input.now ?? new Date();
  const expiresAt = leaseExpiry(now, input.leaseDurationMs);
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} in ('leased', 'running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({
        id: analysisTasks.id,
        taskType: analysisTasks.taskType,
        status: analysisTasks.status,
        dedupeKey: analysisTasks.dedupeKey,
        leaseOwner: analysisTasks.leaseOwner,
        leaseExpiresAt: analysisTasks.leaseExpiresAt,
        heartbeatAt: analysisTasks.heartbeatAt,
        attemptNumber: analysisTasks.attemptCount,
        payload: analysisTasks.payload,
      });
    const task = updated[0];
    if (!task || !task.leaseOwner || !task.leaseExpiresAt || !task.heartbeatAt)
      return null;

    await tx.insert(taskEvents).values({
      taskId: task.id,
      eventType: taskHeartbeatEventType,
      data: {
        taskId: task.id,
        workerId: input.workerId,
        leaseExpiresAt: task.leaseExpiresAt.toISOString(),
      },
    });
    return toLeasedTask({
      ...task,
      leaseOwner: task.leaseOwner,
      leaseExpiresAt: task.leaseExpiresAt,
      heartbeatAt: task.heartbeatAt,
      attemptNumber: task.attemptNumber,
    });
  });
}

export async function recoverExpiredLeases(
  db: Database,
  now = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const recovered = await tx
      .update(analysisTasks)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.status} in ('leased', 'running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} <= ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });

    for (const task of recovered) {
      await tx
        .update(taskAttempts)
        .set({ finishedAt: now, errorCategory: "lease_expired" })
        .where(
          sql`${taskAttempts.taskId} = ${task.id}
            and ${taskAttempts.finishedAt} is null`,
        );
      await tx.insert(taskEvents).values({
        taskId: task.id,
        eventType: taskLeaseRecoveredEventType,
        data: { taskId: task.id, recoveredAt: now.toISOString() },
      });
    }
    return recovered.length;
  });
}

export async function startTask(
  db: Database,
  input: OwnedTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({ status: "running", updatedAt: now })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} = 'leased'
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return false;
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskStartedEventType,
      data: { taskId: input.taskId, workerId: input.workerId },
    });
    return true;
  });
}

export async function beginPublishing(
  db: Database,
  input: OwnedTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({ status: "publishing", updatedAt: now })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} = 'running'
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return false;
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskPublishingEventType,
      data: { taskId: input.taskId, workerId: input.workerId },
    });
    return true;
  });
}

export async function completeTask(
  db: Database,
  input: OwnedTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(analysisTasks)
      .set({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastErrorCategory: null,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} = 'publishing'
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return false;
    await tx
      .update(taskAttempts)
      .set({ finishedAt: now })
      .where(
        sql`${taskAttempts.taskId} = ${input.taskId}
          and ${taskAttempts.workerId} = ${input.workerId}
          and ${taskAttempts.finishedAt} is null`,
      );
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskCompletedEventType,
      data: { taskId: input.taskId, workerId: input.workerId },
    });
    return true;
  });
}

export async function failTask(
  db: Database,
  input: FailTaskInput,
): Promise<FailureResult | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const owned = await tx
      .select({
        attemptCount: analysisTasks.attemptCount,
        maxAttempts: analysisTasks.maxAttempts,
      })
      .from(analysisTasks)
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} in ('running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .limit(1);
    const task = owned[0];
    if (!task) return null;

    const exhausted = task.attemptCount >= task.maxAttempts;
    const nextAttemptAt = exhausted
      ? null
      : new Date(now.getTime() + input.retryDelayMs);
    const updated = await tx
      .update(analysisTasks)
      .set({
        status: exhausted ? "failed" : "retry_wait",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        lastErrorCategory: input.errorCategory,
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.leaseOwner} = ${input.workerId}
          and ${analysisTasks.status} in ('running', 'publishing')
          and ${analysisTasks.leaseExpiresAt} > ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    if (updated.length === 0) return null;
    await tx
      .update(taskAttempts)
      .set({ finishedAt: now, errorCategory: input.errorCategory })
      .where(
        sql`${taskAttempts.taskId} = ${input.taskId}
          and ${taskAttempts.workerId} = ${input.workerId}
          and ${taskAttempts.finishedAt} is null`,
      );
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: exhausted ? taskFailedEventType : taskRetryScheduledEventType,
      data: {
        taskId: input.taskId,
        workerId: input.workerId,
        errorCategory: input.errorCategory,
        attemptNumber: task.attemptCount,
        ...(nextAttemptAt
          ? { nextAttemptAt: nextAttemptAt.toISOString() }
          : {}),
      },
    });
    return {
      status: exhausted ? "failed" : "retry_wait",
      nextAttemptAt,
    };
  });
}

export async function cancelTask(
  db: Database,
  input: CancelTaskInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const canceled = await tx
      .update(analysisTasks)
      .set({
        status: "canceled",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastErrorCategory: "canceled",
        updatedAt: now,
      })
      .where(
        sql`${analysisTasks.id} = ${input.taskId}
          and ${analysisTasks.status} in ('queued', 'leased', 'running', 'publishing', 'retry_wait')`,
      )
      .returning({ id: analysisTasks.id });
    if (canceled.length === 0) return false;

    await tx
      .update(taskAttempts)
      .set({ finishedAt: now, errorCategory: "canceled" })
      .where(
        sql`${taskAttempts.taskId} = ${input.taskId}
          and ${taskAttempts.finishedAt} is null`,
      );
    await tx.insert(taskEvents).values({
      taskId: input.taskId,
      eventType: taskCanceledEventType,
      data: {
        taskId: input.taskId,
        reason: input.reason,
        canceledAt: now.toISOString(),
      },
    });
    return true;
  });
}

/**
 * Records model usage for the current attempt as an event. The worker is the
 * only caller; it never mutates task state itself, and the event keeps token
 * and duration data out of the attempt row until a schema change is wanted.
 */
export async function recordAttemptUsage(
  db: Database,
  input: RecordAttemptUsageInput,
): Promise<void> {
  await db.insert(taskEvents).values({
    taskId: input.taskId,
    eventType: taskAnalysisUsageEventType,
    data: {
      taskId: input.taskId,
      workerId: input.workerId,
      attemptNumber: input.attemptNumber,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: input.durationMs,
      provider: input.provider,
      model: input.model,
    },
  });
}

export async function releaseDueRetries(
  db: Database,
  now = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const released = await tx
      .update(analysisTasks)
      .set({ status: "queued", updatedAt: now })
      .where(
        sql`${analysisTasks.status} = 'retry_wait'
          and ${analysisTasks.nextAttemptAt} <= ${now.toISOString()}::timestamptz`,
      )
      .returning({ id: analysisTasks.id });
    for (const task of released) {
      await tx.insert(taskEvents).values({
        taskId: task.id,
        eventType: taskRetryReadyEventType,
        data: { taskId: task.id, readyAt: now.toISOString() },
      });
    }
    return released.length;
  });
}
