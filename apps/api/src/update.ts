import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../../packages/database/src/schema.js";
import { serializeSseEvent } from "../../../packages/event-stream/src/index.js";

/* ---------- GitHub Container Registry version check ----------
   Public images can be queried anonymously via the Docker Registry HTTP API:
     GET https://ghcr.io/v2/bb0813/apertureprism-ai-review/<svc>/tags/list
     GET https://ghcr.io/v2/.../<svc>/manifests/<tag>  -> Docker-Content-Digest
   No read:packages token required. */

const REGISTRY_HOST = "ghcr.io";
const REGISTRY_BASE = "bb0813/apertureprism-ai-review";
const UPDATE_SERVICES = [
  "api",
  "web",
  "analysis-worker",
  "index-worker",
  "scheduler",
  "scan-worker",
  "migrate",
  "qq-bot",
] as const;
const TARGET_PATTERN = /^v?\d+\.\d+\.\d+$|^latest$|^stable$/;
const HISTORY_SETTING_KEY = "update_history";

export type UpdateHistoryEntry = {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
};

export function isValidUpdateTarget(target: string): boolean {
  return TARGET_PATTERN.test(target);
}

let cachedPackageVersion: string | null = null;

/**
 * In-image version fallback: reads the root package.json version once so the
 * UI can always show a real version, even when compose does not inject
 * IMAGE_TAG / UPDATE_VERSION.
 */
function packageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    cachedPackageVersion = pkg.version ? `v${pkg.version}` : "unknown";
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

/** Current running version, injected by compose as IMAGE_TAG / UPDATE_VERSION. */
export function currentVersion(): string {
  const value = process.env.UPDATE_VERSION ?? process.env.IMAGE_TAG ?? "";
  const trimmed = value.trim();
  if (trimmed.length > 0 && trimmed !== "latest") return trimmed;
  return packageVersion();
}

async function registryToken(service: string): Promise<string> {
  const url =
    `https://${REGISTRY_HOST}/token?service=${REGISTRY_HOST}` +
    `&scope=repository:${REGISTRY_BASE}/${service}:pull`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`registry token ${response.status}`);
  const data = (await response.json()) as { token?: string; access_token?: string };
  return data.token ?? data.access_token ?? "";
}

async function registryTags(service: string): Promise<string[]> {
  const token = await registryToken(service);
  const url = `https://${REGISTRY_HOST}/v2/${REGISTRY_BASE}/${service}/tags/list`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": "apertureprism-updater",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`registry ${response.status}`);
  const data = (await response.json()) as { tags?: string[] };
  return data.tags ?? [];
}

async function registryDigest(service: string, tag: string): Promise<string | null> {
  const token = await registryToken(service);
  const url = `https://${REGISTRY_HOST}/v2/${REGISTRY_BASE}/${service}/manifests/${encodeURIComponent(tag)}`;
  const response = await fetch(url, {
    headers: {
      accept:
        "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      authorization: `Bearer ${token}`,
      "user-agent": "apertureprism-updater",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  return response.headers.get("docker-content-digest");
}

function compareVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Sorted distinct semver tags (vX.Y.Z) across the main services, newest first. */
async function fetchLatestTags(): Promise<string[]> {
  const seen = new Set<string>();
  for (const service of UPDATE_SERVICES) {
    try {
      for (const tag of await registryTags(service)) {
        if (/^v?\d+\.\d+\.\d+$/.test(tag)) seen.add(tag);
      }
    } catch {
      // one service failing should not fail the whole check
    }
  }
  return [...seen].sort((a, b) => compareVersion(b, a));
}

/** Handles GET /update/status — current vs latest version comparison. */
export async function handleUpdateStatus(
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const current = currentVersion();
  try {
    const tags = await fetchLatestTags();
    const latestTag = tags[0];
    const latestDigest = latestTag ? await registryDigest("web", latestTag) : null;
    const currentDigest =
      current !== "unknown" ? await registryDigest("web", current) : null;
    json(
      response,
      200,
      {
        current: {
          version: current,
          composeProject:
            process.env.COMPOSE_PROJECT_NAME ?? "apertureprism-ai-review",
        },
        latest: {
          tags: tags.slice(0, 10),
          version: latestTag ?? null,
          digest: latestDigest,
        },
        updateAvailable: Boolean(
          latestTag &&
            current !== latestTag &&
            latestDigest &&
            latestDigest !== currentDigest,
        ),
        updateChannel: "latest",
      },
      requestId,
    );
  } catch {
    json(
      response,
      503,
      { status: "error", reason: "registry_unreachable", degraded: true },
      requestId,
    );
  }
}

/* ---------- update execution ---------- */

const UPDATE_SCRIPT_PATH = process.env.UPDATE_SCRIPT ?? "/app/scripts/update.sh";
let updateRunning = false;

/**
 * Executes the in-container update script, streaming each JSON line to the
 * SSE client as `log` events and finishing with a `done` event. `onDone` runs
 * once the script exits (success or rollback) so history can be recorded.
 */
async function runUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  target: string,
  backupBefore: boolean,
  onDone: (ok: boolean, reason: string | undefined) => void,
): Promise<void> {
  if (updateRunning) {
    json(response, 409, { status: "error", reason: "update_in_progress" }, requestId);
    return;
  }
  updateRunning = true;
  const previous = currentVersion();
  let seq = 0;
  const push = (level: string, message: string): void => {
    seq += 1;
    response.write(serializeSseEvent({ seq, type: "log", data: { level, message } }));
  };
  const done = (ok: boolean, reason: string | undefined): void => {
    response.write(
      serializeSseEvent({
        seq: seq + 1,
        type: "done",
        data: ok
          ? { ok, previous, applied: target }
          : { ok, previous, applied: target, reason },
      }),
    );
    response.end();
    onDone(ok, reason);
  };

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": requestId,
  });
  response.write(": update stream\n\n");

  const args = [
    "--target", target,
    "--project", process.env.COMPOSE_PROJECT_NAME ?? "apertureprism-ai-review",
    "--api", `http://127.0.0.1:${process.env.PORT ?? "30001"}`,
    "--token", process.env.WEBUI_API_TOKEN ?? "",
    ...(backupBefore ? ["--backup"] : []),
  ];

  const child = spawn("/bin/sh", [UPDATE_SCRIPT_PATH, ...args], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handleChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          level?: string;
          stage?: string;
          message?: string;
        };
        // update.sh emits {"level":"stage","stage":"backup","message":"备份配置"}
        // so the WebUI can advance a progress bar instead of only dumping logs.
        if (parsed.level === "stage") {
          seq += 1;
          response.write(
            serializeSseEvent({
              seq,
              type: "stage",
              data: { stage: parsed.stage ?? "unknown", message: parsed.message ?? "" },
            }),
          );
        } else {
          push(parsed.level ?? "info", parsed.message ?? trimmed);
        }
      } catch {
        push("info", trimmed);
      }
    }
  };
  child.stdout.on("data", handleChunk);
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed) push("warn", trimmed);
    }
  });

  child.on("error", (error) => {
    updateRunning = false;
    push("error", `无法启动更新脚本：${error.message}`);
    done(false, "script_start_failed");
  });

  child.on("close", (code) => {
    updateRunning = false;
    const ok = code === 0;
    push(ok ? "info" : "error", ok ? `更新完成（${target}）` : `更新脚本退出码 ${code}`);
    done(ok, ok ? undefined : `script_exit_${code}`);
  });

  response.on("close", () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    updateRunning = false;
  });
}

/** Handles POST /update/apply — admin only, SSE log stream. */
export async function handleUpdateApply(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  isAdmin: boolean,
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  if (!isAdmin) {
    json(response, 403, { status: "error", reason: "admin required" }, requestId);
    return;
  }
  const body = await readBody(request);
  let parsed: { target?: unknown; backupBefore?: unknown } = {};
  try {
    parsed = JSON.parse(body.toString("utf8") || "{}");
  } catch {
    json(response, 400, { status: "error", reason: "invalid JSON" }, requestId);
    return;
  }
  const target = typeof parsed.target === "string" ? parsed.target : "latest";
  if (!isValidUpdateTarget(target)) {
    json(response, 400, { status: "error", reason: "invalid target" }, requestId);
    return;
  }
  const backupBefore = parsed.backupBefore !== false;
  await runUpdate(request, response, requestId, target, backupBefore, (ok, reason) => {
    void writeHistory(db, {
      at: new Date().toISOString(),
      from: currentVersion(),
      to: target,
      ok,
      ...(reason ? { reason } : {}),
    });
  });
}

/** Handles GET /update/history — admin only. */
export async function handleUpdateHistory(
  response: ServerResponse,
  requestId: string,
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  try {
    const rows = await db
      .select({ value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, HISTORY_SETTING_KEY))
      .limit(1);
    const items = rows[0]?.value
      ? (JSON.parse(rows[0].value) as UpdateHistoryEntry[])
      : [];
    json(response, 200, { items }, requestId);
  } catch {
    json(response, 200, { items: [] }, requestId);
  }
}

async function writeHistory(
  db: PostgresJsDatabase<typeof schema>,
  entry: UpdateHistoryEntry,
): Promise<void> {
  try {
    const rows = await db
      .select({ value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, HISTORY_SETTING_KEY))
      .limit(1);
    const existing = rows[0]?.value
      ? (JSON.parse(rows[0].value) as UpdateHistoryEntry[])
      : [];
    const next = [entry, ...existing].slice(0, 50);
    await db
      .insert(schema.systemSettings)
      .values({ key: HISTORY_SETTING_KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({
        target: schema.systemSettings.key,
        set: { value: JSON.stringify(next), updatedAt: new Date() },
      });
  } catch {
    // history persistence is best-effort
  }
}

/* ---------- helpers ---------- */

function json(response: ServerResponse, status: number, body: unknown, requestId: string): void {
  response.writeHead(status, {
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
