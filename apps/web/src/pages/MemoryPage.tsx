import { useCallback, useEffect, useState } from "react";
import {
  deleteRepoMemory,
  fetchMe,
  fetchRepoMemory,
  fetchRepositories,
  triggerMemoryConsolidation,
  type RepoMemoryItem,
  type RepoMemoryKind,
  type Repository,
} from "../lib/api";
import { RefreshIcon, SparkleIcon } from "../components/icons";
import { LoadingRows, fmtTime } from "../components/ui";

const KIND_LABEL: Record<string, string> = {
  reflection: "反思",
  rule: "规则",
  knowledge: "知识",
};

const KIND_TONE: Record<string, string> = {
  reflection: "pill-info",
  rule: "pill-ok",
  knowledge: "pill-vio",
};

const SOURCE_LABEL: Record<string, string> = {
  issue_analysis: "Issue 分析",
  pr_review: "PR 审查",
  consolidation: "合并沉淀",
};

export function MemoryPage() {
  const [items, setItems] = useState<RepoMemoryItem[]>([]);
  const [counts, setCounts] = useState({ reflection: 0, rule: 0, knowledge: 0 });
  const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchMe().catch(() => null),
      fetchRepoMemory({
        repositoryId: repoFilter || undefined,
        kind: (kindFilter || undefined) as RepoMemoryKind | undefined,
      }),
      fetchRepositories().catch(() => null),
    ])
      .then(([me, list, repoData]) => {
        setIsAdmin(me ? me.isAdmin || me.authMethod === "bearer" : false);
        setItems(list.items);
        setCounts(list.counts);
        setNextOffset(list.nextOffset);
        setRepos(repoData?.items ?? []);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load memory");
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [repoFilter, kindFilter]);

  useEffect(() => load(), [load]);

  const loadMore = async () => {
    if (nextOffset === undefined) return;
    try {
      const list = await fetchRepoMemory({
        repositoryId: repoFilter || undefined,
        kind: (kindFilter || undefined) as RepoMemoryKind | undefined,
        offset: nextOffset,
      });
      setItems((prev) => [...prev, ...list.items]);
      setNextOffset(list.nextOffset);
    } catch (err) {
      setMessage({ text: `加载失败：${err instanceof Error ? err.message : err}`, ok: false });
    }
  };

  const consolidate = async () => {
    setBusy("consolidate");
    setMessage(null);
    try {
      const result = await triggerMemoryConsolidation();
      setMessage({
        text: `合并完成：处理 ${result.repositories} 个仓库，沉淀 ${result.rules} 条规则/知识。`,
        ok: true,
      });
      load();
    } catch (err) {
      setMessage({ text: `合并失败：${err instanceof Error ? err.message : err}`, ok: false });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (item: RepoMemoryItem) => {
    setBusy(item.id);
    setMessage(null);
    try {
      await deleteRepoMemory(item.id);
      setMessage({ text: `已删除「${item.title.slice(0, 40)}」。`, ok: true });
      load();
    } catch (err) {
      setMessage({ text: `删除失败：${err instanceof Error ? err.message : err}`, ok: false });
    } finally {
      setBusy(null);
    }
  };

  const repoName = (id: string | null) => {
    if (!id) return "全局";
    const repo = repos.find((r) => r.id === id);
    return repo ? repo.fullName : "未知仓库";
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">记忆管理</h1>
          <p className="page-desc">仓库记忆：从 Issue 分析与 PR 审查中沉淀的反思、规则与知识</p>
        </div>
        <div className="actions">
          {isAdmin ? (
            <button className="btn btn-primary" onClick={consolidate} disabled={busy === "consolidate" || loading}>
              <SparkleIcon size={16} />
              {busy === "consolidate" ? "合并中…" : "触发合并"}
            </button>
          ) : null}
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {message ? (
        <p className={`state ${message.ok ? "state-ok" : "state-error"}`} style={{ margin: 0 }}>
          {message.text}
        </p>
      ) : null}

      {error ? (
        <div className="panel"><p className="state state-error">{error}</p></div>
      ) : loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <div className="kpi-grid">
            <Kpi value={counts.reflection} label="反思" tone="info" />
            <Kpi value={counts.rule} label="规则" tone="ok" />
            <Kpi value={counts.knowledge} label="知识" tone="vio" />
          </div>

          <section className="panel">
            <div className="panel-title">
              <h2><SparkleIcon size={14} /> 记忆条目</h2>
              <span className="count">{items.length}</span>
            </div>

            <div className="dist-row" style={{ gridTemplateColumns: "1fr 1fr auto", maxWidth: 520 }}>
              <select
                className="input"
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
                aria-label="按仓库筛选"
              >
                <option value="">全部仓库</option>
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>{repo.fullName}</option>
                ))}
              </select>
              <select
                className="input"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value)}
                aria-label="按类型筛选"
              >
                <option value="">全部类型</option>
                <option value="reflection">反思</option>
                <option value="rule">规则</option>
                <option value="knowledge">知识</option>
              </select>
            </div>

            {items.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无记忆。完成 Issue 分析或 PR 审查后会自动沉淀反思；管理员可点击「触发合并」将其合并为规则/知识。
              </p>
            ) : (
              <div className="tablewrap" style={{ marginTop: 10 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>类型</th>
                      <th>标题</th>
                      <th>内容预览</th>
                      <th>仓库</th>
                      <th>来源</th>
                      {isAdmin ? <th>操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{fmtTime(item.createdAt)}</td>
                        <td>
                          <span className={`pill ${KIND_TONE[item.kind] ?? "pill-dim"}`}>
                            {KIND_LABEL[item.kind] ?? item.kind}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>
                          {item.title}
                          {item.kind === "reflection" && item.consolidated ? (
                            <span className="chip" style={{ marginLeft: 6 }}>已合并</span>
                          ) : null}
                        </td>
                        <td className="faint" style={{ fontSize: 12, maxWidth: 320 }}>
                          {item.content.length > 120 ? `${item.content.slice(0, 120)}…` : item.content}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{repoName(item.repositoryId)}</td>
                        <td>
                          <span className="chip">{SOURCE_LABEL[item.sourceType ?? ""] ?? item.sourceType ?? "—"}</span>
                        </td>
                        {isAdmin ? (
                          <td>
                            <button
                              className="btn"
                              style={{ padding: "4px 10px", fontSize: 12 }}
                              disabled={busy === item.id}
                              onClick={() => remove(item)}
                            >
                              {busy === item.id ? "删除中…" : "删除"}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {nextOffset !== undefined ? (
              <div className="actions" style={{ marginTop: 12 }}>
                <button className="btn" onClick={loadMore}>
                  加载更多
                </button>
              </div>
            ) : null}

            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              {isAdmin
                ? "反思（reflection）来自每次完成的 Issue 分析 / PR 审查；合并 Agent 定期（每 10 分钟）把未合并反思提炼为规则/知识，并回灌进后续分析上下文。"
                : "当前账号无管理员权限，只能查看；合并与删除需要管理员。"}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Kpi(props: { value: number; label: string; tone: string }) {
  return (
    <div className={`kpi ${props.tone}`}>
      <div className="kpi-value">{props.value}</div>
      <div className="kpi-label">{props.label}</div>
    </div>
  );
}
