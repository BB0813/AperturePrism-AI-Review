import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { loadConfig } from "../../../packages/config/src/index.js";
import {
  checkDatabase,
  checkRedis,
  closeRedisClient,
  createDatabaseClient,
  createRedisClient,
  ingestGitHubWebhook,
} from "../../../packages/database/src/index.js";
import {
  normalizeGitHubEvent,
  verifyWebhookSignature,
  WebhookSignatureError,
} from "../../../packages/github-adapter/src/index.js";
import { ISSUE_ANALYSIS_POLICY_VERSION } from "../../../packages/issue-analysis/src/index.js";
import {
  createLogger,
  withCorrelation,
} from "../../../packages/observability/src/index.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const database = createDatabaseClient(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);

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
    const result = await ingestGitHubWebhook(
      database.db,
      normalized,
      ISSUE_ANALYSIS_POLICY_VERSION,
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

  if (request.method !== "GET") {
    json(
      response,
      405,
      { status: "error", reason: "method not allowed" },
      requestId,
    );
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRedisClient(redis);
  await database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
server.listen(config.port, config.host, () =>
  logger.info({ host: config.host, port: config.port }, "API listening"),
);
