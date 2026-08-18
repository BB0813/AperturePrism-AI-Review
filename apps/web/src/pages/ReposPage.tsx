import { useCallback, useEffect, useState } from "react";
import { fetchRepositories, type Repository } from "../lib/api";
import { FolderIcon, RefreshIcon } from "../components/icons";
import { Empty, LoadingRows } from "../components/ui";

export function ReposPage() {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchRepositories()
      .then((data) => setRepos(data.items))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load repos");
        setRepos(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">已安装仓库</h1>
          <p className="page-desc">GitHub App 授权仓库及其分析任务 / 结果统计</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title"><h2>仓库</h2><span className="count">{repos?.length ?? "–"}</span></div>

        {error ? (
          <p className="state state-error">加载失败：{error}</p>
        ) : loading ? (
          <LoadingRows />
        ) : !repos || repos.length === 0 ? (
          <Empty icon={<FolderIcon size={32} />} title="暂无可追踪仓库" hint="为 GitHub App 安装并授权仓库后，将在这里出现" />
        ) : (
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px,1fr))" }}>
            {repos.map((repo) => (
              <div key={repo.id} className="result-card">
                <div className="result-title" style={{ marginBottom: 10 }}>
                  <FolderIcon size={16} /> {repo.name}
                  <span className="result-repo">· {repo.owner}</span>
                </div>
                <div className="result-meta" style={{ marginTop: 6 }}>
                  <span className="pill pill-info">{repo.taskCount} 任务</span>
                  <span className="pill pill-ok">{repo.resultCount} 结果</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}