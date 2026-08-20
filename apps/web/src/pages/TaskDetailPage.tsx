import { useCallback, useEffect, useState, type ReactElement } from "react";
import { fetchTaskDetail, type TaskDetail } from "../lib/api";
import { navigate } from "../hooks/useHash";
import {
  AlertIcon,
  CheckCircleIcon,
  ClockIcon,
  CpuIcon,
  PlayIcon,
  XCircleIcon,
} from "../components/icons";
import { ErrorPanel, LoadingRows, StatusPill, TypeChip, fmtTime, timeAgo } from "../components/ui";

const EVENT_META: Record<
  string,
  { icon: (p: { size?: number }) => ReactElement; tone: string; label: string }
> = {
  "task.created": { icon: ClockIcon, tone: "info", label: "创建" },
  "task.leased": { icon: PlayIcon, tone: "info", label: "领取租约" },
  "task.started": { icon: PlayIcon, tone: "info", label: "开始处理" },
  "task.analysis_usage": { icon: CpuIcon, tone: "acc", label: "模型分析" },
  "task.publishing": { icon: CpuIcon, tone: "vio", label: "发布评论" },
  "task.completed": { icon: CheckCircleIcon, tone: "ok", label: "已完成" },
  "task.failed": { icon: XCircleIcon, tone: "err", label: "失败" },
  "task.retry_scheduled": { icon: AlertIcon, tone: "warn", label: "安排重试" },
};

type Usage = {
  model?: string; provider?: string; durationMs?: number;
  inputTokens?: number; outputTokens?: number;
};

export function TaskDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTaskDetail(id)
      .then(setDetail)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load task");
        setDetail(null);
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => load(), [load]);

  if (error) {
    return (
      <div className="stack">
        <button className="btn btn-ghost" onClick={() => navigate("/tasks")}>← 返回任务列表</button>
        <div className="panel">
          <ErrorPanel error={error} onRetry={load} />
        </div>
      </div>
    );
  }

  if (loading || !detail) {
    return (
      <div className="stack">
        <button className="btn btn-ghost" onClick={() => navigate("/tasks")}>← 返回任务列表</button>
        <LoadingRows />
      </div>
    );
  }

  const payload = (detail.payload && typeof detail.payload === "object"
    ? detail.payload
    : {}) as Record<string, unknown>;
  const repo = typeof payload.repositoryFullName === "string" ? payload.repositoryFullName : "—";
  const usage = usageOf(detail);
  const attempts = [...detail.attempts].reverse();

  return (
    <div className="stack">
      <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/tasks")}>
        ← 返回任务列表
      </button>

      <div className="detail-hero">
        <TypeChip type={detail.taskType} />
        <span className="big">{repo}</span>
        <span className="sep">·</span>
        <span className="big mono">#{detail.subjectNumber ?? "—"}</span>
        <StatusPill status={detail.status} />
        <span className="sep">·</span>
        <span className="chip mono">{detail.policyVersion}</span>
        <span className="sep">·</span>
        <span className="muted">{timeAgo(detail.updatedAt)}</span>
      </div>

      <div className="grid2">
        <section className="panel">
          <div className="panel-title"><h2>任务信息</h2></div>
          <dl className="kv">
            <dt>任务类型</dt><dd>{detail.taskType}</dd>
            <dt>仓库</dt><dd className="mono">{repo}</dd>
            <dt>对象</dt><dd className="mono">#{detail.subjectNumber ?? "—"}</dd>
            <dt>策略版本</dt><dd className="mono">{detail.policyVersion}</dd>
            <dt>尝试</dt><dd className="mono">{detail.attemptCount}/{detail.maxAttempts}</dd>
            {detail.lastErrorCategory ? (
              <>
                <dt>最后错误</dt><dd><span className="pill pill-err">{detail.lastErrorCategory}</span></dd>
              </>
            ) : null}
            <dt>创建时间</dt><dd className="mono muted">{fmtTime(detail.createdAt)}</dd>
            <dt>更新时间</dt><dd className="mono muted">{fmtTime(detail.updatedAt)}</dd>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-title"><h2>模型用量</h2></div>
          {usage ? (
            <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))" }}>
              <MiniStat value={`${usage.model ?? "—"}`} label="模型" accent />
              <MiniStat value={fmtMs(usage.durationMs)} label="耗时" accent />
              <MiniStat value={String(usage.inputTokens ?? "—")} label="输入 tokens" />
              <MiniStat value={String(usage.outputTokens ?? "—")} label="输出 tokens" />
              <MiniStat value={usage.provider ?? "—"} label="Provider" />
            </div>
          ) : (
            <p className="state state-empty">暂无模型调用记录</p>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>生命周期</h2>
          <span className="count">{detail.timeline.length} 事件</span>
        </div>
        {detail.timeline.length === 0 ? (
          <p className="state state-empty">暂无事件</p>
        ) : (
          <ul className="tl">
            {detail.timeline.map((event, index) => {
              const meta = EVENT_META[event.eventType] ?? { icon: ClockIcon, tone: "info", label: event.eventType };
              const Icon = meta.icon;
              const data = event.data as Record<string, unknown>;
              const isUsage = event.eventType === "task.analysis_usage";
              return (
                <li key={index} className={`tl-item ${meta.tone === "acc" ? "ok" : meta.tone}`}>
                  <span className="tl-icon"><Icon size={13} /></span>
                  <div className="tl-body">
                    <div className="tl-head">
                      <span className="tl-title"><code>{event.eventType}</code>{meta.label}</span>
                      <span className="tl-time">{fmtTime(event.createdAt)}</span>
                    </div>
                    {isUsage ? (
                      <div className="tl-detail">
                        {`model=${data.model}  provider=${data.provider}  ·  ${String(data.inputTokens ?? "-")} in / ${String(data.outputTokens ?? "-")} out  ·  ${fmtMs(typeof data.durationMs === "number" ? data.durationMs : undefined)}`}
                      </div>
                    ) : (
                      <div className="tl-detail">{JSON.stringify(data)}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-title"><h2>Attempts</h2></div>
        {detail.attempts.length === 0 ? (
          <p className="state state-empty">暂无 attempt</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr><th>#</th><th>Worker</th><th>开始</th><th>结束</th><th>耗时</th><th>错误</th></tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr key={attempt.attemptNumber}>
                    <td className="num">{attempt.attemptNumber}</td>
                    <td className="mono">{attempt.workerId}</td>
                    <td className="mono muted">{fmtTime(attempt.startedAt)}</td>
                    <td className="mono muted">{attempt.finishedAt ? fmtTime(attempt.finishedAt) : "—"}</td>
                    <td className="mono muted">
                      {compact(attempt.startedAt, attempt.finishedAt)}
                    </td>
                    <td>{attempt.errorCategory ? <span className="pill pill-err">{attempt.errorCategory}</span> : <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function MiniStat(props: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="kpi acc" style={{ padding: "12px 14px" }}>
      <div className="kpi-value" style={{ fontSize: 18 }}>{props.value}</div>
      <div className="kpi-label">{props.label}</div>
    </div>
  );
}

function usageOf(detail: TaskDetail): Usage | null {
  const evt = detail.timeline.find((e) => e.eventType === "task.analysis_usage");
  if (!evt) return null;
  const d = evt.data as Record<string, unknown>;
  return {
    model: typeof d.model === "string" ? d.model : undefined,
    provider: typeof d.provider === "string" ? d.provider : undefined,
    durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
    inputTokens: typeof d.inputTokens === "number" ? d.inputTokens : undefined,
    outputTokens: typeof d.outputTokens === "number" ? d.outputTokens : undefined,
  };
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function compact(start: string, end: string | null): string {
  if (!end) return "—";
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return "—";
  const diff = e - s;
  if (diff < 0) return "—";
  if (diff < 1000) return `${diff}ms`;
  return `${(diff / 1000).toFixed(1)}s`;
}