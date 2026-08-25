import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("accumulates counters and supports batching", () => {
    const m = new MetricsRegistry();
    m.increment("a");
    m.increment("a", 3);
    m.bumpCounters([
      ["a", 1],
      ["b", 2],
    ]);
    const snap = m.snapshot();
    expect(snap.counters.a).toBe(5);
    expect(snap.counters.b).toBe(2);
  });

  it("records durations and computes averages", () => {
    const m = new MetricsRegistry();
    m.recordDuration("http.request_ms", 100);
    m.recordDuration("http.request_ms", 300);
    const snap = m.snapshot();
    expect(snap.durations["http.request_ms"]).toEqual({
      count: 2,
      totalMs: 400,
    });
  });

  it("tracks gauges and stamps a start time", () => {
    const m = new MetricsRegistry();
    m.setGauge("queue.depth", 7);
    const snap = m.snapshot();
    expect(snap.gauges["queue.depth"]).toBe(7);
    expect(Date.parse(snap.since)).not.toBeNaN();
  });
});
