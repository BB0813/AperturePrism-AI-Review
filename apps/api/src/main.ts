import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { loadConfig } from "../../../packages/config/src/index.js";
import {
  analysisTasks,
  applyBackupSnapshot,
  buildBackupSnapshot,
  checkDatabase,
  checkRedis,
  closeRedisClient,
  createDatabaseClient,
  createRedisClient,
  ingestGitHubWebhook,
  issueDocuments,
  modelRolePolicies,
  providerAccounts,
  repositories,
  subjectResults,
  systemSettings,
  taskAttempts,
  taskEvents,
  webhookDeliveries,
} from "../../../packages/database/src/index.js";
import {
  normalizeGitHubEvent,
  verifyWebhookSignature,
  WebhookSignatureError,
} from "../../../packages/github-adapter/src/index.js";
import { ISSUE_ANALYSIS_POLICY_VERSION } from "../../../packages/issue-analysis/src/index.js";
import {
  serializeSseEvent,
  SSE_HEADERS,
} from "../../../packages/event-stream/src/index.js";
import { PR_REVIEW_POLICY_VERSION } from "../../../packages/pr-review/src/index.js";
import {
  extractIssueSignals,
  normalizedIndexText,
  recallCandidatesWithRepos,
  type SqlTag,
} from "../../../packages/duplicate-detection/src/index.js";
import {
  createLogger,
  withCorrelation,
} from "../../../packages/observability/src/index.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);

/* ---------- GitHub OAuth (progressive; enabled when configured) ---------- */
const oauthClientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? "";
const oauthClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** In-memory OAuth `state` → expiry, verified in the callback. */
const oauthStates = new Map<string, number>();

function oauthConfigured(): boolean {
  return Boolean(oauthClientId && oauthClientSecret);
}

/** Stable HMAC key for signing session tokens (derived from OAuth creds). */
function sessionKey(): Buffer {
  return createHash("sha256")
    .update(`${oauthClientSecret}:${oauthClientId}`)
    .digest();
}

function signSession(login: string): string {
  const payload = Buffer.from(
    JSON.stringify({ login, exp: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  const sig = createHmac("sha256", sessionKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function parseSessionToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", sessionKey()).update(payload).digest();
  const received = Buffer.from(sig);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return null;
  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      login?: unknown;
      exp?: unknown;
    };
    if (typeof data.login !== "string") return null;
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data.login;
  } catch {
    return null;
  }
}

/* ---------- runtime settings (hot-reload overrides) ---------- */
const SETTINGS_POLL_MS = 8_000;
const SECRET_SETTING_KEYS = new Set([
  "webui_api_token",
  "github_webhook_secret",
]);
const ALLOWED_SETTING_KEYS = new Set([
  "webui_api_token",
  "github_webhook_secret",
  "github_webhook_enabled",
  "log_level",
]);

const runtimeSettings = new Map<string, string>();

/** Syncs the in-memory override map from the `system_settings` table. */
async function refreshRuntimeSettings(): Promise<void> {
  try {
    const rows = await database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings);
    runtimeSettings.clear();
    for (const row of rows) runtimeSettings.set(row.key, row.value);
    logger.level = runtimeSettings.get("log_level") ?? config.logLevel;
    logger.debug(
      { keys: rows.map((row) => row.key), count: rows.length },
      "runtime settings refreshed",
    );
  } catch (error) {
    logger.warn({ err: error }, "runtime settings refresh failed");
  }
}

function startRuntimeSettings(): void {
  void refreshRuntimeSettings();
  setInterval(() => void refreshRuntimeSettings(), SETTINGS_POLL_MS);
}

/** Effective WebUI token: settings override; falls back to env/./env.example. */
function webuiToken(): string {
  const override = runtimeSettings.get("webui_api_token");
  if (override && override.trim().length > 0) return override;
  return config.webuiApiToken ?? "";
}

/** Effective webhook secret + enabled flag, both runtime-overridable. */
function webhookSecret(): string {
  const override = runtimeSettings.get("github_webhook_secret");
  if (override && override.trim().length > 0) return override;
  return config.githubWebhookSecret ?? "";
}
function webhookEnabled(): boolean {
  const override = runtimeSettings.get("github_webhook_enabled");
  if (override !== undefined && override !== "") return override === "true";
  return Boolean(config.githubWebhookSecret);
}

/** Open SSE connections so shutdown can end them and exit cleanly. */
const sseClients = new Set<ServerResponse>();

/* ---------- per-IP in-memory rate limiting (sliding token bucket) ---------- */
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { tokens: number; last: number }>();

/**
 * Returns true when the client has exceeded the per-minute budget. The bucket
 * refills fully each window; the map is pruned once it grows beyond a bound so
 * a hostile flood of source IPs cannot leak memory indefinitely.
 */
function rateLimited(ip: string, limit: number, now: number): boolean {
  if (rateBuckets.size > 10_000) {
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.last >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.last >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { tokens: Math.max(limit - 1, 0), last: now });
    return false;
  }
  if (bucket.tokens <= 0) return true;
  bucket.tokens -= 1;
  return false;
}

function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0)
    return forwarded.split(",")[0]!.trim();
  return request.socket.remoteAddress ?? "unknown";
}

/** Routes that require the WebUI bearer token when it is configured. */
const protectedPaths = [
  "/tasks",
  "/summary",
  "/results",
  "/providers",
  "/repositories",
  "/logs",
  "/vector",
  "/index",
  "/backup",
  "/config",
  "/settings",
  "/events",
];
const EVENT_CHANNEL = "apertureprism:task:events";

/** Auth is disabled when no WebUI token is configured (open dev / intranet mode). */
function isAuthorized(request: IncomingMessage): boolean {
  const expected = webuiToken();
  if (!expected) return true;
  let token: string | null = null;
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    token = header.slice(7);
  if (token === null) {
    const url = new URL(request.url ?? "/", "http://localhost");
    token = url.searchParams.get("token");
  }
  if (token === null || token.length === 0) return false;
  if (
    token.length === expected.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  )
    return true;
  // GitHub OAuth session tokens are also accepted when OAuth is configured.
  return oauthConfigured() && parseSessionToken(token) !== null;
}

const requiresAuth = (path: string): boolean =>
  protectedPaths.some((base) => path === base || path.startsWith(`${base}/`));

function json(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  requestId: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function handleWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (!webhookEnabled()) {
    json(
      response,
      503,
      { status: "error", reason: "GitHub webhook is not enabled" },
      requestId,
    );
    return;
  }
  const body = await readBody(request);
  try {
    verifyWebhookSignature(
      body,
      typeof request.headers["x-hub-signature-256"] === "string"
        ? request.headers["x-hub-signature-256"]
        : undefined,
      webhookSecret(),
    );
    const deliveryId = request.headers["x-github-delivery"]?.toString();
    const eventName = request.headers["x-github-event"]?.toString();
    if (!deliveryId || !eventName) {
      json(
        response,
        400,
        { status: "error", reason: "missing GitHub webhook headers" },
        requestId,
      );
      return;
    }
    const normalized = normalizeGitHubEvent(
      eventName,
      deliveryId,
      JSON.parse(body.toString("utf8")),
    );
    const policyVersion =
      normalized.eventName === "pull_request"
        ? PR_REVIEW_POLICY_VERSION
        : ISSUE_ANALYSIS_POLICY_VERSION;
    const result = await ingestGitHubWebhook(
      database.db,
      normalized,
      policyVersion,
    );
    const duplicate = result.outcome === "delivery_duplicate";
    json(
      response,
      duplicate ? 200 : 202,
      {
        status: "accepted",
        duplicate,
        outcome: result.outcome,
        ...("taskId" in result ? { taskId: result.taskId } : {}),
      },
      requestId,
    );
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      json(
        response,
        401,
        { status: "error", reason: "invalid webhook signature" },
        requestId,
      );
      return;
    }
    if (error instanceof SyntaxError) {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON payload" },
        requestId,
      );
      return;
    }
    throw error;
  }
}

/** Monotonic sequence for SSE frames so clients can detect gaps. */
let sseSeq = 0;
/** Watermark of the last task_events row already dispatched. */
let eventWatermark: Date | null = null;
/**
 * Ids of task_events rows already dispatched. task_events has no monotonic
 * cursor column, and many events share the same createdAt millisecond, so a
 * pure createdAt watermark would re-emit the same rows every pump until a
 * newer event arrives. Deduping by row id keeps the relay exactly-once.
 */
const dispatchedEventIds = new Set<string>();
/** Bound on dispatchedEventIds so the watermark alone drives long-running pumps. */
const DISPATCHED_ID_CAP = 5_000;
let eventSubscriber: Awaited<ReturnType<typeof redis.duplicate>> | null = null;
let eventPublisher: Awaited<ReturnType<typeof redis.duplicate>> | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let pumpTimer: ReturnType<typeof setInterval> | null = null;

/** Writes one SSE frame to every open client. */
function broadcastSse(seq: number, type: string, data: unknown): void {
  const frame = serializeSseEvent({ seq, type, data });
  for (const client of sseClients) client.write(frame);
}

/**
 * Keeps an SSE connection open; frames are broadcast by the shared relay.
 * `?since=<iso>` replays historical task events created after the bookmark
 * before going live, so a reconnect can backfill events missed while offline.
 */
async function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, SSE_HEADERS);
  response.write(": connected\n\n");

  const url = new URL(request.url ?? "/", "http://localhost");
  const sinceRaw = url.searchParams.get("since");
  if (sinceRaw && !Number.isNaN(Date.parse(sinceRaw))) {
    try {
      const since = new Date(sinceRaw);
      const rows = await database.db
        .select({
          id: taskEvents.id,
          taskId: taskEvents.taskId,
          eventType: taskEvents.eventType,
          data: taskEvents.data,
          createdAt: taskEvents.createdAt,
        })
        .from(taskEvents)
        .where(gt(taskEvents.createdAt, since))
        .orderBy(asc(taskEvents.createdAt))
        .limit(500);
      for (const row of rows) {
        sseSeq += 1;
        response.write(
          serializeSseEvent({
            seq: sseSeq,
            type: "task",
            data: {
              taskId: row.taskId,
              eventType: row.eventType,
              data: row.data,
              createdAt: row.createdAt,
              replayed: true,
            },
          }),
        );
      }
      logger.debug(
        { replayed: rows.length, since: sinceRaw },
        "SSE replay sent",
      );
    } catch (error) {
      logger.warn({ err: error }, "SSE replay failed; going live");
    }
  }

  sseClients.add(response);
  response.on("close", () => {
    sseClients.delete(response);
  });
}

/**
 * The event relay: poll `task_events` for new lifecycle events, publish them to
 * Redis, and forward every published frame to the open SSE clients. Best-effort:
 * if Redis or the database is unavailable the relay degrades to heartbeats only
 * and the API still starts.
 */
async function startEventStream(): Promise<void> {
  let relay = false;
  try {
    eventSubscriber = redis.duplicate();
    eventSubscriber.on("error", () => undefined);
    eventSubscriber.on("message", (_channel, message) => {
      try {
        const parsed = JSON.parse(message) as {
          seq: number;
          type: string;
          data: unknown;
        };
        const frame = serializeSseEvent(parsed);
        for (const client of sseClients) client.write(frame);
      } catch {
        // ignore malformed frames
      }
    });
    await eventSubscriber.connect();
    await eventSubscriber.subscribe(EVENT_CHANNEL);

    eventPublisher = redis.duplicate();
    eventPublisher.on("error", () => undefined);
    await eventPublisher.connect();
    relay = true;
  } catch (error) {
    logger.warn({ err: error }, "event relay disabled: Redis unavailable");
    eventSubscriber?.disconnect();
    eventPublisher?.disconnect();
    eventSubscriber = null;
    eventPublisher = null;
  }

  try {
    const max = await database.db
      .select({ at: taskEvents.createdAt })
      .from(taskEvents)
      .orderBy(desc(taskEvents.createdAt))
      .limit(1);
    eventWatermark = max[0]?.at ?? null;
  } catch {
    eventWatermark = null;
  }

  hbTimer = setInterval(() => {
    sseSeq += 1;
    broadcastSse(sseSeq, "heartbeat", { at: new Date().toISOString() });
  }, 15_000);

  if (relay) {
    pumpTimer = setInterval(() => {
      void pumpTaskEvents().catch((error: unknown) => {
        logger.warn({ err: error }, "task event pump failed");
      });
    }, 1_000);
  }
}

async function pumpTaskEvents(): Promise<void> {
  const rows = await database.db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      eventType: taskEvents.eventType,
      data: taskEvents.data,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .where(
      eventWatermark ? gt(taskEvents.createdAt, eventWatermark) : undefined,
    )
    .orderBy(asc(taskEvents.createdAt))
    .limit(200);
  let newest: Date | null = eventWatermark;
  for (const row of rows) {
    if (dispatchedEventIds.has(row.id)) continue;
    dispatchedEventIds.add(row.id);
    if (dispatchedEventIds.size > DISPATCHED_ID_CAP) {
      // Drop the oldest ids so the set stays bounded; the createdAt watermark
      // may briefly re-emit a colliding batch, which the client tolerates.
      const oldest = dispatchedEventIds.values().next().value;
      if (oldest !== undefined) dispatchedEventIds.delete(oldest);
    }
    sseSeq += 1;
    const evt = {
      seq: sseSeq,
      type: "task",
      data: {
        taskId: row.taskId,
        eventType: row.eventType,
        data: row.data,
        createdAt: row.createdAt,
      },
    };
    if (eventPublisher)
      await eventPublisher.publish(EVENT_CHANNEL, JSON.stringify(evt));
    if (!newest || row.createdAt > newest) newest = row.createdAt;
  }
  if (newest) eventWatermark = newest;
}

async function stopEventStream(): Promise<void> {
  if (hbTimer) clearInterval(hbTimer);
  if (pumpTimer) clearInterval(pumpTimer);
  for (const client of sseClients) client.end();
  sseClients.clear();
  if (eventSubscriber) {
    try {
      await eventSubscriber.unsubscribe(EVENT_CHANNEL);
      await eventSubscriber.quit();
    } catch {
      eventSubscriber.disconnect();
    }
  }
  if (eventPublisher) {
    try {
      await eventPublisher.quit();
    } catch {
      eventPublisher.disconnect();
    }
  }
}

/** Column set shared by the list and detail views (payload is heavy). */
const taskSummaryColumns = {
  id: analysisTasks.id,
  taskType: analysisTasks.taskType,
  repositoryId: analysisTasks.repositoryId,
  subjectNumber: analysisTasks.subjectNumber,
  subjectRevision: analysisTasks.subjectRevision,
  policyVersion: analysisTasks.policyVersion,
  status: analysisTasks.status,
  priority: analysisTasks.priority,
  attemptCount: analysisTasks.attemptCount,
  maxAttempts: analysisTasks.maxAttempts,
  lastErrorCategory: analysisTasks.lastErrorCategory,
  createdAt: analysisTasks.createdAt,
  updatedAt: analysisTasks.updatedAt,
} as const;

/**
 * Lists tasks (cursor-paginated by creation time, newest first) or returns a
 * single task by id. Public reads for the WebUI; no secrets are exposed (the
 * task payload is only included in the detail view).
 */
async function handleTasks(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;
  const id = path.startsWith("/tasks/")
    ? decodeURIComponent(path.slice("/tasks/".length)).trim()
    : null;

  // A well-formed task id is a UUID. Guard the detail lookup so a short or
  // malformed id (e.g. /tasks/1) returns 404 instead of a Postgres uuid parse
  // error bubbling up as a 500.
  if (
    id &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }

  if (!id) {
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    // Offset pagination is stable even when many rows share the same
    // createdAt millisecond (a pure createdAt cursor would skip duplicates).
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    const items = await database.db
      .select(taskSummaryColumns)
      .from(analysisTasks)
      .orderBy(desc(analysisTasks.createdAt), desc(analysisTasks.id))
      .limit(limit)
      .offset(offset);
    const nextOffset = items.length === limit ? offset + limit : undefined;
    json(
      response,
      200,
      nextOffset === undefined ? { items } : { items, nextOffset },
      requestId,
    );
    return;
  }

  const rows = await database.db
    .select({ ...taskSummaryColumns, payload: analysisTasks.payload })
    .from(analysisTasks)
    .where(eq(analysisTasks.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    json(
      response,
      404,
      { status: "error", reason: "task not found" },
      requestId,
    );
    return;
  }
  const [timeline, attempts] = await Promise.all([
    database.db
      .select({
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, id))
      .orderBy(asc(taskEvents.createdAt))
      .limit(200),
    database.db
      .select({
        attemptNumber: taskAttempts.attemptNumber,
        workerId: taskAttempts.workerId,
        startedAt: taskAttempts.startedAt,
        finishedAt: taskAttempts.finishedAt,
        errorCategory: taskAttempts.errorCategory,
      })
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, id))
      .orderBy(asc(taskAttempts.attemptNumber)),
  ]);
  json(response, 200, { ...row, timeline, attempts }, requestId);
}

/** Model role policies + configured provider account names (never the keys). */
async function handleProviders(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [policies, accounts] = await Promise.all([
    database.db
      .select({
        role: modelRolePolicies.role,
        version: modelRolePolicies.version,
        candidates: modelRolePolicies.candidates,
        createdAt: modelRolePolicies.createdAt,
      })
      .from(modelRolePolicies)
      .orderBy(asc(modelRolePolicies.role)),
    database.db
      .select({ name: providerAccounts.name })
      .from(providerAccounts)
      .orderBy(asc(providerAccounts.name)),
  ]);
  json(
    response,
    200,
    { policies, accounts: accounts.map((account) => account.name) },
    requestId,
  );
}

/** Aggregated counts for the WebUI overview KPIs (status/type/result totals). */
async function handleSummary(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [byStatus, byType, resultCounts] = await Promise.all([
    database.sql<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM analysis_tasks GROUP BY status
    `,
    database.sql<{ task_type: string; count: number }[]>`
      SELECT task_type, count(*)::int AS count FROM analysis_tasks GROUP BY task_type
    `,
    database.sql<{ subject_type: string; count: number }[]>`
      SELECT subject_type, count(*)::int AS count
      FROM subject_results WHERE published = true GROUP BY subject_type
    `,
  ]);
  const total = byStatus.reduce((sum, row) => sum + Number(row.count), 0);
  json(
    response,
    200,
    {
      tasks: {
        total,
        byStatus: Object.fromEntries(
          byStatus.map((row) => [row.status, Number(row.count)]),
        ),
        byType: Object.fromEntries(
          byType.map((row) => [row.task_type, Number(row.count)]),
        ),
      },
      results: {
        issue: Number(
          resultCounts.find((row) => row.subject_type === "issue")?.count ?? 0,
        ),
        pr: Number(
          resultCounts.find((row) => row.subject_type === "pr")?.count ?? 0,
        ),
      },
    },
    requestId,
  );
}

/** Installed GitHub repositories with per-repo task/result counts. */
async function handleRepositories(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [repos, taskCounts, resultCounts] = await Promise.all([
    database.db
      .select({
        id: repositories.id,
        githubId: repositories.githubId,
        owner: repositories.owner,
        name: repositories.name,
        createdAt: repositories.createdAt,
      })
      .from(repositories)
      .orderBy(asc(repositories.name)),
    database.sql<{ repository_id: string; c: number }[]>`
      SELECT repository_id, count(*)::int AS c FROM analysis_tasks
      WHERE repository_id IS NOT NULL GROUP BY repository_id
    `,
    database.sql<{ repository_full_name: string; c: number }[]>`
      SELECT repository_full_name, count(*)::int AS c FROM subject_results GROUP BY repository_full_name
    `,
  ]);
  const taskByRepo = new Map(
    taskCounts.map((r) => [r.repository_id, Number(r.c)]),
  );
  const resultByName = new Map(
    resultCounts.map((r) => [r.repository_full_name, Number(r.c)]),
  );
  // A repo may have been ingested more than once (different GitHub ids from
  // separate webhook deliveries); merge by full name for a clean list.
  const byName = new Map<
    string,
    {
      id: string;
      owner: string;
      taskCount: number;
      resultCount: number;
      createdAt: Date;
    }
  >();
  for (const repo of repos) {
    const fullName = `${repo.owner}/${repo.name}`;
    const existing = byName.get(fullName);
    const taskCount = taskByRepo.get(repo.id) ?? 0;
    const resultCount = resultByName.get(fullName) ?? 0;
    if (!existing) {
      byName.set(fullName, {
        id: repo.id,
        owner: repo.owner,
        taskCount,
        resultCount,
        createdAt: repo.createdAt,
      });
    } else {
      existing.taskCount += taskCount;
      existing.resultCount = Math.max(existing.resultCount, resultCount);
    }
  }
  json(
    response,
    200,
    {
      items: [...byName.entries()].map(([fullName, info]) => ({
        id: info.id,
        owner: info.owner,
        name: fullName.split("/")[1] ?? fullName,
        fullName,
        taskCount: info.taskCount,
        resultCount: info.resultCount,
        createdAt: info.createdAt,
      })),
    },
    requestId,
  );
}

/**
 * Activity log. Three modes driven by query params:
 *  - default: recent events (60) + webhook deliveries (30) — diagnostic bundle.
 *  - ?history=1&offset=N&limit=M: offset-paginated historical events.
 *  - ?since=<iso>: events created after `since` (resume from a bookmark).
 */
async function handleLogs(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  const sinceRaw = url.searchParams.get("since");
  const isHistory = url.searchParams.get("history") === "1";

  if (isHistory) {
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(Math.trunc(offsetRaw), 0)
      : 0;
    const events = await database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id))
      .limit(limit)
      .offset(offset);
    const nextOffset = events.length === limit ? offset + limit : undefined;
    json(
      response,
      200,
      nextOffset === undefined
        ? { events, deliveries: [] }
        : { events, deliveries: [], nextOffset },
      requestId,
    );
    return;
  }

  if (sinceRaw && !Number.isNaN(Date.parse(sinceRaw))) {
    const since = new Date(sinceRaw);
    const events = await database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .where(gt(taskEvents.createdAt, since))
      .orderBy(asc(taskEvents.createdAt))
      .limit(500);
    json(response, 200, { events, deliveries: [] }, requestId);
    return;
  }

  const [events, deliveries] = await Promise.all([
    database.db
      .select({
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        data: taskEvents.data,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .orderBy(desc(taskEvents.createdAt))
      .limit(60),
    database.db
      .select({
        eventName: webhookDeliveries.eventName,
        status: webhookDeliveries.processingStatus,
        outcomeReason: webhookDeliveries.outcomeReason,
        receivedAt: webhookDeliveries.receivedAt,
      })
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(30),
  ]);
  json(response, 200, { events, deliveries }, requestId);
}

/** Vector/duplicate-index stats from issue_documents (nvidia/nv-embed-v1). */
async function handleVector(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [stats, repoCoverage, lastIndex] = await Promise.all([
    database.sql<
      { docs: number; with_embedding: number; with_signals: number }[]
    >`
      SELECT count(*)::int AS docs,
             count(embedding)::int AS with_embedding,
             count(*) FILTER (WHERE cardinality(error_codes) > 0)::int AS with_signals
      FROM issue_documents
    `,
    database.sql<{ repositories: number }[]>`
      SELECT count(DISTINCT repository_id)::int AS repositories
      FROM issue_documents WHERE repository_id IS NOT NULL
    `,
    database.sql<{ at: Date | null }[]>`
      SELECT max(indexed_at) AS at FROM issue_documents
    `,
  ]);
  const row = stats[0];
  json(
    response,
    200,
    {
      documents: row?.docs ?? 0,
      withEmbedding: row?.with_embedding ?? 0,
      withSignals: row?.with_signals ?? 0,
      repositoryCoverage: repoCoverage[0]?.repositories ?? 0,
      embeddingModel: config.embedding.model,
      embeddingConfigured: Boolean(
        config.embedding.baseUrl && config.embedding.apiKey,
      ),
      lastIndexedAt: lastIndex[0]?.at ?? null,
    },
    requestId,
  );
}

/** Requests an immediate index pass by writing the index_trigger setting. */
async function handleIndexRun(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    await database.db
      .insert(systemSettings)
      .values({ key: "index_trigger", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
    json(response, 200, { status: "ok", triggered: true }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "index trigger failed");
    json(
      response,
      500,
      { status: "error", reason: "trigger_failed" },
      requestId,
    );
  }
}

/** Index health: last worker pass summary + pending trigger/rebuild flags. */
async function handleIndexStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const [rows, pending] = await Promise.all([
    database.db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "index_last_pass"))
      .limit(1),
    database.db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(
        or(
          eq(systemSettings.key, "index_trigger"),
          eq(systemSettings.key, "index_rebuild"),
        ),
      )
      .limit(5),
  ]);
  const raw = rows[0]?.value;
  let lastPass: unknown = null;
  if (raw) {
    try {
      lastPass = JSON.parse(raw);
    } catch {
      lastPass = null;
    }
  }
  const keys = new Set(pending.map((row) => row.key));
  json(
    response,
    200,
    {
      lastPass,
      pendingTrigger: keys.has("index_trigger"),
      pendingRebuild: keys.has("index_rebuild"),
    },
    requestId,
  );
}

/** Full index rebuild: clears issue_documents and triggers a fresh pass. */
async function handleIndexRebuild(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    await database.db.delete(issueDocuments);
    await database.db
      .insert(systemSettings)
      .values({ key: "index_rebuild", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });
    json(response, 200, { status: "ok", rebuilt: true }, requestId);
  } catch (error) {
    logger.warn({ err: error }, "index rebuild failed");
    json(
      response,
      500,
      { status: "error", reason: "rebuild_failed" },
      requestId,
    );
  }
}

/** Read-only RAG recall: candidates similar to a lead issue, never decides. */
async function handleIndexRelated(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const title = url.searchParams.get("title") ?? "";
  const body = url.searchParams.get("body") ?? "";
  const topK = Math.min(
    Math.max(Number(url.searchParams.get("topK")) || 5, 1),
    20,
  );
  if (title.length === 0 && body.length === 0) {
    json(
      response,
      400,
      { status: "error", reason: "title or body required" },
      requestId,
    );
    return;
  }
  try {
    const signals = extractIssueSignals({ title, body, labels: [] });
    const candidates = await recallCandidatesWithRepos(
      database.sql as unknown as SqlTag,
      {
        title: normalizedIndexText({ title, body: "" }),
        body: normalizedIndexText({ title, body }),
        signals,
        topK,
      },
    );
    json(response, 200, { candidates }, requestId);
  } catch (error) {
    // Index unavailable is a degrade-not-fail condition for the caller.
    logger.warn({ err: error }, "index recall failed");
    json(response, 200, { candidates: [], degraded: true }, requestId);
  }
}

/** Config backup: exports settings + policies (secrets masked, no keys). */
async function handleBackupExport(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    const snapshot = await buildBackupSnapshot(database.db);
    json(response, 200, snapshot, requestId);
  } catch (error) {
    logger.warn({ err: error }, "backup export failed");
    json(response, 500, { status: "error", reason: "export_failed" }, requestId);
  }
}

/** Config restore: applies non-secret settings + policies from a snapshot. */
async function handleBackupImport(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await readBody(request);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(body.toString("utf8"));
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  try {
    const result = await applyBackupSnapshot(database.db, snapshot);
    json(response, 200, { status: "ok", ...result }, requestId);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 120) : "import_failed";
    json(response, 400, { status: "error", reason }, requestId);
  }
}

/** Non-secret runtime configuration snapshot (no keys, no secrets). */
async function handleConfig(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const modelProviders = Object.keys(config.modelProviderBaseUrls);
  json(
    response,
    200,
    {
      host: config.host,
      port: config.port,
      logLevel: config.logLevel,
      githubWebhookConfigured: Boolean(config.githubWebhookSecret),
      githubAppConfigured: Boolean(
        config.githubAppId && config.githubAppPrivateKeyPath,
      ),
      webuiAuthEnabled: Boolean(config.webuiApiToken),
      modelProviders,
      embeddingModel: config.embedding.model,
      embeddingConfigured: Boolean(
        config.embedding.baseUrl && config.embedding.apiKey,
      ),
      qqBotProtocols: Object.keys(config.qqBotProtocols),
      qqOfficialConfigured: Boolean(
        config.qqOfficialAppId && config.qqOfficialAppSecret,
      ),
      oauthConfigured: oauthConfigured(),
      oauthEnabled: oauthConfigured() && webuiToken().length === 0,
    },
    requestId,
  );
}

/** Runtime settings: GET lists (secret values masked); PUT upserts a key. */
async function handleSettings(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  if (request.method === "PUT") {
    const body = await readBody(request);
    let parsed: { key?: unknown; value?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      json(
        response,
        400,
        { status: "error", reason: "invalid JSON" },
        requestId,
      );
      return;
    }
    const key = typeof parsed.key === "string" ? parsed.key : null;
    if (!key || !ALLOWED_SETTING_KEYS.has(key)) {
      json(
        response,
        400,
        { status: "error", reason: "unsupported_setting_key" },
        requestId,
      );
      return;
    }
    const value = typeof parsed.value === "string" ? parsed.value : "";
    await database.db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
    await refreshRuntimeSettings();
    json(response, 200, { status: "ok", key }, requestId);
    return;
  }

  const rows = await database.db
    .select({
      key: systemSettings.key,
      value: systemSettings.value,
      updatedAt: systemSettings.updatedAt,
    })
    .from(systemSettings)
    .orderBy(asc(systemSettings.key));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const known = [
    "webui_api_token",
    "github_webhook_secret",
    "github_webhook_enabled",
    "log_level",
  ];
  const items = known.map((key) => {
    const row = byKey.get(key);
    const hasValue = Boolean(row && row.value.trim().length > 0);
    const masked = SECRET_SETTING_KEYS.has(key) && hasValue;
    return {
      key,
      hasValue,
      value: masked ? "••••••••" : hasValue ? (row?.value ?? "") : "",
      updatedAt: row?.updatedAt ?? null,
    };
  });
  json(response, 200, { items }, requestId);
}

/** GitHub OAuth entry: /auth/status, /auth/login (redirect), /auth/callback. */
async function handleAuth(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/auth/status") {
    json(response, 200, { oauthConfigured: oauthConfigured() }, requestId);
    return;
  }

  if (path === "/auth/login") {
    if (!oauthConfigured()) {
      json(
        response,
        503,
        { status: "error", reason: "oauth_not_configured" },
        requestId,
      );
      return;
    }
    const state = randomUUID();
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const authorizeUrl =
      `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(oauthClientId)}` +
      `&scope=read:user&state=${state}`;
    response.writeHead(302, { Location: authorizeUrl });
    response.end();
    return;
  }

  if (path === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const exp = state ? oauthStates.get(state) : undefined;
    if (!state || exp === undefined || exp < Date.now()) {
      oauthStates.delete(state ?? "");
      response.writeHead(302, { Location: "/#/?oauth_error=bad_state" });
      response.end();
      return;
    }
    oauthStates.delete(state);
    if (!code) {
      response.writeHead(302, { Location: "/#/?oauth_error=missing_code" });
      response.end();
      return;
    }
    try {
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: oauthClientId,
            client_secret: oauthClientSecret,
            code,
          }),
        },
      );
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
      };
      if (typeof tokenJson.access_token !== "string")
        throw new Error(tokenJson.error ?? "no_access_token");
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${tokenJson.access_token}`,
          "user-agent": "apertureprism",
        },
      });
      const user = (await userRes.json()) as { login?: string };
      if (typeof user.login !== "string") throw new Error("no_login");
      const session = signSession(user.login);
      response.writeHead(302, {
        Location: `/#/?token=${encodeURIComponent(session)}`,
      });
      response.end();
    } catch {
      response.writeHead(302, { Location: "/#/?oauth_error=login_failed" });
      response.end();
    }
    return;
  }

  json(response, 404, { status: "error", reason: "not_found" }, requestId);
}

/* ---------- install wizard / one-click init ---------- */
const DEFAULT_POLICIES = [
  { role: "issue_analysis", version: "issue-analysis-v1" },
  { role: "pr_review", version: "pr-review-v1" },
  { role: "duplicate_judgment", version: "duplicate-judgment-v1" },
] as const;

async function tableCount(names: string[]): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${names})
  `;
  return rows[0]?.n ?? 0;
}

/** Setup diagnostics (public; shown by the install wizard before login). */
async function handleSetupStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  let dbOk = false;
  let tablesReady = 0;
  let providerCount = 0;
  let policyCount = 0;
  try {
    const h = await checkDatabase(database.sql, config.healthCheckTimeoutMs);
    dbOk = h.status === "ok";
    tablesReady = dbOk
      ? await tableCount([
          "analysis_tasks",
          "task_events",
          "subject_results",
          "system_settings",
          "model_role_policies",
          "provider_accounts",
        ])
      : 0;
    if (dbOk) {
      const [p, pol] = await Promise.all([
        database.db
          .select({ id: providerAccounts.id })
          .from(providerAccounts)
          .limit(100),
        database.db
          .select({ id: modelRolePolicies.id })
          .from(modelRolePolicies)
          .limit(100),
      ]);
      providerCount = p.length;
      policyCount = pol.length;
    }
  } catch {
    dbOk = false;
  }
  const providerKey = Object.keys(config.modelProviderBaseUrls)[0] ?? "";
  json(
    response,
    200,
    {
      database: { ok: dbOk, tablesReady, tablesTotal: 6 },
      provider: {
        count: providerCount,
        providerKey,
        model: "deepseek-v4-flash",
      },
      policies: { count: policyCount, required: DEFAULT_POLICIES.length },
      githubWebhookConfigured: Boolean(config.githubWebhookSecret),
      githubAppConfigured: Boolean(
        config.githubAppId && config.githubAppPrivateKeyPath,
      ),
      oauthConfigured: oauthConfigured(),
      embeddingConfigured: Boolean(
        config.embedding.baseUrl && config.embedding.apiKey,
      ),
      initialized:
        dbOk && tablesReady === 6 && policyCount >= DEFAULT_POLICIES.length,
    },
    requestId,
  );
}

/** One-click init: seed default model role policies if none exist. */
async function handleSetupInit(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  try {
    const existing = await database.db
      .select({ id: modelRolePolicies.id })
      .from(modelRolePolicies)
      .limit(1);
    if (existing.length > 0) {
      json(
        response,
        200,
        { status: "ok", created: 0, reason: "already_initialized" },
        requestId,
      );
      return;
    }
    const providerKey = Object.keys(config.modelProviderBaseUrls)[0] ?? "";
    const accounts = await database.db
      .select({ name: providerAccounts.name })
      .from(providerAccounts)
      .limit(1);
    const accountName = accounts[0]?.name;
    const created = [];
    if (providerKey && accountName) {
      for (const policy of DEFAULT_POLICIES) {
        await database.db.insert(modelRolePolicies).values({
          role: policy.role,
          version: policy.version,
          candidates: [
            { provider: providerKey, model: "deepseek-v4-flash", accountName },
          ],
        });
        created.push(policy.role);
      }
    }
    json(
      response,
      200,
      {
        status: "ok",
        created: created.length,
        roles: created,
        skipped:
          created.length === 0
            ? "model provider/account not configured"
            : undefined,
      },
      requestId,
    );
  } catch (error) {
    logger.warn({ err: error }, "setup init failed");
    json(response, 500, { status: "error", reason: "init_failed" }, requestId);
  }
}

const resultColumns = {
  subjectType: subjectResults.subjectType,
  subjectNumber: subjectResults.subjectNumber,
  repositoryFullName: subjectResults.repositoryFullName,
  revision: subjectResults.revision,
  result: subjectResults.result,
  published: subjectResults.published,
  createdAt: subjectResults.createdAt,
} as const;

/**
 * Lists persisted results by type (`/results?type=issue|pr`) or all revisions
 * for one subject (`/results/:type/:number`). Used by the WebUI result pages.
 */
async function handleResults(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

  // /results/:type/:number -> all revisions of one subject
  if (path.startsWith("/results/")) {
    const parts = path.split("/").filter(Boolean);
    const type = parts[1];
    const number = Number(parts[2]);
    if ((type !== "issue" && type !== "pr") || !Number.isInteger(number)) {
      json(
        response,
        400,
        { status: "error", reason: "invalid result path" },
        requestId,
      );
      return;
    }
    const items = await database.db
      .select(resultColumns)
      .from(subjectResults)
      .where(
        and(
          eq(subjectResults.subjectType, type),
          eq(subjectResults.subjectNumber, number),
        ),
      )
      .orderBy(desc(subjectResults.createdAt))
      .limit(50);
    json(response, 200, { items }, requestId);
    return;
  }

  // /results?type=issue|pr
  const type = url.searchParams.get("type");
  if (type !== "issue" && type !== "pr") {
    json(
      response,
      400,
      { status: "error", reason: "type=issue|pr required" },
      requestId,
    );
    return;
  }
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 25;
  // Offset pagination avoids skipping rows that share a createdAt millisecond.
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(Math.trunc(offsetRaw), 0)
    : 0;
  const items = await database.db
    .select(resultColumns)
    .from(subjectResults)
    .where(eq(subjectResults.subjectType, type))
    .orderBy(desc(subjectResults.createdAt), desc(subjectResults.id))
    .limit(limit)
    .offset(offset);
  const nextOffset = items.length === limit ? offset + limit : undefined;
  json(
    response,
    200,
    nextOffset === undefined ? { items } : { items, nextOffset },
    requestId,
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
  const requestLogger = withCorrelation(logger, { requestId });
  const path = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  ).pathname;
  const ip = clientIp(request);
  const now = Date.now();

  // Webhook flood protection is independent of the WebUI API budget.
  if (
    path === "/github/webhook" &&
    rateLimited(ip, config.webhookRateLimit, now)
  ) {
    json(response, 429, { status: "error", reason: "rate_limited" }, requestId);
    requestLogger.warn({ ip }, "webhook rate limited");
    return;
  }

  if (requiresAuth(path) && rateLimited(ip, config.apiRateLimit, now)) {
    json(response, 429, { status: "error", reason: "rate_limited" }, requestId);
    requestLogger.warn({ ip, path }, "api rate limited");
    return;
  }

  if (requiresAuth(path) && !isAuthorized(request)) {
    json(response, 401, { status: "error", reason: "unauthorized" }, requestId);
    return;
  }

  if (
    path === "/auth/status" ||
    path === "/auth/login" ||
    path === "/auth/callback"
  ) {
    await handleAuth(request, response, requestId);
    return;
  }

  if (path === "/setup/status") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleSetupStatus(response, requestId);
    return;
  }

  if (path === "/setup/init") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleSetupInit(response, requestId);
    return;
  }

  if (path === "/github/webhook") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleWebhook(request, response, requestId);
    return;
  }

  if (path === "/events") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    handleSse(request, response);
    return;
  }

  if (path === "/settings") {
    await handleSettings(request, response, requestId);
    return;
  }

  if (path === "/index/run" || path === "/index/rebuild") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    if (path === "/index/rebuild") {
      await handleIndexRebuild(response, requestId);
    } else {
      await handleIndexRun(response, requestId);
    }
    return;
  }

  if (path === "/index/status") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleIndexStatus(response, requestId);
    return;
  }

  if (path === "/index/related") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleIndexRelated(request, response, requestId);
    return;
  }

  if (path === "/backup/import") {
    if (request.method !== "POST") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleBackupImport(request, response, requestId);
    return;
  }

  if (path === "/backup") {
    if (request.method !== "GET") {
      json(
        response,
        405,
        { status: "error", reason: "method not allowed" },
        requestId,
      );
      return;
    }
    await handleBackupExport(response, requestId);
    return;
  }

  if (request.method !== "GET") {
    json(
      response,
      405,
      { status: "error", reason: "method not allowed" },
      requestId,
    );
    return;
  }

  if (path === "/summary") {
    await handleSummary(response, requestId);
    return;
  }

  if (path === "/repositories") {
    await handleRepositories(response, requestId);
    return;
  }

  if (path === "/logs") {
    await handleLogs(request, response, requestId);
    return;
  }

  if (path === "/vector") {
    await handleVector(response, requestId);
    return;
  }

  if (path === "/config") {
    await handleConfig(response, requestId);
    return;
  }

  if (path === "/tasks" || path.startsWith("/tasks/")) {
    await handleTasks(request, response, requestId);
    return;
  }

  if (path === "/providers") {
    await handleProviders(response, requestId);
    return;
  }

  if (path === "/results" || path.startsWith("/results/")) {
    await handleResults(request, response, requestId);
    return;
  }

  if (path === "/health/live") {
    json(
      response,
      200,
      { status: "ok", service: "apertureprism-api" },
      requestId,
    );
    return;
  }

  if (path === "/health/ready") {
    const [databaseHealth, redisHealth] = await Promise.all([
      checkDatabase(database.sql, config.healthCheckTimeoutMs),
      checkRedis(redis, config.healthCheckTimeoutMs),
    ]);
    const ready = databaseHealth.status === "ok" && redisHealth.status === "ok";
    json(
      response,
      ready ? 200 : 503,
      {
        status: ready ? "ok" : "error",
        dependencies: { database: databaseHealth, redis: redisHealth },
      },
      requestId,
    );
    return;
  }

  json(response, 404, { status: "error", reason: "not found" }, requestId);
  requestLogger.debug({ path }, "request not found");
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    logger.error({ err: error }, "request failed");
    if (!response.headersSent)
      json(
        response,
        500,
        { status: "error", reason: "internal server error" },
        randomUUID(),
      );
    else response.destroy();
  });
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await stopEventStream();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRedisClient(redis);
  await database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void startEventStream()
  .then(() => {
    startRuntimeSettings();
    server.listen(config.port, config.host, () =>
      logger.info({ host: config.host, port: config.port }, "API listening"),
    );
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, "failed to start event stream");
    process.exitCode = 1;
  });
