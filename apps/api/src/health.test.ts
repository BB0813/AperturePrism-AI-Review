import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const UNCONFIGURED_PORT = 43211;
const CONFIGURED_PORT = 43212;
const WEBHOOK_SECRET = "test-webhook-secret";

type ServerHandle = { process: ChildProcess; baseUrl: string };

type ServerOptions = {
  port: number;
  webhookSecret?: string;
};

function startServer({
  port,
  webhookSecret,
}: ServerOptions): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/apps/api/src/main.js"], {
      cwd: resolvePath(process.cwd(), "apps/api"),
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: "postgresql://prism:secret@127.0.0.1:1/prism",
        REDIS_URL: "redis://127.0.0.1:1",
        HEALTH_CHECK_TIMEOUT_MS: "200",
        ...(webhookSecret ? { GITHUB_WEBHOOK_SECRET: webhookSecret } : {}),
      },
      stdio: "ignore",
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    let settled = false;
    const cleanup = () => {
      clearInterval(readinessCheck);
      clearTimeout(startupTimeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ process: child, baseUrl });
    };
    const readinessCheck = setInterval(() => {
      void fetch(`${baseUrl}/health/live`)
        .then((response) => {
          if (response.ok) finish();
        })
        .catch(() => undefined);
    }, 100);
    // Loading drizzle and the task engine over a network share is slow, so the
    // budget reflects measured cold-start rather than an optimistic guess.
    const startupTimeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`API did not start on port ${port}`));
    }, 90_000);

    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled)
        finish(new Error(`API exited before listening with code ${code}`));
    });
  });
}

async function stopServer(handle: ServerHandle | undefined): Promise<void> {
  if (!handle) return;
  handle.process.kill("SIGTERM");
  await new Promise<void>((resolve) =>
    handle.process.once("exit", () => resolve()),
  );
}

async function fetchJson(
  handle: ServerHandle,
  path: string,
  method = "GET",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${handle.baseUrl}${path}`, { method });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("API endpoints", () => {
  let unconfiguredServer: ServerHandle;
  let configuredServer: ServerHandle;

  beforeAll(async () => {
    [unconfiguredServer, configuredServer] = await Promise.all([
      startServer({ port: UNCONFIGURED_PORT }),
      startServer({
        port: CONFIGURED_PORT,
        webhookSecret: WEBHOOK_SECRET,
      }),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([
      stopServer(unconfiguredServer),
      stopServer(configuredServer),
    ]);
  });

  it("returns ok on /health/live regardless of dependencies", async () => {
    const { status } = await fetchJson(unconfiguredServer, "/health/live");
    expect(status).toBe(200);
  });

  it("/health/ready reports 503 when database and redis are unavailable", async () => {
    const { status, body } = await fetchJson(
      unconfiguredServer,
      "/health/ready",
    );
    expect(status).toBe(503);
    const deps = body.dependencies as {
      database: { status: string };
      redis: { status: string };
    };
    expect(deps.database.status).toBe("error");
    expect(deps.redis.status).toBe("error");
  });

  it("returns 404 for unknown routes", async () => {
    const { status } = await fetchJson(unconfiguredServer, "/nope");
    expect(status).toBe(404);
  });

  it("returns 503 when the webhook secret is not configured", async () => {
    const response = await fetch(
      `${unconfiguredServer.baseUrl}/github/webhook`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(response.status).toBe(503);
  });

  it("returns 401 for an invalid signature", async () => {
    const response = await fetch(`${configuredServer.baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=invalid",
        "x-github-delivery": "delivery-1",
        "x-github-event": "ping",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("returns 400 when GitHub headers are missing", async () => {
    const body = "{}";
    const signature = createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
    const response = await fetch(`${configuredServer.baseUrl}/github/webhook`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${signature}` },
      body,
    });
    expect(response.status).toBe(400);
  });

  it("returns 405 for non-POST requests", async () => {
    const response = await fetch(`${configuredServer.baseUrl}/github/webhook`);
    expect(response.status).toBe(405);
  });
});
