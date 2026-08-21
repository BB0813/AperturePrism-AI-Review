import { useCallback, useEffect, useMemo, useState } from "react";
import { bumpCache, fetchResults, type ResultList, type SubjectResult } from "../lib/api";
import { ChevronDownIcon, ChevronRightIcon, RefreshIcon, SearchIcon } from "../components/icons";
import { Empty, ErrorPanel, JsonBlock, LoadingRows, fmtTime, shortText } from "../components/ui";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";

type NormResult = {
  root: Record<string, unknown>;
  isIssue: boolean;
  summary: string;
  related: { issueNumber: number; repositoryFullName: string | null; score: number; reasons: string[] }[];
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
  const related = Array.isArray(raw.related)
    ? (raw.related as Record<string, unknown>[])
        .map((r) => ({
          issueNumber:
            typeof r.issueNumber === "number" ? r.issueNumber : Number(r.issue_number ?? 0),
          repositoryFullName:
            typeof r.repositoryFullName === "string" ? r.repositoryFullName : null,
          score: typeof r.score === "number" ? r.score : 0,
          reasons: Array.isArray(r.reasons)
            ? r.reasons.filter((x): x is string => typeof x === "string")
            : [],
        }))
        .filter((r) => r.issueNumber > 0)
    : [];
  return { root, isIssue, summary, related };
}

type Conf = { severity?: number; rootCause?: number; suggestion?: number };

export function ResultsPage(props: { type: "issue" | "pr"; label: string }) {
  const [list, setList] = useState<ResultList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");

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

  const filtered = useMemo(() => {
    if (!list) return [];
    const q = search.trim().toLowerCase();
    if (!q) return list.items;
    return list.items.filter((item) => {
      const n = normalizeResult(item.result);
      return (
        String(item.subjectNumber).includes(q) ||
        item.repositoryFullName.toLowerCase().includes(q) ||
        n.summary.toLowerCase().includes(q)
      );
    });
  }, [list, search]);

  const hasMore = list?.nextOffset !== undefined;
  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loadingMore,
    onLoadMore: loadMore,
  });

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">{props.label}</h1>
          <p className="page-desc">已持久化的结构化分析结果</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); refresh(); }} disabled={loading}>
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
        <div className="filters" style={{ marginBottom: 14 }}>
          <label className="searchbox">
            <SearchIcon size={15} />
            <input
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索 #编号 / 仓库/摘要…"
              aria-label="搜索结果"
            />
          </label>
        </div>

        {error ? (
          <ErrorPanel error={error} onRetry={refresh} />
        ) : loading || !list ? (
          loading ? <LoadingRows /> : <Empty title="暂无数据" />
        ) : filtered.length === 0 ? (
          <Empty title={search ? "无匹配结果" : "暂无结果"} hint={search ? "换个关键词试试" : "Worker 完成一次分析并发布后，结构化结果将显示在这里"} />
        ) : (
          <div className="stack">
            {filtered.map((item) => (
              <ResultCard key={item.createdAt + item.subjectNumber} item={item} />
            ))}
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

      {norm.isIssue ? <IssueBody norm={norm} /> : <PrBody norm={norm} />}

      <button className="detail-btn" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        {open ? "收起原始数据" : "查看原始数据"}
      </button>
      {open ? <JsonBlock data={item.result} /> : null}
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
  const suggestedTitle = str(r.suggestedTitle);

  return (
    <>
      <p className="result-summary">{norm.summary || "无摘要"}</p>

      <div className="result-meta">
        <SeverityBadge value={str(r.severity)} />
        <PriorityBadge value={str(r.priority)} />
        <QualityBadge value={str(r.quality)} />
        {typeof r.category === "string" ? <CategoryPill value={r.category} /> : null}
      </div>

      {suggestedTitle ? (
        <div className="section">
          <h4>建议标题</h4>
          <p className="action-item">{suggestedTitle}</p>
        </div>
      ) : null}

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

      {norm.related.length > 0 ? (
        <div className="section">
          <h4>语义关联 Issue</h4>
          <ul className="missing-list">
            {norm.related.slice(0, 5).map((rel, i) => (
              <li key={i}>
                <a
                  href={`https://github.com/${rel.repositoryFullName ?? "unknown/repo"}/issues/${rel.issueNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{rel.issueNumber}
                </a>
                <span className="faint">
                  {" "}· {rel.repositoryFullName ?? "unknown/repo"}（{Math.round(rel.score * 100)}%
                  {rel.reasons.includes("signal") ? " 信号" : " 文本"}相似）
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export type PrFinding = {
  rule: string;
  severity: string;
  file: string;
  message: string;
  evidence: string;
  suggestion: string;
  afterLine: number;
};

export type PrParsed = {
  summary: string;
  overallTone: string | null;
  stats: { files: number; additions: number; deletions: number } | null;
  findings: PrFinding[];
};

/** 规范化 PR 审查结果（pr-review/v1 契约），供展示与单元测试复用。 */
export function parsePrResult(root: Record<string, unknown>): PrParsed | null {
  if (typeof root.summary !== "string" && !Array.isArray(root.findings)) return null;
  const findings = Array.isArray(root.findings)
    ? (root.findings as Record<string, unknown>[]).map((f) => ({
        rule: typeof f.rule === "string" ? f.rule : "rule",
        severity: typeof f.severity === "string" ? f.severity : "info",
        file: typeof f.file === "string" ? f.file : "",
        message: typeof f.message === "string" ? f.message : "",
        evidence: typeof f.evidence === "string" ? f.evidence : "",
        suggestion: typeof f.suggestion === "string" ? f.suggestion : "",
        afterLine: typeof f.afterLine === "number" ? f.afterLine : 0,
      }))
    : [];
  const hasStats =
    typeof root.changedFileCount === "number" ||
    typeof root.additions === "number" ||
    typeof root.deletions === "number";
  return {
    summary: typeof root.summary === "string" ? root.summary : "",
    overallTone: typeof root.overallTone === "string" ? root.overallTone : null,
    stats: hasStats
      ? {
          files: typeof root.changedFileCount === "number" ? root.changedFileCount : 0,
          additions: typeof root.additions === "number" ? root.additions : 0,
          deletions: typeof root.deletions === "number" ? root.deletions : 0,
        }
      : null,
    findings,
  };
}

function PrBody({ norm }: { norm: NormResult }) {
  const pr = parsePrResult(norm.root);
  if (!pr) return <p className="result-summary">{norm.summary || "查看原始数据以展开分析内容"}</p>;

  return (
    <>
      <div className="result-meta">
        {pr.overallTone ? <ToneBadge tone={pr.overallTone} /> : null}
        {pr.stats ? (
          <span className="chip mono">
            {pr.stats.files} 文件 · +{pr.stats.additions}/-{pr.stats.deletions}
          </span>
        ) : null}
        <span className="pill pill-dim">{pr.findings.length} findings</span>
      </div>

      {pr.summary ? <p className="result-summary">{pr.summary}</p> : null}

      {pr.findings.length > 0 ? (
        <div className="section">
          <h4>审查发现（Findings）</h4>
          <ul className="finding-list">
            {pr.findings.map((f, i) => (
              <li key={i} className="finding">
                <div className="finding-head">
                  <span className={`pill ${prSeverityCls(f.severity)}`}>{f.severity}</span>
                  <span className="finding-rule mono">{f.rule}</span>
                  <span className="finding-file mono">
                    {f.file}
                    {f.afterLine ? `:${f.afterLine}` : ""}
                  </span>
                </div>
                {f.message ? <p className="finding-msg">{f.message}</p> : null}
                {f.evidence ? <pre className="finding-evidence">{f.evidence}</pre> : null}
                {f.suggestion ? <p className="finding-suggestion">建议：{f.suggestion}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ToneBadge({ tone }: { tone: string }) {
  const cls =
    tone === "approve" ? "pill-ok" : tone === "changes_requested" ? "pill-err" : "pill-dim";
  return <span className={`pill ${cls}`}>{tone}</span>;
}

function prSeverityCls(value: string): string {
  switch (value.toLowerCase()) {
    case "critical":
      return "s0";
    case "high":
      return "s1";
    case "medium":
      return "s2";
    case "low":
      return "s3";
    default:
      return "sunknown";
  }
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