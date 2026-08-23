import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchRepositories,
  fetchRepoSubjects,
  syncRepositories,
  triggerManualTask,
  type Repository,
  type RepoSubjectItem,
} from "../lib/api";
import { ArrowPathIcon, FolderIcon, RefreshIcon } from "../components/icons";
import { Empty, ErrorPanel, LoadingRows } from "../components/ui";
import { explainError, explainUnknown } from "../lib/errors";
import { useToast } from "../components/Toast";

export function ReposPage() {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [triggerType, setTriggerType] = useState<"issue" | "pr">("issue");
  const [triggerRepo, setTriggerRepo] = useState<string>("");
  const [triggerNumber, setTriggerNumber] = useState<string>("");
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [subjects, setSubjects] = useState<RepoSubjectItem[]>([]);
  const [subjectsBusy, setSubjectsBusy] = useState(false);
  const [subjectsError, setSubjectsError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const toast = useToast();

  const sync = async () => {
    setSyncBusy(true);
    try {
      const result = await syncRepositories();
      if (result.errors > 0) {
        // 失败时把原因讲清楚：原先直接显示 github_not_configured 这类机器码，
        // 用户无法据此知道该去哪里配置什么。
        const reasons = [
          ...new Set((result.details ?? []).map((d) => d.reason)),
        ];
        const explained = reasons.map(explainError).join("；");
        toast.error(
          explained ||
            `同步失败：${result.errors} 个安装未能同步，且未返回具体原因。`,
        );
      } else {
        toast.success(
          `已同步 ${result.synced} 个仓库（${result.installations} 个安装）`,
        );
      }
      bumpCache();
      load();
    } catch (err) {
      toast.error(explainUnknown(err));
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
        setError(explainUnknown(err));
        setRepos(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  // 选择仓库/类型后，拉取最近的 open Issue / PR 供下拉选择（也可手动输入编号）。
  useEffect(() => {
    if (!triggerRepo) {
      setSubjects([]);
      setSubjectsError(null);
      return;
    }
    let cancelled = false;
    setSubjectsBusy(true);
    setSubjectsError(null);
    fetchRepoSubjects(triggerRepo, triggerType)
      .then((items) => {
        if (!cancelled) {
          setSubjects(items);
          // 自动填入最近一条，省去手输编号。
          setTriggerNumber(items[0] ? String(items[0].number) : "");
        }
      })
      .catch((err: unknown) => {
        // 不能把加载失败伪装成「暂无条目」：用户会以为仓库真的没有 open 项，
        // 从而排查错方向。手动输入编号仍然可用。
        if (!cancelled) {
          setSubjects([]);
          setSubjectsError(explainUnknown(err));
        }
      })
      .finally(() => {
        if (!cancelled) setSubjectsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [triggerRepo, triggerType]);

  const trigger = async () => {
    const number = Number(triggerNumber);
    if (!triggerRepo || !Number.isInteger(number) || number <= 0) {
      toast.error("请先选择仓库，再选择或填写一个正整数 Issue / PR 编号");
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
      toast.error(`触发失败：${explainUnknown(err)}`);
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
          <a
            className="btn"
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noreferrer"
          >
            在 GitHub 添加仓库 ↗
          </a>
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

      <section className="panel" style={{ padding: "10px 16px" }}>
        <p className="faint" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>
          新仓库需要先授权给 GitHub App：点上方「在 GitHub 添加仓库」进入 GitHub Apps 安装管理页，
          把目标仓库勾选到本应用下；授权后回到本页点「同步仓库」即可在这里出现并纳入扫描 / 分析。
        </p>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>手动触发分析</h2>
          <span className="count">对已安装仓库的某个 Issue / PR 立即创建一个分析 / 审查任务</span>
        </div>
        <p className="faint" style={{ margin: "0 0 12px", fontSize: 12 }}>
          选择一个仓库后，下拉会列出它最近的 open Issue / PR（也可手动输入编号）；点击「触发分析」会绕过 Webhook，
          直接把该条目加入审查队列，分析完成后再发布评论 / Review。
        </p>
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
          <select
            className="input"
            style={{ flex: "1 1 260px", maxWidth: 360 }}
            value={subjects.some((s) => String(s.number) === triggerNumber) ? triggerNumber : ""}
            onChange={(event) => setTriggerNumber(event.target.value)}
            disabled={!triggerRepo || subjects.length === 0}
          >
            <option value="">
              {!triggerRepo
                ? "先选择仓库…"
                : subjectsBusy
                  ? "加载中…"
                  : subjectsError
                    ? "列表加载失败（可手动输入编号）"
                    : subjects.length === 0
                      ? "该仓库暂无 open 条目（可手动输入编号）"
                      : "选择最近的 Issue / PR…"}
            </option>
            {subjects.map((subject) => (
              <option key={subject.number} value={String(subject.number)}>
                #{subject.number} · {subject.title.slice(0, 40)}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ flex: "0 1 110px" }}
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
        {subjectsError ? (
          <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
            无法加载 Issue / PR 列表：{subjectsError} 仍可手动输入编号后触发。
          </p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title"><h2>仓库</h2><span className="count">{repos?.length ?? "–"}</span></div>

        {error ? (
          <ErrorPanel error={error} onRetry={load} />
        ) : loading ? (
          <LoadingRows />
        ) : !repos || repos.length === 0 ? (
          <Empty icon={<FolderIcon size={32} />} title="暂无可追踪仓库" hint="点上方「在 GitHub 添加仓库」把仓库授权给 App，再点「同步仓库」即可出现在这里" />
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
