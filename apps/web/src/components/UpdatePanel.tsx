import { useCallback, useEffect, useRef, useState } from "react";
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

/** 更新阶段的顺序与展示名（与 update.sh 的 stage 标记对应）。 */
const STAGES = ["backup", "pull", "migrate", "up", "health", "api", "done"] as const;
const STAGE_LABELS: Record<string, string> = {
  backup: "备份配置",
  pull: "拉取镜像",
  migrate: "数据库迁移",
  up: "重建容器",
  health: "健康检查",
  api: "重启 API 容器",
  done: "更新完成",
};
const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  STAGES.map((s, i) => [s, i]),
);

/** 在线更新：检查 / 一键更新（SSE 日志 + 阶段进度）/ 历史。管理员可触发更新。 */
export function UpdatePanel() {
  const toast = useToast();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stage, setStage] = useState<number>(-1);
  const [stageLabel, setStageLabel] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [reloadIn, setReloadIn] = useState<number | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoReloaded = useRef(false);

  const clearReloadTimer = () => {
    if (reloadTimer.current) {
      clearInterval(reloadTimer.current);
      reloadTimer.current = null;
    }
  };

  /** 倒计时后自动刷新页面（更新完成后 API 已重建，避免用户手动刷新撞上 502）。 */
  const scheduleReload = (seconds: number) => {
    if (autoReloaded.current) return;
    autoReloaded.current = true;
    setReloadIn(seconds);
    reloadTimer.current = setInterval(() => {
      setReloadIn((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearReloadTimer();
          window.location.reload();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => () => clearReloadTimer(), []);

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
    setStage(-1);
    setStageLabel("");
    setLogsOpen(false);
    autoReloaded.current = false;
    setUpdating(true);
    // 是否已进入 SSE 流。只有流建立后才可能发生「更新导致的断连」（update.sh
    // 重建 web/nginx 或 api 重启）；在此之前失败是真实错误，应原样报出。
    let streamStarted = false;
    try {
      const body = await applyUpdate("latest", true);
      if (!body) {
        toast.success("已触发更新");
        return;
      }
      streamStarted = true;
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
          } else if (event === "stage") {
            const s = String(parsed.stage ?? "");
            const idx = STAGE_INDEX[s] ?? -1;
            if (idx >= 0) {
              setStage(idx);
              setStageLabel(String(parsed.message ?? STAGE_LABELS[s] ?? s));
            }
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
      if (finalResult.ok) {
        toast.success(finalResult.message);
        // 更新完成后服务已重建，自动刷新页面让用户看到新版本；避免反复触发。
        scheduleReload(6);
      } else {
        toast.error(finalResult.message);
      }
    } catch (err) {
      // API/nginx 容器重建时会中断 SSE 流（属预期）：此时更新仍在后台由独立
      // helper 容器继续执行，稍后自动刷新确认结果，而不是报“更新失败”。
      // 用局部 streamStarted 判断（`updating` 是陈旧闭包，重渲染后才更新，不可靠）。
      if (streamStarted) {
        toast.info("更新连接已中断（服务正在重启）；将自动刷新页面确认结果");
        scheduleReload(8);
      } else {
        toast.error(err instanceof Error ? err.message : "更新失败");
      }
    } finally {
      setUpdating(false);
      void fetchUpdateHistory()
        .then(setHistory)
        .catch(() => undefined);
    }
  };

  const currentStageIdx = Math.max(stage, 0);
  const progressPct = Math.round(
    ((currentStageIdx + 1) / STAGES.length) * 100,
  );

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

      {updating ? (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="update-progress">
            <div
              className="update-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
            {stage >= 0
              ? `第 ${currentStageIdx + 1}/${STAGES.length} 步：${stageLabel || (STAGE_LABELS[STAGES[currentStageIdx] ?? ""] ?? "")}`
              : "准备更新…"}
          </p>
          {logs.length > 0 ? (
            <details
              className="update-logs"
              open={logsOpen}
              onToggle={(e) => setLogsOpen(e.currentTarget.open)}
            >
              <summary className="faint" style={{ fontSize: 12, cursor: "pointer" }}>
                {logsOpen ? "收起详细日志" : `查看详细日志（${logs.length} 行）`}
              </summary>
              <pre className="jsonbox" style={{ maxHeight: 220, marginTop: 8 }}>
                {logs.map((line) => `[${line.level}] ${line.message}`).join("\n")}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {reloadIn !== null ? (
        <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
          更新完成，<b className="mono">{reloadIn}s</b> 后自动刷新页面…
        </p>
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
