import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Empty, ErrorPanel } from "../components/ui";
import { explainError } from "../lib/errors";

/**
 * 回归防护：多个页面曾把加载失败渲染成「暂无数据」，用户既看不出出错，
 * 也没有重试入口。这里确认错误态与空态是两种明确不同的界面。
 */
describe("加载失败不得伪装成空数据", () => {
  it("错误面板给出可执行指引、原始错误码和重试入口", () => {
    const onRetry = vi.fn();
    render(
      <ErrorPanel error={explainError("github_not_configured")} onRetry={onRetry} />,
    );

    // 用户看到的是「去哪里配置」，而不是裸的 github_not_configured。
    expect(screen.getByText(/安装向导/)).toBeTruthy();
    // 原始码保留，便于用户反馈时提供准确信息。
    expect(screen.getByText(/github_not_configured/)).toBeTruthy();

    const retry = screen.getByRole("button");
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("空态不提供重试按钮，与错误态可区分", () => {
    const { container } = render(
      <Empty title="暂无日志" hint="运行 Worker 后事件会出现在这里" />,
    );
    expect(screen.getByText("暂无日志")).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
  });
});
