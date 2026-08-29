import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  cancelTasks: vi.fn(async () => ({ status: "ok", canceled: 1, skipped: 0 })),
  fetchTaskCheckRun: vi.fn(async () => ({ present: false })),
  fetchTaskDetail: vi.fn(async () => null),
  rerunTasks: vi.fn(async () => ({ status: "ok", rerun: 1, skipped: 0 })),
}));

import { ToastProvider } from "../components/Toast";
import type { TaskDetail } from "../lib/api";
const { TaskDetailPage } = await import("../pages/TaskDetailPage");
const api = await import("../lib/api");

const fetchTaskDetail = vi.mocked(api.fetchTaskDetail);
const cancelTasks = vi.mocked(api.cancelTasks);

function detail(status: string): TaskDetail {
  return {
    id: "task-1",
    taskType: "issue_analysis",
    repositoryId: "repo-1",
    subjectNumber: 7,
    subjectRevision: "rev",
    policyVersion: "issue-analysis-v1",
    status,
    priority: 0,
    attemptCount: 1,
    maxAttempts: 3,
    lastErrorCategory: null,
    createdAt: "2026-08-21T10:00:00Z",
    updatedAt: "2026-08-21T10:00:00Z",
    payload: { repositoryFullName: "acme/widget", subjectNumber: 7 },
    timeline: [],
    attempts: [],
    publications: [],
  };
}

function renderPage(id = "task-1") {
  return render(
    <ToastProvider>
      <TaskDetailPage id={id} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  fetchTaskDetail.mockReset();
  cancelTasks.mockReset();
  cancelTasks.mockResolvedValue({ status: "ok", canceled: 1, skipped: 0 });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("任务详情页取消按钮", () => {
  it("运行中任务显示「取消任务」按钮，点击后调用 cancelTasks", async () => {
    fetchTaskDetail.mockResolvedValue(detail("running"));
    renderPage();
    const cancelButton = await screen.findByRole("button", { name: "取消任务" });
    await userEvent.click(cancelButton);
    expect(cancelTasks).toHaveBeenCalledWith(["task-1"]);
    expect(await screen.findByText(/已取消任务/)).toBeTruthy();
  });

  it("排队任务也可取消", async () => {
    fetchTaskDetail.mockResolvedValue(detail("queued"));
    renderPage();
    expect(
      await screen.findByRole("button", { name: "取消任务" }),
    ).toBeTruthy();
  });

  it("已完成任务既不显示取消也不显示重新入队", async () => {
    fetchTaskDetail.mockResolvedValue(detail("completed"));
    renderPage();
    await screen.findByText("任务信息");
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新入队" })).toBeNull();
  });

  it("失败任务只显示「重新入队」，不显示取消", async () => {
    fetchTaskDetail.mockResolvedValue(detail("failed"));
    renderPage();
    await screen.findByText("任务信息");
    expect(
      await screen.findByRole("button", { name: "重新入队" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
  });
});
