import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTasks, rerunTasks } from "../lib/api";
import { onUnauthorized } from "../lib/auth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 手动取消任务 API 封装（cancelTasks）与既有的 rerunTasks 共用同一套
 * 401/403/错误原因解析契约，这里一并锁定，防止后续改动破坏取消流程。
 */
describe("cancelTasks", () => {
  const fetchMock = vi.fn();
  let unauthorizedSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    unauthorizedSpy = vi.fn();
    onUnauthorized(unauthorizedSpy);
    localStorage.clear();
  });

  afterEach(() => {
    onUnauthorized(null);
  });

  it("POST 正确的 body 到 /tasks/cancel 并返回取消/跳过计数", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok", canceled: 2, skipped: 1 }));
    const result = await cancelTasks(["task-a", "task-b", "task-c"]);
    expect(result).toEqual({ status: "ok", canceled: 2, skipped: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/tasks/cancel");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      taskIds: ["task-a", "task-b", "task-c"],
    });
  });

  it("已登录时附带 Authorization: Bearer token", async () => {
    localStorage.setItem("apertureprism.token", "secret-token");
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok", canceled: 0, skipped: 0 }));
    await cancelTasks(["task-a"]);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)?.authorization).toBe(
      "Bearer secret-token",
    );
  });

  it("401 触发全局未授权回调并抛 unauthorized", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    await expect(cancelTasks(["task-a"])).rejects.toThrow("unauthorized");
    expect(unauthorizedSpy).toHaveBeenCalledTimes(1);
  });

  it("403 抛可读的管理员权限提示", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    await expect(cancelTasks(["task-a"])).rejects.toThrow("需要管理员权限（403）");
  });

  it("非 2xx 时透传后端 reason", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "error", reason: "invalid JSON" }, 400),
    );
    await expect(cancelTasks(["task-a"])).rejects.toThrow("invalid JSON");
  });

  it("响应体不是 JSON 时回退为通用错误消息", async () => {
    fetchMock.mockResolvedValue(new Response("<!doctype html>", { status: 500 }));
    await expect(cancelTasks(["task-a"])).rejects.toThrow("cancel tasks 500");
  });
});

describe("rerunTasks", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    localStorage.clear();
  });

  it("POST /tasks/rerun 并返回 rerun/skipped 计数", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok", rerun: 1, skipped: 0 }));
    const result = await rerunTasks(["task-x"]);
    expect(result).toEqual({ status: "ok", rerun: 1, skipped: 0 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/tasks/rerun");
    expect(JSON.parse(String(init?.body))).toEqual({ taskIds: ["task-x"] });
  });
});
