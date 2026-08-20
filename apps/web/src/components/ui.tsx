import type { ReactNode } from "react";

/** status → pill tone + label */
const STATUS_STYLE: Record<string, string> = {
  running: "pill-info",
  leased: "pill-info",
  publishing: "pill-vio",
  queued: "pill-warn",
  completed: "pill-ok",
  failed: "pill-err",
  retry_wait: "pill-vio-err",
  canceled: "pill-dim",
};

/** JSON 词法高亮：匹配字符串(含 key)、布尔/null、数字；避免 dangerouslySetInnerHTML。 */
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function JsonBlock({ data }: { data: unknown }) {
  const text = JSON.stringify(data, null, 2) ?? "";
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = JSON_TOKEN_RE.exec(text)) !== null) {
    const [full, str, colon] = match;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (str) {
      if (colon) {
        nodes.push(
          <span key={key++} className="j-key">
            {str}
          </span>,
        );
        nodes.push(
          <span key={key++} className="j-colon">
            :
          </span>,
        );
      } else {
        nodes.push(
          <span key={key++} className="j-str">
            {str}
          </span>,
        );
      }
    } else if (full === "true" || full === "false" || full === "null") {
      nodes.push(
        <span key={key++} className="j-bool">
          {full}
        </span>,
      );
    } else {
      nodes.push(
        <span key={key++} className="j-num">
          {full}
        </span>,
      );
    }
    last = match.index + full.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <pre className="jsonbox">{nodes}</pre>;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${STATUS_STYLE[status] ?? "pill-dim"}`}>{status}</span>;
}

export function TypeChip({ type }: { type: string }) {
  const cls = type === "repository_index" ? "chip chip-type-index" : "chip chip-type";
  return <span className={cls}>{TYPE_LABEL[type] ?? type}</span>;
}

export const TYPE_LABEL: Record<string, string> = {
  issue_analysis: "Issue",
  pr_review: "PR",
  repository_index: "索引",
};

/** Pill for severity S0-S3 / unknown (`.s0`..`.sunknown` provide the tones). */
export function SeverityPill({ value }: { value: string }) {
  return <span className={`pill ${clsOf("s", value)}`}>{value}</span>;
}

export function PriorityPill({ value }: { value: string }) {
  return <span className={`pill ${clsOf("p", value)}`}>{value}</span>;
}

export function QualityPill({ value }: { value: string }) {
  return <span className={`pill ${clsOf("q", value)}`}>{value}</span>;
}

/** Maps a value to its css tint class: s0/s1/…, p0/p1/…, qcomplete/… */
function clsOf(prefix: string, value: string): string {
  const key = String(value || "").toLowerCase();
  return `${prefix}${key === "needs_triage" || key.includes(" ") || !key ? key.replace(/ /g, "_") : key}`;
}

/** Compact human time, relative for <1h else absolute. */
export function timeAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return d.toLocaleString();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function shortText(value: string, max = 12): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function Empty(props: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="state" style={{ flexDirection: "column", textAlign: "center", padding: "26px 0" }}>
      {props.icon}
      <div>
        <div style={{ fontWeight: 600, color: "var(--text)" }}>{props.title}</div>
        {props.hint ? <div style={{ fontSize: 12, marginTop: 3, color: "var(--faint)" }}>{props.hint}</div> : null}
      </div>
    </div>
  );
}

/** 统一的加载失败面板：错误信息 + 可选的重试按钮。 */
export function ErrorPanel({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="panel err-panel">
      <div className="err-panel-row">
        <span className="err-panel-mark" aria-hidden="true">
          !
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="err-panel-title">加载失败</div>
          <p className="err-panel-detail">{error}</p>
        </div>
        {onRetry ? (
          <button className="btn" onClick={onRetry} style={{ marginLeft: "auto", flexShrink: 0 }}>
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LoadingRows() {
  return (
    <div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skeleton sk-row" />
      ))}
    </div>
  );
}