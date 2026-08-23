import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// api 模块会在导入时读取环境与 localStorage，这里只关心页面结构。
vi.mock("../lib/api", () => ({
  bumpCache: vi.fn(),
  fetchProviders: vi.fn(async () => ({ policies: [], accounts: [] })),
  fetchModels: vi.fn(async () => []),
  saveProvider: vi.fn(async () => ({
    status: "ok",
    provider: "p",
    accountName: "p-main",
    model: "m",
    policiesUpdated: 1,
  })),
}));

import { ToastProvider } from "../components/Toast";

const { ProviderPage } = await import("../pages/ProviderPage");

/**
 * 回归防护：模型配置此前只能在安装向导里做一次，装完后本页是纯只读，
 * 用户点进「模型路由」找不到任何配置入口（issue #2）。
 */
describe("模型路由页必须提供配置入口", () => {
  it("展示「添加模型」按钮", async () => {
    render(
      <ToastProvider>
        <ProviderPage />
      </ToastProvider>,
    );
    expect(
      await screen.findByRole("button", { name: /添加模型/ }),
    ).toBeTruthy();
  });

  it("空策略时的提示指向该入口，而不是让用户无从下手", async () => {
    render(
      <ToastProvider>
        <ProviderPage />
      </ToastProvider>,
    );
    expect(await screen.findByText(/添加模型/)).toBeTruthy();
  });
});
