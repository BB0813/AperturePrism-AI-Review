export type HealthDependency = {
  name: string;
  status: "ok" | "error";
};

export type ReadyHealth = {
  status: "ok" | "error";
  dependencies: { database: HealthDependency; redis: HealthDependency };
};

export type HealthResult =
  | { kind: "live"; status: "ok" }
  | { kind: "ready"; data: ReadyHealth };

export type TaskSummary = {
  id: string;
  taskType: "issue_analysis" | "pr_review" | "repository_index";
  repositoryId: string | null;
  subjectNumber: number | null;
  subjectRevision: string;
  policyVersion: string;
  status: string;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskList = {
  items: TaskSummary[];
  nextCursor?: string;
};

export type TaskEvent = {
  eventType: string;
  data: unknown;
  createdAt: string;
};

export type TaskAttempt = {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  errorCategory: string | null;
};

export type TaskDetail = TaskSummary & {
  payload: unknown;
  timeline: TaskEvent[];
  attempts: TaskAttempt[];
};

export type ModelPolicy = {
  role: string;
  version: string;
  candidates: { provider: string; model: string; accountName: string }[];
  createdAt: string;
};

export type ProviderOverview = {
  policies: ModelPolicy[];
  accounts: string[];
};

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`request failed with ${response.status}`);
  return response.json();
}

/** Fetches both liveness and readiness; the UI shows a clear error on failure. */
export async function fetchHealth(): Promise<HealthResult> {
  const live = (await getJson("/health/live")) as { status?: string };
  if (live.status !== "ok") throw new Error("liveness check failed");
  const ready = (await getJson("/health/ready")) as ReadyHealth;
  return { kind: "ready", data: ready };
}

/** Lists tasks, newest first, cursor-paginated by the previous response. */
export async function fetchTasks(options?: {
  limit?: number;
  before?: string;
}): Promise<TaskList> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.before) params.set("before", options.before);
  const query = params.toString();
  return (await getJson(`/tasks${query ? `?${query}` : ""}`)) as TaskList;
}

/** Fetches a single task with its timeline and attempts. */
export async function fetchTaskDetail(id: string): Promise<TaskDetail> {
  return (await getJson(`/tasks/${encodeURIComponent(id)}`)) as TaskDetail;
}

/** Fetches model role policies + provider account names (no secrets). */
export async function fetchProviders(): Promise<ProviderOverview> {
  return (await getJson("/providers")) as ProviderOverview;
}

export type SubjectResult = {
  subjectType: "issue" | "pr";
  subjectNumber: number;
  repositoryFullName: string;
  revision: string;
  result: unknown;
  published: boolean;
  createdAt: string;
};

export type ResultList = {
  items: SubjectResult[];
  nextCursor?: string;
};

/** Lists persisted issue/PR results, newest first, cursor-paginated. */
export async function fetchResults(
  type: "issue" | "pr",
  before?: string,
): Promise<ResultList> {
  const params = new URLSearchParams({ type });
  if (before) params.set("before", before);
  return (await getJson(`/results?${params.toString()}`)) as ResultList;
}