import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 任务页只关心页面行为：api 层全部 mock（与 repos-page 测试同模式）。
vi.mock("../lib/api", () => ({
  bumpCache: vi.fn(),
  cancelTasks: vi.fn(async () => ({ status: "ok", canceled: 1, skipped: 0 })),
  fetchTasks: vi.fn(async () => ({ items: [] })),
  rerunTasks: vi.fn(async () => ({ status: "ok", rerun: 1, skipped: 0 })),
}));

import { ToastProvider } from "../components/Toast";
import type { TaskSummary } from "../lib/api";
const { TasksPage, CANCELABLE_STATUS } = await import("../pages/TasksPage");
const api = await import("../lib/api");

const fetchTasks = vi.mocked(api.fetchTasks);
const cancelTasks = vi.mocked(api.cancelTasks);
const rerunTasks = vi.mocked(api.rerunTasks);

function task(id: string, status: string, subject: number): TaskSummary {
  return {
    id,
    taskType: "issue_analysis",
    repositoryId: "repo-1",
    subjectNumber: subject,
    subjectRevision: "rev",
    policyVersion: "issue-analysis-v1",
    status,
    priority: 0,
    attemptCount: 1,
    maxAttempts: 3,
    lastErrorCategory: null,
    createdAt: "2026-08-21T10:00:00Z",
    updatedAt: "2026-08-21T10:00:00Z",
  };
}

function rowOf(subject: number): HTMLElement {
  const cell = screen.getByText(`#${subject}`);
  const row = cell.closest("tr");
  if (!row) throw new Error(`row #${subject} not found`);
  return row;
}

function renderPage() {
  return render(
    <ToastProvider>
      <TasksPage />
    </ToastProvider>,
  );
}

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
  fetchTasks.mockReset();
  cancelTasks.mockReset();
  rerunTasks.mockReset();
  cancelTasks.mockResolvedValue({ status: "ok", canceled: 1, skipped: 0 });
  rerunTasks.mockResolvedValue({ status: "ok", rerun: 1, skipped: 0 });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * 手动取消运行中任务的回归测试：列表里非终态任务出现「取消」按钮、
 * 单行取消与批量取消都走 cancelTasks、终态任务不可取消、原有「重新执行」
 * 不受影响。
 */
describe("任务队列页取消按钮", () => {
  it("CANCELABLE_STATUS 覆盖后端可取消的活跃状态（含 leased）", () => {
    expect([...CANCELABLE_STATUS].sort()).toEqual([
      "leased",
      "publishing",
      "queued",
      "retry_wait",
      "running",
    ]);
  });

  it("运行中/排队任务显示「取消」按钮，已完成/失败任务不显示", async () => {
    fetchTasks.mockResolvedValue({
      items: [
        task("task-running", "running", 1),
        task("task-queued", "queued", 2),
        task("task-completed", "completed", 3),
        task("task-failed", "failed", 4),
      ],
    });
    renderPage();
    expect(await screen.findByText("#1")).toBeTruthy();

    expect(within(rowOf(1)).getByRole("button", { name: /^取消$/ })).toBeTruthy();
    expect(within(rowOf(2)).getByRole("button", { name: /^取消$/ })).toBeTruthy();
    expect(within(rowOf(3)).queryByRole("button", { name: /^取消$/ })).toBeNull();
    expect(within(rowOf(4)).queryByRole("button", { name: /^取消$/ })).toBeNull();
  });

  it("已完成任务的复选框禁用（不可选中取消）", async () => {
    fetchTasks.mockResolvedValue({
      items: [task("task-running", "running", 1), task("task-done", "completed", 2)],
    });
    renderPage();
    await screen.findByText("#1");
    expect(within(rowOf(1)).getByRole("checkbox")).not.toBeDisabled();
    expect(within(rowOf(2)).getByRole("checkbox")).toBeDisabled();
  });

  it("点击单行「取消」→ 确认后调用 cancelTasks 且只传该任务", async () => {
    fetchTasks.mockResolvedValue({ items: [task("task-running", "running", 1)] });
    renderPage();
    await screen.findByText("#1");
    await userEvent.click(within(rowOf(1)).getByRole("button", { name: /^取消$/ }));
    expect(cancelTasks).toHaveBeenCalledWith(["task-running"]);
    // 成功 toast + 重新拉取列表
    expect(await screen.findByText(/已取消 1 个任务/)).toBeTruthy();
    expect(fetchTasks).toHaveBeenCalledTimes(2);
  });

  it("确认被拒绝时不发起取消", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    fetchTasks.mockResolvedValue({ items: [task("task-running", "running", 1)] });
    renderPage();
    await screen.findByText("#1");
    await userEvent.click(within(rowOf(1)).getByRole("button", { name: /^取消$/ }));
    expect(cancelTasks).not.toHaveBeenCalled();
  });

  it("勾选运行中任务后可批量「取消（N）」", async () => {
    fetchTasks.mockResolvedValue({
      items: [
        task("task-running", "running", 1),
        task("task-queued", "queued", 2),
        task("task-done", "completed", 3),
      ],
    });
    renderPage();
    await screen.findByText("#1");

    await userEvent.click(within(rowOf(1)).getByRole("checkbox"));
    const batchCancel = screen.getByRole("button", { name: "取消（1）" });
    await userEvent.click(batchCancel);
    expect(cancelTasks).toHaveBeenCalledWith(["task-running"]);
    expect(await screen.findByText(/已取消 1 个任务/)).toBeTruthy();
  });

  it("批量取消只传选中的可取消任务，不混入已完成任务", async () => {
    fetchTasks.mockResolvedValue({
      items: [
        task("task-queued", "queued", 1),
        task("task-done", "completed", 2),
      ],
    });
    renderPage();
    await screen.findByText("#1");
    // 只有 queued 可勾选；completed 复选框禁用，无法被选中
    await userEvent.click(within(rowOf(1)).getByRole("checkbox"));
    expect(screen.queryByRole("button", { name: /^取消（2）$/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "取消（1）" }));
    expect(cancelTasks).toHaveBeenCalledWith(["task-queued"]);
  });

  it("失败任务仍走「重新执行」，不受取消按钮影响", async () => {
    fetchTasks.mockResolvedValue({
      items: [
        task("task-running", "running", 1),
        task("task-failed", "failed", 2),
      ],
    });
    renderPage();
    await screen.findByText("#1");

    await userEvent.click(within(rowOf(2)).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "重新执行（1）" }));
    expect(rerunTasks).toHaveBeenCalledWith(["task-failed"]);
    expect(cancelTasks).not.toHaveBeenCalled();
  });
});
