import { useCallback, useEffect, useMemo, useState } from "react";
import { bumpCache, fetchTasks, type TaskList, type TaskSummary } from "../lib/api";
import { navigate } from "../hooks/useHash";
import { ChevronRightIcon, RefreshIcon, SearchIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows, StatusPill, TypeChip, timeAgo } from "../components/ui";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";

const TYPE_FILTERS = ["all", "issue_analysis", "pr_review", "repository_index"] as const;
const STATUS_FILTERS = ["all", "queued", "running", "publishing", "completed", "failed", "retry_wait", "canceled"] as const;
export type SortKey = "subjectNumber" | "status" | "attempt" | "updatedAt" | "policy";
export type SortState = { key: SortKey; dir: "asc" | "desc" };

/** 按指定列对任务排序（纯函数，供组件与单元测试复用）。 */
export function sortTasks<T extends { subjectNumber?: number | null; status: string; attemptCount: number; policyVersion: string; updatedAt: string }>(
  items: T[],
  sort: SortState,
): T[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    switch (sort.key) {
      case "subjectNumber": {
        const aN = a.subjectNumber ?? null;
        const bN = b.subjectNumber ?? null;
        if (aN === null && bN === null) return 0;
        if (aN === null) return 1; // 无编号的任务始终排最后
        if (bN === null) return -1;
        return (aN - bN) * dir;
      }
      case "status":
        return a.status.localeCompare(b.status) * dir;
      case "attempt":
        return (a.attemptCount - b.attemptCount) * dir;
      case "policy":
        return a.policyVersion.localeCompare(b.policyVersion) * dir;
      case "updatedAt":
      default:
        return a.updatedAt.localeCompare(b.updatedAt) * dir;
    }
  });
}

export function TasksPage() {
  const [list, setList] = useState<TaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [type, setType] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "updatedAt",
    dir: "desc",
  });

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "updatedAt" ? "desc" : "asc" },
    );
  };

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
    return sortTasks(
      list.items.filter(
        (t) =>
          (type === "all" || t.taskType === type) &&
          (status === "all" || t.status === status) &&
          (!q || t.id.includes(q) || String(t.subjectNumber ?? "").includes(q) || t.policyVersion.toLowerCase().includes(q) || t.status.includes(q)),
      ),
      sort,
    );
  }, [list, type, status, search, sort]);

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
                  <SortableTh label="对象" active={sort.key === "subjectNumber"} dir={sort.dir} onClick={() => toggleSort("subjectNumber")} />
                  <SortableTh label="状态" active={sort.key === "status"} dir={sort.dir} onClick={() => toggleSort("status")} />
                  <SortableTh label="策略" active={sort.key === "policy"} dir={sort.dir} onClick={() => toggleSort("policy")} />
                  <SortableTh label="尝试" active={sort.key === "attempt"} dir={sort.dir} onClick={() => toggleSort("attempt")} />
                  <th>上次错误</th>
                  <SortableTh label="更新时间" active={sort.key === "updatedAt"} dir={sort.dir} onClick={() => toggleSort("updatedAt")} />
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

function SortableTh(props: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th aria-sort={props.active ? (props.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`th-sort ${props.active ? "th-sort-active" : ""}`}
        onClick={props.onClick}
      >
        {props.label}
        <span className="th-sort-arrow" aria-hidden="true">
          {props.active ? (props.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}