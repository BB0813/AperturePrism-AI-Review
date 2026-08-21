import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "../components/Toast";

function Trigger({ kind = "success" }: { kind?: "success" | "error" | "info" }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast[kind](`消息-${kind}`)}>
      触发
    </button>
  );
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a success toast after the action", () => {
    render(
      <ToastProvider>
        <Trigger kind="success" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    expect(screen.getByText("消息-success")).toBeInTheDocument();
  });

  it("shows an error toast for failures", () => {
    render(
      <ToastProvider>
        <Trigger kind="error" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    expect(screen.getByText("消息-error")).toBeInTheDocument();
  });

  it("auto-dismisses after the timeout", () => {
    render(
      <ToastProvider>
        <Trigger kind="success" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    expect(screen.getByText("消息-success")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("消息-success")).not.toBeInTheDocument();
  });

  it("dismisses when clicked", () => {
    render(
      <ToastProvider>
        <Trigger kind="info" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    const toast = screen.getByText("消息-info");
    expect(toast).toBeInTheDocument();

    fireEvent.click(toast);
    expect(screen.queryByText("消息-info")).not.toBeInTheDocument();
  });

  it("stacks multiple toasts", () => {
    render(
      <ToastProvider>
        <Trigger kind="success" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    expect(screen.getAllByText("消息-success")).toHaveLength(2);
  });
});
