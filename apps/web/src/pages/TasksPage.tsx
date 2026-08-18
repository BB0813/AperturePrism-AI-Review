import { useCallback, useEffect, useState } from "react";
import { fetchTasks, type TaskList, type TaskSummary } from "../lib/api";
import { navigate } from "../hooks/useHash";

const TYPE_LABEL: Record<TaskSummary["taskType"], string> = {
  issue_analysis: "Issue",
  pr_review: "PR",
  repository_index: "Index",
};

/** Tasks tab: cursor-paginated task list with loading/empty/error states. */
export function TasksPage() {
  const [list, setList] = useState<TaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTasks({ limit: 25 })
      .then(setList)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load tasks");
        setList(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>任务</h2>
        <button onClick={refresh} disabled={loading}>
          刷新
        </button>
      </div>

      {error ? (
        <p className="state-error">加载失败：{error}</p>
      ) : loading || !list ? (
        <p className="state-loading">正在加载任务…</p>
      ) : list.items.length === 0 ? (
        <p className="state-empty">暂无任务</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>类型</th>
              <th>状态</th>
              <th>对象</th>
              <th>策略</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((task) => (
              <tr key={task.id} className="row-link" onClick={() => navigate(`/tasks/${task.id}`)}>
                <td>{TYPE_LABEL[task.taskType] ?? task.taskType}</td>
                <td>
                  <span className={`status status-${task.status}`}>{task.status}</span>
                </td>
                <td className="mono">
                  {task.subjectNumber ?? "—"}
                  {task.attemptCount > 1 ? (
                    <span className="muted"> (x{task.attemptCount})</span>
                  ) : null}
                </td>
                <td className="mono muted">{task.policyVersion}</td>
                <td className="mono muted">{fmt(task.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list?.nextCursor ? (
        <button
          onClick={() => {
            fetchTasks({ limit: 25, before: list.nextCursor }).then(setList).catch(() => undefined);
          }}
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}

function fmt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}