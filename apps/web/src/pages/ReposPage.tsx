import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchRepositories,
  syncRepositories,
  triggerManualTask,
  type Repository,
} from "../lib/api";
import { ArrowPathIcon, FolderIcon, RefreshIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows } from "../components/ui";
import { useToast } from "../components/Toast";

export function ReposPage() {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [triggerType, setTriggerType] = useState<"issue" | "pr">("issue");
  const [triggerRepo, setTriggerRepo] = useState<string>("");
  const [triggerNumber, setTriggerNumber] = useState<string>("");
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const toast = useToast();

  const sync = async () => {
    setSyncBusy(true);
    try {
      const result = await syncRepositories();
      toast.success(
        `已同步 ${result.synced} 个仓库（${result.installations} 个安装，${result.errors} 个失败）`,
      );
      bumpCache();
      load();
    } catch (err) {
      toast.error(`同步失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setSyncBusy(false);
    }
  };

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

  const trigger = async () => {
    const number = Number(triggerNumber);
    if (!triggerRepo || !Number.isInteger(number) || number <= 0) {
      toast.error("请选择仓库并填写正整数编号");
      return;
    }
    setTriggerBusy(true);
    try {
      const result = await triggerManualTask({
        type: triggerType,
        repositoryFullName: triggerRepo,
        subjectNumber: number,
      });
      toast.success(
        result.outcome === "duplicate"
          ? `任务已存在（去重），taskId：${result.taskId}`
          : `已创建任务，taskId：${result.taskId}`,
      );
    } catch (err) {
      toast.error(`触发失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setTriggerBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">已安装仓库</h1>
          <p className="page-desc">GitHub App 授权仓库及其分析任务 / 结果统计</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { void sync(); }} disabled={syncBusy}>
            <ArrowPathIcon size={16} />
            {syncBusy ? "同步中…" : "同步仓库"}
          </button>
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>手动触发分析</h2>
          <span className="count">对已安装仓库的 Issue / PR 手动创建任务</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            className="input"
            style={{ flex: "1 1 220px" }}
            value={triggerRepo}
            onChange={(event) => setTriggerRepo(event.target.value)}
            disabled={!repos || repos.length === 0}
          >
            <option value="">{repos && repos.length > 0 ? "选择仓库…" : "暂无可选仓库"}</option>
            {repos?.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ flex: "0 1 120px" }}
            value={triggerType}
            onChange={(event) => setTriggerType(event.target.value === "pr" ? "pr" : "issue")}
          >
            <option value="issue">Issue</option>
            <option value="pr">PR</option>
          </select>
          <input
            className="input"
            style={{ flex: "0 1 140px" }}
            type="number"
            min={1}
            step={1}
            placeholder="编号，如 12"
            value={triggerNumber}
            onChange={(event) => setTriggerNumber(event.target.value)}
            data-lpignore="true"
          />
          <button className="btn btn-primary" onClick={trigger} disabled={triggerBusy || !triggerRepo}>
            {triggerBusy ? "触发中…" : "触发分析"}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><h2>仓库</h2><span className="count">{repos?.length ?? "–"}</span></div>

        {error ? (
          <ErrorPanel error={error} onRetry={load} />
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