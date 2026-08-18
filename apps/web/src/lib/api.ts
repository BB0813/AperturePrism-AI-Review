import { authHeaders } from "./auth";

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
  nextOffset?: number;
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

export type Summary = {
  tasks: { total: number; byStatus: Record<string, number>; byType: Record<string, number> };
  results: { issue: number; pr: number };
};

export const STATUS_ORDER = [
  "running",
  "queued",
  "publishing",
  "completed",
  "failed",
  "retry_wait",
  "canceled",
] as const;

/** Aggregated task + result counts for the overview KPIs. */
export async function fetchSummary(): Promise<Summary> {
  return (await getJson("/summary")) as Summary;
}

export type Repository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  taskCount: number;
  resultCount: number;
  createdAt: string;
};

export type RepositoryList = { items: Repository[] };

/** Lists installed GitHub repos + per-repo task/result counts. */
export async function fetchRepositories(): Promise<RepositoryList> {
  return (await getJson("/repositories")) as RepositoryList;
}

export type LogEvent = {
  taskId: string;
  eventType: string;
  data: unknown;
  createdAt: string;
};
export type DeliveryEntry = {
  eventName: string;
  status: string;
  outcomeReason: string | null;
  receivedAt: string;
};
export type AuditLog = { events: LogEvent[]; deliveries: DeliveryEntry[] };
export type HistoryPage = { events: LogEvent[]; deliveries: DeliveryEntry[]; nextOffset?: number };

/** Diagnostic bundle: recent events + webhook deliveries. */
export async function fetchLogs(): Promise<AuditLog> {
  return (await getJson("/logs")) as AuditLog;
}

/** Offset-paginated historical task events (newest first). */
export async function fetchLogHistory(offset: number, limit = 50): Promise<HistoryPage> {
  return (await getJson(`/logs?history=1&offset=${offset}&limit=${limit}`)) as HistoryPage;
}

/** Events created after a bookmark (resume-from-breakpoint). */
export async function fetchLogsSince(since: string): Promise<AuditLog> {
  return (await getJson(`/logs?since=${encodeURIComponent(since)}`)) as AuditLog;
}

export type VectorStats = {
  documents: number;
  withEmbedding: number;
  withSignals: number;
  repositoryCoverage: number;
  embeddingModel: string;
  embeddingConfigured: boolean;
};

/** Duplicate-index / vector-store stats from issue_documents. */
export async function fetchVectorStats(): Promise<VectorStats> {
  return (await getJson("/vector")) as VectorStats;
}

export type RuntimeConfig = {
  host: string;
  port: number;
  logLevel: string;
  githubWebhookConfigured: boolean;
  githubAppConfigured: boolean;
  webuiAuthEnabled: boolean;
  modelProviders: string[];
  embeddingModel: string;
  embeddingConfigured: boolean;
  qqBotProtocols: string[];
  qqOfficialConfigured: boolean;
  oauthConfigured: boolean;
  oauthEnabled: boolean;
};

/** Non-secret runtime configuration snapshot. */
export async function fetchConfig(): Promise<RuntimeConfig> {
  return (await getJson("/config")) as RuntimeConfig;
}

export type SettingItem = {
  key: string;
  hasValue: boolean;
  value: string;
  updatedAt: string | null;
};
export type SettingsList = { items: SettingItem[] };

/** Runtime-overridable settings. Secret values come back masked. */
export async function fetchSettings(): Promise<SettingsList> {
  return (await getJson("/settings")) as SettingsList;
}

/** Upserts a runtime setting; it hot-applies without a restart. */
export async function saveSetting(key: string, value: string): Promise<void> {
  await putJson("/settings", { key, value });
}

export type OAuthStatus = { oauthConfigured: boolean };

/** Whether GitHub OAuth login is wired up (unauthenticated endpoint). */
export async function fetchOAuthStatus(): Promise<OAuthStatus> {
  const response = await fetch("/auth/status", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return { oauthConfigured: false };
  return (await response.json()) as OAuthStatus;
}

export type SetupStatus = {
  database: { ok: boolean; tablesReady: number; tablesTotal: number };
  provider: { count: number; providerKey: string; model: string };
  policies: { count: number; required: number };
  githubWebhookConfigured: boolean;
  githubAppConfigured: boolean;
  oauthConfigured: boolean;
  embeddingConfigured: boolean;
  initialized: boolean;
};

/** Install wizard diagnostics (public endpoint). */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  const response = await fetch("/setup/status", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`setup status ${response.status}`);
  return (await response.json()) as SetupStatus;
}

export type SetupInitResult = {
  status: string;
  created: number;
  roles?: string[];
  reason?: string;
  skipped?: string;
};

/** One-click init: seed default model policies when uninitialized. */
export async function setupInit(): Promise<SetupInitResult> {
  const response = await fetch("/setup/init", { method: "POST" });
  if (!response.ok) throw new Error(`setup init ${response.status}`);
  return (await response.json()) as SetupInitResult;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) {
    const reason = response.status === 404 ? "not found" : `request failed with ${response.status}`;
    throw new Error(reason);
  }
  return response.json();
}

async function putJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) {
    const reason = response.status === 404 ? "not found" : `request failed with ${response.status}`;
    throw new Error(reason);
  }
}

/** Fetches both liveness and readiness; the UI shows a clear error on failure. */
export async function fetchHealth(): Promise<HealthResult> {
  const live = (await getJson("/health/live")) as { status?: string };
  if (live.status !== "ok") throw new Error("liveness check failed");
  const ready = (await getJson("/health/ready")) as ReadyHealth;
  return { kind: "ready", data: ready };
}

/** Lists tasks, newest first, offset-paginated by the previous response. */
export async function fetchTasks(options?: {
  limit?: number;
  offset?: number;
}): Promise<TaskList> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
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
  nextOffset?: number;
};

/** Lists persisted issue/PR results, newest first, offset-paginated. */
export async function fetchResults(
  type: "issue" | "pr",
  offset?: number,
): Promise<ResultList> {
  const params = new URLSearchParams({ type });
  if (offset !== undefined) params.set("offset", String(offset));
  return (await getJson(`/results?${params.toString()}`)) as ResultList;
}