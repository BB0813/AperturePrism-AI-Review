import { useCallback, useEffect, useState } from "react";
import { fetchResults, type ResultList, type SubjectResult } from "../lib/api";
import { ChevronDownIcon, ChevronRightIcon, RefreshIcon } from "../components/icons";
import { Empty, LoadingRows, fmtTime, shortText } from "../components/ui";

type NormResult = {
  root: Record<string, unknown>;
  isIssue: boolean;
  summary: string;
};

function normalizeResult(result: unknown): NormResult {
  const raw = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const root = (raw.result && typeof raw.result === "object"
    ? (raw.result as Record<string, unknown>)
    : raw) as Record<string, unknown>;
  const isIssue =
    typeof root.severity === "string" || typeof root.priority === "string";
  const summary =
    (typeof root.summary === "string" && root.summary) ||
    (typeof root.verdict === "string" && root.verdict) ||
    "";
  return { root, isIssue, summary };
}

type Conf = { severity?: number; rootCause?: number; suggestion?: number };

export function ResultsPage(props: { type: "issue" | "pr"; label: string }) {
  const [list, setList] = useState<ResultList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchResults(props.type)
      .then(setList)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load results");
        setList(null);
      })
      .finally(() => setLoading(false));
  }, [props.type]);

  useEffect(() => refresh(), [refresh]);

  const loadMore = useCallback(() => {
    if (!list || list.nextOffset === undefined || loadingMore) return;
    setLoadingMore(true);
    fetchResults(props.type, list.nextOffset)
      .then((more) => {
        const seen = new Set(list.items.map((r) => `${r.subjectType}:${r.subjectNumber}:${r.revision}`));
        const fresh = more.items.filter((r) => !seen.has(`${r.subjectType}:${r.subjectNumber}:${r.revision}`));
        // Append, never replace: an empty page must not wipe the loaded list.
        setList({ items: [...list.items, ...fresh], nextOffset: more.nextOffset });
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [list, loadingMore, props.type]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">{props.label}</h1>
          <p className="page-desc">已持久化的结构化分析结果</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={refresh} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>结果</h2>
          <span className="count">{list?.items.length ?? "–"} 条</span>
        </div>

        {error ? (
          <p className="state state-error">加载失败：{error}</p>
        ) : loading || !list ? (
          loading ? <LoadingRows /> : <Empty title="暂无数据" />
        ) : list.items.length === 0 ? (
          <Empty title="暂无结果" hint="Worker 完成一次分析并发布后，结构化结果将显示在这里" />
        ) : (
          <div className="stack">
            {list.items.map((item) => (
              <ResultCard key={item.createdAt + item.subjectNumber} item={item} />
            ))}
          </div>
        )}

        {list?.nextOffset !== undefined ? (
          <button
            className="btn btn-block"
            style={{ marginTop: 14 }}
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function ResultCard({ item }: { item: SubjectResult }) {
  const norm = normalizeResult(item.result);
  const [open, setOpen] = useState(false);

  return (
    <article className="result-card">
      <div className="result-top">
        <span className="result-title">
          #{item.subjectNumber} <span className="result-repo">{item.repositoryFullName}</span>
        </span>
        <span className="chip mono">{shortText(item.revision, 10)}</span>
        <span className="faint">{fmtTime(item.createdAt)}</span>
        <span className="pill pill-ok">published</span>
        <a
          className="btn btn-ghost"
          style={{ marginLeft: "auto", padding: "4px 10px" }}
          href={githubUrl(item)}
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
      </div>

      {norm.isIssue ? <IssueBody norm={norm} /> : <GenericBody norm={norm} />}

      <button className="detail-btn" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        {open ? "收起原始数据" : "查看原始数据"}
      </button>
      {open ? <pre className="jsonbox">{JSON.stringify(item.result, null, 2)}</pre> : null}
    </article>
  );
}

function IssueBody({ norm }: { norm: NormResult }) {
  const r = norm.root;
  const conf = Object.keys(r).includes("confidence")
    ? (r.confidence as Conf)
    : undefined;
  const labels = stringArr(r.suggestedLabels);
  const missing = stringArr(r.missingInformation);
  const actions = stringArr(r.suggestedActions);
  const evidence = arrOf(r.evidence);

  return (
    <>
      <p className="result-summary">{norm.summary || "无摘要"}</p>

      <div className="result-meta">
        <SeverityBadge value={str(r.severity)} />
        <PriorityBadge value={str(r.priority)} />
        <QualityBadge value={str(r.quality)} />
        {typeof r.category === "string" ? <CategoryPill value={r.category} /> : null}
      </div>

      {conf ? (
        <div className="section">
          <h4>置信度</h4>
          <div className="conf">
            <ConfItem label="Severity" value={conf.severity} />
            <ConfItem label="Root Cause" value={conf.rootCause} />
            <ConfItem label="Suggestion" value={conf.suggestion} />
          </div>
        </div>
      ) : null}

      {evidence.length > 0 ? (
        <div className="section">
          <h4>依据（Evidence）</h4>
          <ul>
            {evidence.map((e, i) => (
              <li key={i} className="action-item mono">
                {str(e?.kind ?? "")} — {str(e?.excerpt ?? "")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {missing.length > 0 ? (
        <div className="section">
          <h4>缺失信息</h4>
          <ul className="missing-list">
            {missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {labels.length > 0 ? (
        <div className="section">
          <h4>建议标签</h4>
          <div className="tag-row">
            {labels.map((l, i) => (
              <span key={i} className="tag">{l}</span>
            ))}
          </div>
        </div>
      ) : null}

      {actions.length > 0 ? (
        <div className="section">
          <h4>建议动作</h4>
          <ul>
            {actions.map((a, i) => (
              <li key={i} className="action-item">{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function GenericBody({ norm }: { norm: NormResult }) {
  // PR review results have a different contract; surface whatever summary-like
  // field exists and let users drill into the raw JSON.
  return <p className="result-summary">{norm.summary || "查看原始数据以展开分析内容"}</p>;
}

function ConfItem({ label, value }: { label: string; value?: number }) {
  const pct = value === undefined ? 0 : Math.round(value * 100);
  return (
    <div className="conf-item">
      <span className="lab">{label}</span>
      <span className="conf-bar"><span className="conf-fill" style={{ width: `${pct}%` }} /></span>
      <span className="pct">{value === undefined ? "—" : `${pct}%`}</span>
    </div>
  );
}

function SeverityBadge({ value }: { value: string }) {
  if (!value) return null;
  return <span className={`pill ${severityCls(value)}`}>Severity {value}</span>;
}
function PriorityBadge({ value }: { value: string }) {
  if (!value) return null;
  return <span className={`pill ${priorityCls(value)}`}>Priority {value}</span>;
}
function QualityBadge({ value }: { value: string }) {
  if (!value) return null;
  return <span className={`pill ${qualityCls(value)}`}>质量 {value}</span>;
}
function CategoryPill({ value }: { value: string }) {
  return <span className="pill pill-dim">类型 {value}</span>;
}

/* ---- class mapping (matches index.css tint classes) ---- */
function severityCls(v: string): string {
  const k = v.toLowerCase();
  return k === "unknown" ? "sunknown" : `s${k.replace(/[^0-9]/g, "")}`;
}
function priorityCls(v: string): string {
  const k = v.toLowerCase();
  return k === "needs_triage" ? "pneeds_triage" : `p${k.replace(/[^0-9]/g, "")}`;
}
function qualityCls(v: string): string {
  return `q${v.toLowerCase().replace(/[^a-z]/g, "")}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Builds the GitHub issue/PR html_url for a persisted subject result. */
function githubUrl(item: SubjectResult): string {
  const base = `https://github.com/${item.repositoryFullName}`;
  const kind = item.subjectType === "pr" ? "pull" : "issues";
  return `${base}/${kind}/${item.subjectNumber}`;
}
function stringArr(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [];
}
function arrOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}