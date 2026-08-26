import { describe, expect, it } from "vitest";
import {
  diffAlertTransitions,
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

  it("自定义阈值生效：调高队列阈值后不再触发", () => {
    const alerts = evaluateAlerts(
      new Map(),
      { queueDepth: 25, failed: 0, stale: 0 },
      new Date("2026-08-25T00:00:00Z"),
      { queueBacklog: 50, failedTasks: 1, staleTasks: 1 },
    );
    expect(alerts).toHaveLength(0);
  });

  it("自定义阈值生效：调高失败任务阈值后不触发", () => {
    const alerts = evaluateAlerts(
      new Map(),
      { queueDepth: 0, failed: 3, stale: 0 },
      new Date("2026-08-25T00:00:00Z"),
      { queueBacklog: 20, failedTasks: 5, staleTasks: 1 },
    );
    expect(alerts).toHaveLength(0);
  });

  it("默认阈值与历史硬编码一致", () => {
    const alerts = evaluateAlerts(
      new Map(),
      { queueDepth: 20, failed: 1, stale: 1 },
      new Date("2026-08-25T00:00:00Z"),
    );
    expect(alerts.filter((a) => a.status === "active").map((a) => a.id).sort()).toEqual([
      "failed_tasks",
      "queue_backlog",
      "stale_tasks",
    ]);
  });
});

describe("diffAlertTransitions", () => {
  const t0 = new Date("2026-08-25T00:00:00Z");

  it("从无记录到触发产生 triggered", () => {
    const next = evaluateAlerts(
      new Map(),
      { queueDepth: 25, failed: 0, stale: 0 },
      t0,
    );
    const events = diffAlertTransitions(new Map(), next);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "triggered" });
    expect(events[0]!.record.id).toBe("queue_backlog");
  });

  it("持续 active 不重复通知", () => {
    const first = evaluateAlerts(
      new Map(),
      { queueDepth: 25, failed: 0, stale: 0 },
      t0,
    );
    const prevMap = new Map<AlertRuleId, AlertRecord>(
      first.map((a) => [a.id, a]),
    );
    const second = evaluateAlerts(
      prevMap,
      { queueDepth: 26, failed: 0, stale: 0 },
      new Date("2026-08-25T00:05:00Z"),
    );
    const events = diffAlertTransitions(prevMap, second);
    expect(events).toHaveLength(0);
  });

  it("active → resolved 产生 resolved 事件", () => {
    const first = evaluateAlerts(
      new Map(),
      { queueDepth: 25, failed: 0, stale: 0 },
      t0,
    );
    const prevMap = new Map<AlertRuleId, AlertRecord>(
      first.map((a) => [a.id, a]),
    );
    const second = evaluateAlerts(
      prevMap,
      { queueDepth: 0, failed: 0, stale: 0 },
      new Date("2026-08-25T01:00:00Z"),
    );
    const events = diffAlertTransitions(prevMap, second);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "resolved" });
    expect(events[0]!.record.id).toBe("queue_backlog");
  });

  it("多规则同时触发时逐个产出事件", () => {
    const next = evaluateAlerts(
      new Map(),
      { queueDepth: 25, failed: 3, stale: 0 },
      t0,
    );
    const events = diffAlertTransitions(new Map(), next);
    expect(events.map((e) => e.record.id).sort()).toEqual([
      "failed_tasks",
      "queue_backlog",
    ]);
  });
});
