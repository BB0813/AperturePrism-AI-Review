import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Empty, ErrorPanel, StatusPill, TypeChip, shortText, timeAgo } from "../components/ui";

describe("timeAgo", () => {
  it("formats seconds", () => {
    expect(timeAgo(new Date(Date.now() - 30 * 1000).toISOString())).toBe("30s");
  });

  it("formats minutes", () => {
    expect(timeAgo(new Date(Date.now() - 5 * 60 * 1000).toISOString())).toBe("5m");
  });

  it("formats hours", () => {
    expect(timeAgo(new Date(Date.now() - 3 * 3600 * 1000).toISOString())).toBe("3h");
  });

  it("formats days", () => {
    expect(timeAgo(new Date(Date.now() - 2 * 86400 * 1000).toISOString())).toBe("2d");
  });

  it("falls back to the raw string for invalid dates", () => {
    expect(timeAgo("not-a-date")).toBe("not-a-date");
  });
});

describe("shortText", () => {
  it("truncates long values with an ellipsis", () => {
    expect(shortText("abcdefghijklmnop", 8)).toBe("abcdefgh…");
  });

  it("keeps short values intact", () => {
    expect(shortText("abc", 8)).toBe("abc");
  });
});

describe("StatusPill", () => {
  it("renders the status text", () => {
    render(<StatusPill status="completed" />);
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("maps known statuses to their tone class", () => {
    const { container } = render(<StatusPill status="failed" />);
    expect(container.querySelector(".pill-err")).not.toBeNull();
  });

  it("falls back to pill-dim for unknown statuses", () => {
    const { container } = render(<StatusPill status="mystery" />);
    expect(container.querySelector(".pill-dim")).not.toBeNull();
  });
});

describe("TypeChip", () => {
  it("renders a known type label", () => {
    render(<TypeChip type="issue_analysis" />);
    expect(screen.getByText("Issue")).toBeInTheDocument();
  });

  it("falls back to the raw type for unknown values", () => {
    render(<TypeChip type="weird_kind" />);
    expect(screen.getByText("weird_kind")).toBeInTheDocument();
  });
});

describe("Empty", () => {
  it("shows title and hint", () => {
    render(<Empty title="暂无数据" hint="稍后再来" />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
    expect(screen.getByText("稍后再来")).toBeInTheDocument();
  });
});

describe("ErrorPanel", () => {
  it("shows the error and a retry button when onRetry is given", () => {
    const onRetry = () => undefined;
    render(<ErrorPanel error="boom" onRetry={onRetry} />);
    expect(screen.getByText("加载失败")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("omits the retry button when onRetry is absent", () => {
    render(<ErrorPanel error="boom" />);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
