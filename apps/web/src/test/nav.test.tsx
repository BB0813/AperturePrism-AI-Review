import { describe, expect, it } from "vitest";
import { NAV, routeGroupTitle } from "../App";

describe("NAV information architecture", () => {
  it("has five groups after the restructure", () => {
    expect(NAV).toHaveLength(5);
  });

  it("has no empty groups", () => {
    for (const group of NAV) {
      expect(group.items.length, `group ${group.title ?? "(root)"} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("uses unique route paths", () => {
    const paths = NAV.flatMap((g) => g.items.map((i) => i.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("covers every primary page", () => {
    const paths = NAV.flatMap((g) => g.items.map((i) => i.path));
    for (const p of ["/", "/logs", "/issues", "/pr", "/tasks", "/repos", "/vector", "/scan", "/memory", "/labels", "/repo-rules", "/provider", "/agent", "/bot", "/github-access", "/analysis", "/ops", "/config", "/security", "/users", "/about"]) {
      expect(paths, `missing nav entry for ${p}`).toContain(p);
    }
  });

  it("keeps personal settings out of the sidebar groups (account is a bottom entry)", () => {
    const paths = NAV.flatMap((g) => g.items.map((i) => i.path));
    expect(paths).not.toContain("/account");
  });

  it("does not repeat the same icon within a group", () => {
    for (const group of NAV) {
      const icons = group.items.map((i) => i.icon);
      expect(new Set(icons).size).toBe(icons.length);
    }
  });

  it("merges the agent page into data-ops instead of a single-item group", () => {
    const dataOps = NAV.find((g) => g.title === "数据与运维");
    expect(dataOps?.items.some((i) => i.path === "/agent")).toBe(true);
  });

  it("resolves route group titles", () => {
    expect(routeGroupTitle("/repos")).toBe("数据与运维");
    expect(routeGroupTitle("/tasks")).toBe("分析");
    expect(routeGroupTitle("/")).toBe(undefined);
    expect(routeGroupTitle("/nonexistent")).toBe(undefined);
  });
});
