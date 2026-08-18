import { describe, expect, it } from "vitest";
import type {
  ClaimTaskInput,
  CreateTaskInput,
  AnalysisTask,
  HeartbeatTaskInput,
} from "../../../packages/domain/src/index.js";
import {
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
} from "../../../packages/domain/src/index.js";

describe("task creation contract", () => {
  it("accepts an issue task without provider-specific payload requirements", () => {
    const input: CreateTaskInput = {
      taskType: "issue_analysis",
      subjectRevision: "content-revision-1",
      policyVersion: "policy-v1",
      dedupeKey: "issue-analysis:repository:7:content-revision-1:policy-v1",
      payload: { issueNumber: 7 },
    };

    expect(input.taskType).toBe("issue_analysis");
    expect(input.payload).toEqual({ issueNumber: 7 });
  });

  it("keeps the persisted result contract minimal", () => {
    const task: AnalysisTask = {
      id: "task-1",
      taskType: "pr_review",
      status: "queued",
      dedupeKey: "pr-review:repository:8:head-sha:policy-v1",
    };

    expect({ outcome: "created", task }).toEqual({
      outcome: "created",
      task,
    });
    expect(taskCreatedEventType).toBe("task.created");
  });
});

describe("task lease contract", () => {
  it("requires an explicit worker and lease duration", () => {
    const claim: ClaimTaskInput = {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
    };
    const heartbeat: HeartbeatTaskInput = {
      taskId: "task-1",
      workerId: "worker-a",
      leaseDurationMs: 30_000,
    };

    expect(claim.workerId).toBe("worker-a");
    expect(heartbeat.taskId).toBe("task-1");
  });

  it("uses stable event names for lease state changes", () => {
    expect([
      taskLeasedEventType,
      taskHeartbeatEventType,
      taskLeaseRecoveredEventType,
    ]).toEqual(["task.leased", "task.heartbeat", "task.lease_recovered"]);
  });
});

describe("task execution contract", () => {
  it("uses stable event names for execution and retry transitions", () => {
    expect([
      taskStartedEventType,
      taskPublishingEventType,
      taskCompletedEventType,
      taskRetryScheduledEventType,
      taskRetryReadyEventType,
      taskFailedEventType,
      taskCanceledEventType,
    ]).toEqual([
      "task.started",
      "task.publishing",
      "task.completed",
      "task.retry_scheduled",
      "task.retry_ready",
      "task.failed",
      "task.canceled",
    ]);
  });
});
