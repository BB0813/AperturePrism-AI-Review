import { useCallback, useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "online" | "offline";

export type StreamedEvent = {
  seq: number;
  type: string;
  data: unknown;
};

export type SseState = {
  status: SseStatus;
  /** Highest sequence seen, for reconnect gap detection. */
  lastSeq: number;
  events: StreamedEvent[];
  /** True when a gap was detected in the `id` sequence. */
  hasGap: boolean;
};

const MAX_EVENTS = 50;

/**
 * Connects to the API `/events` SSE stream. Auto-reconnects with a short
 * backoff, keeps only the last screenful of events, flags gaps from the `id`
 * sequence (so a reconnect can later trigger a server-side replay), and tracks
 * connecting/online/offline so the UI never silently stalls.
 */
export function useSse(url: string): SseState {
  const [status, setStatus] = useState<SseStatus>("connecting");
  const [lastSeq, setLastSeq] = useState(0);
  const [events, setEvents] = useState<StreamedEvent[]>([]);
  const [hasGap, setHasGap] = useState(false);
  const expectedRef = useRef(0);

  const pushEvent = useCallback((type: string, seq: number, data: unknown) => {
    if (expectedRef.current !== 0 && seq !== expectedRef.current) setHasGap(true);
    expectedRef.current = seq + 1;
    setLastSeq(seq);
    setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), { seq, type, data }]);
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let es: EventSource | null = null;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      es = new EventSource(url);
      es.onopen = () => {
        if (!disposed) setStatus("online");
      };
      es.onerror = () => {
        if (disposed) return;
        setStatus("offline");
        es?.close();
        retryTimer = setTimeout(connect, 3_000);
      };
      es.addEventListener("heartbeat", (raw) => {
        const message = raw as MessageEvent<string>;
        pushEvent("heartbeat", seqOf(message), safeParse(message.data));
      });
      es.onmessage = (raw) => {
        const message = raw as MessageEvent<string>;
        pushEvent(message.lastEventId || "message", seqOf(message), safeParse(message.data));
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [url, pushEvent]);

  return { status, lastSeq, events, hasGap };
}

function seqOf(message: MessageEvent<string>): number {
  const parsed = Number(message.lastEventId);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}