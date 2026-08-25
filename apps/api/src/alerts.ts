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

type Rule = {
  id: AlertRuleId;
  severity: AlertSeverity;
  /** 触发条件：返回 true 表示异常。 */
  fired: (inputs: AlertInputs) => boolean;
  message: (inputs: AlertInputs) => string;
  value: (inputs: AlertInputs) => number;
};

const RULES: readonly Rule[] = [
  {
    id: "queue_backlog",
    severity: "warning",
    fired: (inputs) => inputs.queueDepth >= 20,
    message: (inputs) => `队列积压 ${inputs.queueDepth} 个待处理任务，超过阈值 20。`,
    value: (inputs) => inputs.queueDepth,
  },
  {
    id: "failed_tasks",
    severity: "warning",
    fired: (inputs) => inputs.failed >= 1,
    message: (inputs) =>
      `有 ${inputs.failed} 个失败任务（死信），可在「审查队列」重新入队。`,
    value: (inputs) => inputs.failed,
  },
  {
    id: "stale_tasks",
    severity: "critical",
    fired: (inputs) => inputs.stale >= 1,
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
): AlertRecord[] {
  const next = new Map<AlertRuleId, AlertRecord>();
  for (const rule of RULES) {
    const prev = current.get(rule.id);
    const fired = rule.fired(inputs);
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
