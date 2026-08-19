export type TaskStatus =
  | "queued"
  | "leased"
  | "running"
  | "publishing"
  | "completed"
  | "retry_wait"
  | "failed"
  | "canceled";

export type TaskType = "issue_analysis" | "pr_review" | "repository_index";

export type AnalysisTask = {
  id: string;
  taskType: TaskType;
  status: TaskStatus;
  dedupeKey: string;
};

export type CreateTaskInput = {
  taskType: TaskType;
  repositoryId?: string;
  subjectNumber?: number;
  subjectRevision: string;
  policyVersion: string;
  dedupeKey: string;
  priority?: number;
  payload: unknown;
  maxAttempts?: number;
};

export type TaskCreationResult = {
  outcome: "created" | "duplicate";
  task: AnalysisTask;
};

export const taskCreatedEventType = "task.created" as const;
export const taskLeasedEventType = "task.leased" as const;
export const taskHeartbeatEventType = "task.heartbeat" as const;
export const taskLeaseRecoveredEventType = "task.lease_recovered" as const;
export const taskStartedEventType = "task.started" as const;
export const taskCompletedEventType = "task.completed" as const;
export const taskRetryScheduledEventType = "task.retry_scheduled" as const;
export const taskRetryReadyEventType = "task.retry_ready" as const;
export const taskFailedEventType = "task.failed" as const;
export const taskPublishingEventType = "task.publishing" as const;
export const taskCanceledEventType = "task.canceled" as const;
export const taskAnalysisUsageEventType = "task.analysis_usage" as const;

export type ClaimTaskInput = {
  workerId: string;
  leaseDurationMs: number;
  now?: Date;
};

export type LeasedTask = AnalysisTask & {
  leaseOwner: string;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  attemptNumber: number;
  /** Raw task payload carried through the lease so workers know the subject. */
  payload: unknown;
};

export type HeartbeatTaskInput = {
  taskId: string;
  workerId: string;
  leaseDurationMs: number;
  now?: Date;
};

export type RecoverExpiredLeasesInput = {
  now?: Date;
};

export type OwnedTaskInput = {
  taskId: string;
  workerId: string;
  now?: Date;
};

export type FailTaskInput = OwnedTaskInput & {
  errorCategory: string;
  retryDelayMs: number;
};

export type FailureResult = {
  status: "retry_wait" | "failed";
  nextAttemptAt: Date | null;
};

export type CancelTaskInput = {
  taskId: string;
  reason: string;
  now?: Date;
};

export type ModelRole =
  | "issue_analysis"
  | "pr_review"
  | "duplicate_judgment"
  | "memory_consolidation";

export type ModelMessageRole = "system" | "user" | "assistant";

export type ModelMessage = {
  role: ModelMessageRole;
  content: string;
};

export type ModelInvocationRequest = {
  messages: readonly ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ModelInvocationResponse = {
  content: string;
  usage: ModelUsage;
};

export const modelErrorCategories = [
  "connection_failed",
  "rate_limited",
  "server_error",
  "timeout",
  "authentication_failed",
  "model_not_found",
  "context_overflow",
  "invalid_output",
  "canceled",
  "unknown",
] as const;

export type ModelErrorCategory = (typeof modelErrorCategories)[number];

/**
 * Categories that indicate the candidate itself is unusable, so retrying the
 * same candidate cannot succeed. The router must move to the next candidate.
 */
export const nonRetryableModelErrorCategories: readonly ModelErrorCategory[] = [
  "authentication_failed",
  "model_not_found",
  "context_overflow",
  "canceled",
];

export class ModelInvocationError extends Error {
  readonly category: ModelErrorCategory;
  readonly retryAfterMs: number | undefined;

  constructor(
    category: ModelErrorCategory,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelInvocationError";
    this.category = category;
    this.retryAfterMs = retryAfterMs;
  }
}

export type ModelCandidate = {
  provider: string;
  model: string;
  accountName: string;
};

export type ModelRolePolicy = {
  role: ModelRole;
  version: string;
  candidates: readonly ModelCandidate[];
};

/**
 * Provider adapters only translate requests, responses, and errors. They never
 * decide whether to retry or switch candidates.
 */
export type ModelProviderAdapter = {
  provider: string;
  invoke: (
    candidate: ModelCandidate,
    request: ModelInvocationRequest,
    signal: AbortSignal,
  ) => Promise<ModelInvocationResponse>;
};

export type ModelAttemptOutcome = {
  candidate: ModelCandidate;
  startedAt: Date;
  finishedAt: Date;
  usage: ModelUsage | null;
  errorCategory: ModelErrorCategory | null;
};

export type ModelRoutingResult = {
  response: ModelInvocationResponse;
  candidate: ModelCandidate;
  attempts: readonly ModelAttemptOutcome[];
};
