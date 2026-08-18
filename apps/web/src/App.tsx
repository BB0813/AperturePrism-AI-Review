import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type ReadyHealth } from "./lib/api";
import { useSse, type SseStatus, type StreamedEvent } from "./hooks/useSse";

const STATUS_LABEL: Record<SseStatus, string> = {
  connecting: "connecting…",
  online: "live",
  offline: "offline",
};

export function App() {
  const [health, setHealth] = useState<ReadyHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const sse = useSse("/events");

  const refresh = useCallback(() => {
    setHealthError(null);
    fetchHealth()
      .then((result) => {
        if (result.kind === "ready") setHealth(result.data);
      })
      .catch((error: unknown) => {
        setHealth(null);
        setHealthError(error instanceof Error ? error.message : "health check failed");
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="shell">
      <header className="topbar">
        <h1>AperturePrism</h1>
        <span className={`badge badge-${sse.status}`}>{STATUS_LABEL[sse.status]}</span>
      </header>

      <main className="grid">
        <HealthCard health={health} error={healthError} onRefresh={refresh} />
        <EventsCard sse={sse} />
      </main>
    </div>
  );
}

function HealthCard(props: {
  health: ReadyHealth | null;
  error: string | null;
  onRefresh: () => void;
}) {
  if (props.error) {
    return (
      <section className="card">
        <h2>连接状态</h2>
        <p className="state-error">无法连接 API：{props.error}</p>
        <button onClick={props.onRefresh}>重试</button>
      </section>
    );
  }
  if (!props.health) {
    return (
      <section className="card">
        <h2>连接状态</h2>
        <p className="state-loading">正在读取依赖状态…</p>
      </section>
    );
  }
  const deps = [
    props.health.dependencies.database,
    props.health.dependencies.redis,
  ];
  return (
    <section className="card">
      <h2>连接状态</h2>
      {deps.some((dep) => dep.status !== "ok") ? (
        <p className="state-error">有一个依赖不可用</p>
      ) : (
        <p className="state-ok">API 与依赖均正常</p>
      )}
      <ul className="deps">
        {deps.map((dep) => (
          <li key={dep.name}>
            <span className={`dot dot-${dep.status}`} />
            {dep.name} · {dep.status}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventsCard(props: { sse: {
  status: SseStatus;
  lastSeq: number;
  events: StreamedEvent[];
  hasGap: boolean;
} }) {
  const { status, lastSeq, events, hasGap } = props.sse;
  return (
    <section className="card">
      <h2>
        事件流
        {lastSeq > 0 ? <span className="muted"> · seq {lastSeq}</span> : null}
      </h2>
      {hasGap ? <p className="state-warn">检测到序列缺口，可触发一次性回放</p> : null}
      {status === "offline" ? (
        <p className="state-error">事件流已断开，正在自动重连…</p>
      ) : events.length === 0 ? (
        status === "online" ? (
          <p className="state-empty">等待事件…</p>
        ) : (
          <p className="state-loading">正在建立事件流…</p>
        )
      ) : (
        <ul className="events">
          {events.map((event, index) => (
            <li key={`${event.seq}-${index}`}>
              <code className="event-id">#{event.seq}</code> {event.type}
              <pre>{JSON.stringify(event.data)}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}