export type HealthDependency = {
  name: string;
  status: "ok" | "error";
};

export type ReadyHealth = {
  status: "ok" | "error";
  dependencies: { database: HealthDependency; redis: HealthDependency };
};

export type HealthResult =
  | { kind: "live"; status: "ok" }
  | { kind: "ready"; data: ReadyHealth };

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`request failed with ${response.status}`);
  return response.json();
}

/** Fetches both liveness and readiness; the UI shows a clear error on failure. */
export async function fetchHealth(): Promise<HealthResult> {
  const live = (await getJson("/health/live")) as { status?: string };
  if (live.status !== "ok") throw new Error("liveness check failed");
  const ready = (await getJson("/health/ready")) as ReadyHealth;
  return { kind: "ready", data: ready };
}