/**
 * 告警规则（v1）：纯函数评估，把「实时量规 → 告警记录」的状态迁移逻辑独立出来，
 * 便于单测。告警记录保存在进程内存（无迁移）；WebUI 运维页展示，未来可接 webhook
 * 通知。
 */

export type AlertRuleId = "queue_backlog" | "failed_tasks" | "stale_tasks";

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertStatus = "active" | "resolved";

export type AlertRecord = {
  id: AlertRuleId;
  severity: AlertSeverity;
  message: string;
  status: AlertStatus;
  firstAt: string;
  lastAt: string;
  value: number;
};

/** 评估所需的实时输入。 */
export type AlertInputs = {
  queueDepth: number;
  failed: number;
  stale: number;
};

/** 各规则触发阈值（默认值即旧硬编码值）。 */
export type AlertThresholds = {
  queueBacklog: number;
  failedTasks: number;
  staleTasks: number;
};

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  queueBacklog: 20,
  failedTasks: 1,
  staleTasks: 1,
};

type Rule = {
  id: AlertRuleId;
  severity: AlertSeverity;
  /** 触发条件：返回 true 表示异常。 */
  fired: (inputs: AlertInputs, thresholds: AlertThresholds) => boolean;
  message: (inputs: AlertInputs) => string;
  value: (inputs: AlertInputs) => number;
};

const RULES: readonly Rule[] = [
  {
    id: "queue_backlog",
    severity: "warning",
    fired: (inputs, t) => inputs.queueDepth >= t.queueBacklog,
    message: (inputs) => `队列积压 ${inputs.queueDepth} 个待处理任务。`,
    value: (inputs) => inputs.queueDepth,
  },
  {
    id: "failed_tasks",
    severity: "warning",
    fired: (inputs, t) => inputs.failed >= t.failedTasks,
    message: (inputs) =>
      `有 ${inputs.failed} 个失败任务（死信），可在「审查队列」重新入队。`,
    value: (inputs) => inputs.failed,
  },
  {
    id: "stale_tasks",
    severity: "critical",
    fired: (inputs, t) => inputs.stale >= t.staleTasks,
    message: (inputs) =>
      `${inputs.stale} 个任务心跳超时（疑似 worker 已死），租约恢复机制将自动回收。`,
    value: (inputs) => inputs.stale,
  },
];

/**
 * 评估一次输入，产出本轮告警记录（active/resolved 与上轮合并）。返回的是
 * 全部规则的最新状态，active 在前。
 */
export function evaluateAlerts(
  current: ReadonlyMap<AlertRuleId, AlertRecord>,
  inputs: AlertInputs,
  now: Date = new Date(),
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): AlertRecord[] {
  const next = new Map<AlertRuleId, AlertRecord>();
  for (const rule of RULES) {
    const prev = current.get(rule.id);
    const fired = rule.fired(inputs, thresholds);
    if (fired) {
      const firstAt = prev?.status === "active" ? prev.firstAt : now.toISOString();
      next.set(rule.id, {
        id: rule.id,
        severity: rule.severity,
        message: rule.message(inputs),
        status: "active",
        firstAt,
        lastAt: now.toISOString(),
        value: rule.value(inputs),
      });
    } else if (prev) {
      // 曾经触发过 → 标记为已恢复（保留一次状态，供界面展示「历史」）。
      next.set(rule.id, {
        id: rule.id,
        severity: rule.severity,
        message: prev.message,
        status: "resolved",
        firstAt: prev.firstAt,
        lastAt: now.toISOString(),
        value: rule.value(inputs),
      });
    }
  }
  return [...next.values()].sort((a, b) =>
    a.status === b.status ? 0 : a.status === "active" ? -1 : 1,
  );
}

/** 告警状态迁移事件（供 webhook 通知 / 审计）。 */
export type AlertTransition =
  | { kind: "triggered"; record: AlertRecord } // 由 resolved/无 → active
  | { kind: "resolved"; record: AlertRecord }; // 由 active → resolved

/**
 * 对比上轮与本轮的告警状态，产出需要通知的状态迁移。
 * - 上轮无记录 / resolved，本轮 active → triggered（首次触发或复发）
 * - 上轮 active，本轮 resolved → resolved（恢复）
 * - 持续 active 不重复通知；持续 resolved 不重复通知。
 * 纯函数，便于单测。
 */
export function diffAlertTransitions(
  prev: ReadonlyMap<AlertRuleId, AlertRecord>,
  next: readonly AlertRecord[],
): AlertTransition[] {
  const transitions: AlertTransition[] = [];
  for (const record of next) {
    const before = prev.get(record.id);
    if (record.status === "active" && before?.status !== "active") {
      transitions.push({ kind: "triggered", record });
    } else if (record.status === "resolved" && before?.status === "active") {
      transitions.push({ kind: "resolved", record });
    }
  }
  return transitions;
}
