import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { handleBotStart, handleBotStatus, handleBotStop, runBotctl } from "./botctl.js";

type SpawnResult = ReturnType<typeof spawnSync>;

const spawnSyncMock = vi.mocked(spawnSync);

/** 构造一个带 string stdout/stderr 的 spawnSync 结果（encoding: utf8）。 */
function spawnResult(partial: {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}): SpawnResult {
  return {
    pid: 1,
    output: [null, partial.stdout ?? "", partial.stderr ?? ""],
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? "",
    status: partial.status,
    signal: null,
    error: partial.error,
  } as unknown as SpawnResult;
}

function makeResponse() {
  let status = 0;
  let body = "";
  const response = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: unknown) => {
      body = String(chunk ?? "");
    },
  } as unknown as ServerResponse;
  return {
    response,
    status: () => status,
    body: () => body,
  };
}

describe("runBotctl", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok + trimmed stdout on success and passes the action", () => {
    spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: "running\n" }));
    const result = runBotctl("status");
    expect(result).toEqual({ ok: true, output: "running", code: 0 });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/bin/sh",
      [expect.stringContaining("botctl.sh"), "status"],
      expect.objectContaining({ encoding: "utf8", timeout: 30_000 }),
    );
  });

  it("falls back to stderr when stdout is empty", () => {
    spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: "boom\n" }));
    const result = runBotctl("start");
    expect(result).toEqual({ ok: false, output: "boom", code: 1 });
  });

  it("maps timeout errors to a readable failure", () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({
        status: null,
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      }),
    );
    const result = runBotctl("stop");
    expect(result).toEqual({ ok: false, output: "botctl timed out", code: null });
  });
});

describe("bot handlers", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET /bot/status returns 200 with the container state on success", async () => {
    spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: "running" }));
    const res = makeResponse();
    await handleBotStatus(res.response, "req-1");
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({ status: "running", ok: true });
  });

  it("GET /bot/status returns 502 when the script fails", async () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({ status: 1, stderr: "permission denied" }),
    );
    const res = makeResponse();
    await handleBotStatus(res.response, "req-2");
    expect(res.status()).toBe(502);
    expect(JSON.parse(res.body())).toEqual({ status: "unknown", ok: false });
  });

  it("POST /bot/start surfaces the failure reason as 502", async () => {
    spawnSyncMock.mockReturnValue(
      spawnResult({ status: 2, stderr: "compose not found" }),
    );
    const res = makeResponse();
    await handleBotStart(res.response, "req-3");
    expect(res.status()).toBe(502);
    expect(JSON.parse(res.body())).toEqual({
      status: "error",
      reason: "bot_start_failed",
      detail: "compose not found",
      code: 2,
    });
  });

  it("POST /bot/stop returns 200 ok on success", async () => {
    spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: "stopped" }));
    const res = makeResponse();
    await handleBotStop(res.response, "req-4");
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({ status: "ok", detail: "stopped" });
  });
});
