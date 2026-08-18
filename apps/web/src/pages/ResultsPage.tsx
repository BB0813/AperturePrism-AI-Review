import { useCallback, useEffect, useState } from "react";
import { fetchResults, type ResultList, type SubjectResult } from "../lib/api";

/** Shows persisted analytic results for one subject type (issue | pr). */
export function ResultsPage(props: { type: "issue" | "pr"; label: string }) {
  const [list, setList] = useState<ResultList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>{props.label} 结果</h2>
        <button onClick={refresh} disabled={loading}>
          刷新
        </button>
      </div>

      {error ? (
        <p className="state-error">加载失败：{error}</p>
      ) : loading || !list ? (
        <p className="state-loading">正在加载…</p>
      ) : list.items.length === 0 ? (
        <p className="state-empty">暂无已发布的结果（运行一次分析后出现）</p>
      ) : (
        <ul className="results">
          {list.items.map((item) => (
            <ResultRow key={item.createdAt + item.subjectNumber} item={item} />
          ))}
        </ul>
      )}
      {list?.nextCursor ? (
        <button
          onClick={() => {
            fetchResults(props.type, list.nextCursor)
              .then(setList)
              .catch(() => undefined);
          }}
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}

function ResultRow(props: { item: SubjectResult }) {
  const { item } = props;
  return (
    <li className="result">
      <div className="result-head">
        <span className="result-subject">
          #{item.subjectNumber}{" "}
          <span className="muted">{item.repositoryFullName}</span>
        </span>
        <span className="result-rev mono">{shortSha(item.revision)}</span>
        <span className="muted">{fmt(item.createdAt)}</span>
        {item.published ? (
          <span className="status status-completed">published</span>
        ) : null}
      </div>
      <p className="result-summary">{summaryOf(item.result)}</p>
    </li>
  );
}

/** Extracts a concise summary from either GradedIssueAnalysis or PrReviewContract. */
function summaryOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const value = result as Record<string, unknown>;
  const candidate =
    (typeof value.summary === "string" && value.summary) ||
    (value.result && typeof (value.result as Record<string, unknown>).summary === "string"
      ? ((value.result as Record<string, unknown>).summary as string)
      : "");
  if (candidate) return candidate;
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function shortSha(revision: string): string {
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

function fmt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}