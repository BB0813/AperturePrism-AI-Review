import { useCallback, useEffect, useState } from "react";
import { fetchTaskDetail, type TaskDetail } from "../lib/api";
import { navigate } from "../hooks/useHash";

const TYPE_LABEL = {
  issue_analysis: "Issue",
  pr_review: "PR",
  repository_index: "Index",
} as const;

/** Task detail: summary + lifecycle timeline + attempt rows. */
export function TaskDetailPage(props: { id: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTaskDetail(props.id)
      .then(setDetail)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load task");
        setDetail(null);
      })
      .finally(() => setLoading(false));
  }, [props.id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="card">
      <p>
        <a
          className="tab"
          href="#/tasks"
          onClick={(event) => {
            event.preventDefault();
            navigate("/tasks");
          }}
        >
          ← 返回任务列表
        </a>
      </p>
      <h2>任务详情</h2>

      {error ? (
        <p className="state-error">加载失败：{error}</p>
      ) : loading || !detail ? (
        <p className="state-loading">正在加载…</p>
      ) : (
        <>
          <dl className="kv">
            <dt>类型</dt>
            <dd>{TYPE_LABEL[detail.taskType] ?? detail.taskType}</dd>
            <dt>状态</dt>
            <dd>
              <span className={`status status-${detail.status}`}>{detail.status}</span>
            </dd>
            <dt>对象</dt>
            <dd className="mono">{detail.subjectNumber ?? "—"}</dd>
            <dt>策略</dt>
            <dd className="mono">{detail.policyVersion}</dd>
            <dt>尝试</dt>
            <dd className="mono">
              {detail.attemptCount}/{detail.maxAttempts}
            </dd>
            {detail.lastErrorCategory ? (
              <>
                <dt>最后错误</dt>
                <dd className="state-error">{detail.lastErrorCategory}</dd>
              </>
            ) : null}
            <dt>创建时间</dt>
            <dd className="mono muted">{fmt(detail.createdAt)}</dd>
            <dt>更新时间</dt>
            <dd className="mono muted">{fmt(detail.updatedAt)}</dd>
          </dl>

          <h3>时间线</h3>
          {detail.timeline.length === 0 ? (
            <p className="state-empty">暂无事件</p>
          ) : (
            <ul className="timeline">
              {detail.timeline.map((event) => (
                <li key={event.createdAt + event.eventType} className="tl-item">
                  <span className="tl-dot" />
                  <div>
                    <div className="tl-title">
                      <code>{event.eventType}</code>
                      <span className="muted">{fmt(event.createdAt)}</span>
                    </div>
                    <pre>{JSON.stringify(event.data)}</pre>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3>Attempts</h3>
          {detail.attempts.length === 0 ? (
            <p className="state-empty">暂无 attempt</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>worker</th>
                  <th>开始</th>
                  <th>结束</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {detail.attempts.map((attempt) => (
                  <tr key={attempt.attemptNumber}>
                    <td>{attempt.attemptNumber}</td>
                    <td className="mono">{attempt.workerId}</td>
                    <td className="mono muted">{fmt(attempt.startedAt)}</td>
                    <td className="mono muted">
                      {attempt.finishedAt ? fmt(attempt.finishedAt) : "—"}
                    </td>
                    <td className={attempt.errorCategory ? "state-error" : ""}>
                      {attempt.errorCategory ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function fmt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}