import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { loadConfig } from "../../../packages/config/src/index.js";
import {
  analysisTasks,
  checkDatabase,
  checkRedis,
  closeRedisClient,
  createDatabaseClient,
  createRedisClient,
  ingestGitHubWebhook,
  modelRolePolicies,
  providerAccounts,
  subjectResults,
  taskAttempts,
  taskEvents,
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
  createLogger,
  withCorrelation,
} from "../../../packages/observability/src/index.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);

/** Open SSE connections so shutdown can end them and exit cleanly. */
const sseClients = new Set<ServerResponse>();

/** Routes that require the WebUI bearer token when it is configured. */
const protectedPaths = ["/tasks", "/results", "/providers", "/events"];
const EVENT_CHANNEL = "apertureprism:task:events";

/** Auth is disabled when WEBUI_API_TOKEN is unset (open dev / intranet mode). */
function isAuthorized(request: IncomingMessage): boolean {
  if (!config.webuiApiToken) return true;
  let token: string | null = null;
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer "))
    token = header.slice(7);
  if (token === null) {
    const url = new URL(request.url ?? "/", "http://localhost");
    token = url.searchParams.get("token");
  }
  if (token === null || token.length === 0) return false;
  return (
    token.length === config.webuiApiToken.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(config.webuiApiToken))
  );
}

const requiresAuth = (path: string): boolean =>
  protectedPaths.some(
    (base) => path === base || path.startsWith(`${base}/`),
  );

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
  if (!config.githubWebhookSecret) {
    json(
      response,
      503,
      { status: "error", reason: "GitHub webhook is not configured" },
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
      config.githubWebhookSecret,
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
let eventSubscriber: Awaited<ReturnType<typeof redis.duplicate>> | null = null;
let eventPublisher: Awaited<ReturnType<typeof redis.duplicate>> | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let pumpTimer: ReturnType<typeof setInterval> | null = null;

/** Writes one SSE frame to every open client. */
function broadcastSse(seq: number, type: string, data: unknown): void {
  const frame = serializeSseEvent({ seq, type, data });
  for (const client of sseClients) client.write(frame);
}

/** Keeps an SSE connection open; frames are broadcast by the shared relay. */
function handleSse(response: ServerResponse): void {
  response.writeHead(200, SSE_HEADERS);
  response.write(": connected\n\n");
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
      taskId: taskEvents.taskId,
      eventType: taskEvents.eventType,
      data: taskEvents.data,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .where(eventWatermark ? gt(taskEvents.createdAt, eventWatermark) : undefined)
    .orderBy(asc(taskEvents.createdAt))
    .limit(200);
  for (const row of rows) {
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
    if (eventPublisher) await eventPublisher.publish(EVENT_CHANNEL, JSON.stringify(evt));
  }
  if (rows.length > 0 && rows[rows.length - 1]?.createdAt)
    eventWatermark = rows[rows.length - 1]?.createdAt ?? null;
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

  if (!id) {
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    const beforeRaw = url.searchParams.get("before");
    const before =
      beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;
    const items = await database.db
      .select(taskSummaryColumns)
      .from(analysisTasks)
      .where(before ? lt(analysisTasks.createdAt, before) : undefined)
      .orderBy(desc(analysisTasks.createdAt))
      .limit(limit);
    const last = items.at(-1)?.createdAt;
    const nextCursor =
      items.length === limit && last ? last.toISOString() : undefined;
    json(
      response,
      200,
      nextCursor === undefined ? { items } : { items, nextCursor },
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
    json(response, 404, { status: "error", reason: "task not found" }, requestId);
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
    json(response, 400, { status: "error", reason: "type=issue|pr required" }, requestId);
    return;
  }
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 25;
  const beforeRaw = url.searchParams.get("before");
  const before =
    beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;
  const items = await database.db
    .select(resultColumns)
    .from(subjectResults)
    .where(
      and(
        eq(subjectResults.subjectType, type),
        before ? lt(subjectResults.createdAt, before) : undefined,
      ),
    )
    .orderBy(desc(subjectResults.createdAt))
    .limit(limit);
  const last = items.at(-1)?.createdAt;
  const nextCursor =
    items.length === limit && last ? last.toISOString() : undefined;
  json(
    response,
    200,
    nextCursor === undefined ? { items } : { items, nextCursor },
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

  if (requiresAuth(path) && !isAuthorized(request)) {
    json(
      response,
      401,
      { status: "error", reason: "unauthorized" },
      requestId,
    );
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
    handleSse(response);
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
    server.listen(config.port, config.host, () =>
      logger.info({ host: config.host, port: config.port }, "API listening"),
    );
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, "failed to start event stream");
    process.exitCode = 1;
  });
