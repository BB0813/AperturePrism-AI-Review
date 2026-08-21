import { useCallback, useEffect, useState } from "react";
import {
  applyUpdate,
  fetchUpdateHistory,
  fetchUpdateStatus,
  type UpdateHistoryEntry,
  type UpdateStatus,
} from "../lib/api";
import { ArrowPathIcon, RefreshIcon } from "./icons";
import { fmtTime } from "./ui";
import { useToast } from "./Toast";

type LogLine = { level: string; message: string };

/** 在线更新：检查 / 一键更新（SSE 日志）/ 历史。管理员可触发更新。 */
export function UpdatePanel() {
  const toast = useToast();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await fetchUpdateStatus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "检查更新失败");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
    void fetchUpdateHistory()
      .then(setHistory)
      .catch(() => undefined);
  }, [check]);

  const update = async () => {
    setLogs([]);
    setUpdating(true);
    try {
      const body = await applyUpdate("latest", true);
      if (!body) {
        toast.success("已触发更新");
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: { ok: boolean; message: string } | null = null;
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const evLine = raw.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const data = dataLine.slice(5).trim();
          if (!data) continue;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const event = evLine ? evLine.slice(7).trim() : "message";
          if (event === "log") {
            setLogs((prev) => [
              ...prev,
              {
                level: String(parsed.level ?? "info"),
                message: String(parsed.message ?? ""),
              },
            ]);
          } else if (event === "done") {
            result =
              parsed.ok === true
                ? { ok: true, message: `更新完成：${String(parsed.applied ?? "")}` }
                : {
                    ok: false,
                    message: `更新失败：${String(parsed.reason ?? "unknown")}`,
                  };
          }
        }
      }
      const finalResult = result ?? { ok: true, message: "更新流结束" };
      if (finalResult.ok) toast.success(finalResult.message);
      else toast.error(finalResult.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败");
    } finally {
      setUpdating(false);
      void fetchUpdateHistory()
        .then(setHistory)
        .catch(() => undefined);
    }
  };

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>
          <ArrowPathIcon size={14} /> 版本与更新
        </h2>
        <span className="count mono">{status?.current.version ?? "…"}</span>
      </div>

      <p className="state" style={{ margin: 0 }}>
        当前版本 <b className="mono">{status?.current.version ?? "未知"}</b>
        {status?.latest.version ? (
          <>
            {" "}· 最新 <b className="mono">{status.latest.version}</b>
          </>
        ) : null}
        {status ? (
          status.updateAvailable ? (
            <span className="pill pill-warn" style={{ marginLeft: 8 }}>
              可更新
            </span>
          ) : (
            <span className="pill pill-ok" style={{ marginLeft: 8 }}>
              已是最新
            </span>
          )
        ) : null}
      </p>

      <div className="filters" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => void check()} disabled={checking}>
          <RefreshIcon size={14} />
          {checking ? "检查中…" : "检查更新"}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void update()}
          disabled={updating || !status?.latest.version}
        >
          {updating ? "更新中…" : "更新到最新"}
        </button>
      </div>

      {logs.length > 0 ? (
        <pre className="jsonbox" style={{ maxHeight: 220 }}>
          {logs.map((line) => `[${line.level}] ${line.message}`).join("\n")}
        </pre>
      ) : null}

      {history.length > 0 ? (
        <div className="section">
          <h4>更新历史</h4>
          <ul className="events">
            {history.slice(0, 10).map((entry, i) => (
              <li key={i}>
                <span className={`pill ${entry.ok ? "pill-ok" : "pill-err"}`}>
                  {entry.ok ? "成功" : "失败"}
                </span>
                <span className="mono">
                  {entry.from} → {entry.to}
                </span>
                <span className="faint mono">{fmtTime(entry.at)}</span>
                {entry.reason ? <span className="faint">（{entry.reason}）</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
