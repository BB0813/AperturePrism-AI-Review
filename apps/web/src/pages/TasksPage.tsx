import { useCallback, useEffect, useMemo, useState } from "react";
import { bumpCache, fetchTasks, type TaskList, type TaskSummary } from "../lib/api";
import { navigate } from "../hooks/useHash";
import { ChevronRightIcon, RefreshIcon, SearchIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows, StatusPill, TypeChip, timeAgo } from "../components/ui";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";

const TYPE_FILTERS = ["all", "issue_analysis", "pr_review", "repository_index"] as const;
const STATUS_FILTERS = ["all", "queued", "running", "publishing", "completed", "failed", "retry_wait", "canceled"] as const;

export function TasksPage() {
  const [list, setList] = useState<TaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [type, setType] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [search, setSearch] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTasks({ limit: 50 })
      .then(setList)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load tasks");
        setList(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => refresh(), [refresh]);

  const loadMore = useCallback(() => {
    if (!list || list.nextOffset === undefined || loadingMore) return;
    setLoadingMore(true);
    fetchTasks({ limit: 50, offset: list.nextOffset })
      .then((more) => {
        const seen = new Set(list.items.map((t) => t.id));
        const fresh = more.items.filter((t) => !seen.has(t.id));
        setList({ items: [...list.items, ...fresh], nextOffset: more.nextOffset });
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [list, loadingMore]);

  const hasMore = list?.nextOffset !== undefined;
  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loadingMore,
    onLoadMore: loadMore,
  });

  const items = useMemo(() => {
    if (!list) return [];
    const q = search.toLowerCase();
    return list.items.filter(
      (t) =>
        (type === "all" || t.taskType === type) &&
        (status === "all" || t.status === status) &&
        (!q || t.id.includes(q) || String(t.subjectNumber ?? "").includes(q) || t.policyVersion.toLowerCase().includes(q) || t.status.includes(q)),
    );
  }, [list, type, status, search]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">任务队列</h1>
          <p className="page-desc">Issue 分析与 PR 审查任务的执行状态</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); refresh(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h2>筛选</h2>
        </div>
        <div className="filters">
          <div className="seg">
            {TYPE_FILTERS.map((t) => (
              <button key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
                {t === "all" ? "全部类型" : TypeChipLabel(t)}
              </button>
            ))}
          </div>
          <div className="seg">
            {STATUS_FILTERS.map((s) => (
              <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
                {s === "all" ? "全部状态" : s}
              </button>
            ))}
          </div>
          <label className="searchbox">
            <SearchIcon size={15} />
            <input
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索任务 ID / 对象 / 策略…"
              aria-label="搜索任务"
            />
          </label>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>任务</h2>
          <span className="count">{items.length} 条</span>
        </div>

        {error ? (
          <ErrorPanel error={error} onRetry={refresh} />
        ) : loading ? (
          <LoadingRows />
        ) : items.length === 0 ? (
          <Empty title="暂无任务" hint="通过 GitHub Webhook 或任务 API 创建任务后，将在这里显示" />
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>对象</th>
                  <th>状态</th>
                  <th>策略</th>
                  <th>尝试</th>
                  <th>上次错误</th>
                  <th>更新时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasMore || loadingMore ? (
          <div ref={sentinelRef} className="load-more-hint">
            {loadingMore ? "加载中…" : "向下滚动加载更多"}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <tr className="clickable" onClick={() => navigate(`/tasks/${task.id}`)}>
      <td><TypeChip type={task.taskType} /></td>
      <td className="num">#{task.subjectNumber ?? "—"}</td>
      <td><StatusPill status={task.status} /></td>
      <td><span className="chip mono">{task.policyVersion}</span></td>
      <td className="num muted">
        {task.attemptCount}/{task.maxAttempts}
      </td>
      <td>{task.lastErrorCategory ? <span className="pill pill-err">{task.lastErrorCategory}</span> : <span className="faint">—</span>}</td>
      <td className="muted">{timeAgo(task.updatedAt)}</td>
      <td style={{ textAlign: "right" }}><ChevronRightIcon size={15} /></td>
    </tr>
  );
}

function TypeChipLabel(type: string): string {
  return { issue_analysis: "Issue", pr_review: "PR", repository_index: "索引" }[type] ?? type;
}