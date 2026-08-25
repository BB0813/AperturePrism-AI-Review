import { describe, expect, it } from "vitest";
import {
  evaluateAlerts,
  type AlertRecord,
  type AlertRuleId,
} from "./alerts.js";

describe("evaluateAlerts", () => {
  it("不触发时不产生告警记录", () => {
    const alerts = evaluateAlerts(
      new Map(),
      { queueDepth: 0, failed: 0, stale: 0 },
      new Date("2026-08-25T00:00:00Z"),
    );
    expect(alerts).toHaveLength(0);
  });

  it("队列积压与失败任务触发对应规则", () => {
    const alerts = evaluateAlerts(
      new Map(),
      { queueDepth: 25, failed: 3, stale: 0 },
      new Date("2026-08-25T00:00:00Z"),
    );
    const active = alerts.filter((a) => a.status === "active");
    expect(active.map((a) => a.id).sort()).toEqual([
      "failed_tasks",
      "queue_backlog",
    ]);
    expect(alerts[0]?.status).toBe("active");
  });

  it("滞留任务为 critical 且排在前面", () => {
    const alerts = evaluateAlerts(
      new Map(),
      { queueDepth: 0, failed: 0, stale: 2 },
      new Date("2026-08-25T00:00:00Z"),
    );
    expect(alerts[0]?.id).toBe("stale_tasks");
    expect(alerts[0]?.severity).toBe("critical");
  });

  it("恢复后标记 resolved 并保留 firstAt", () => {
    const first = new Date("2026-08-25T00:00:00Z");
    const active: ReadonlyMap<AlertRuleId, AlertRecord> = new Map(
      evaluateAlerts(
        new Map(),
        { queueDepth: 25, failed: 0, stale: 0 },
        first,
      ).map((a) => [a.id, a]),
    );
    const resolved = evaluateAlerts(
      active,
      { queueDepth: 0, failed: 0, stale: 0 },
      new Date("2026-08-25T01:00:00Z"),
    );
    const q = resolved.find((a) => a.id === "queue_backlog");
    expect(q?.status).toBe("resolved");
    expect(q?.firstAt).toBe(first.toISOString());
    expect(q?.lastAt).toBe("2026-08-25T01:00:00.000Z");
  });
});
