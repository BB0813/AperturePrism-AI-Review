import { describe, expect, it } from "vitest";
import { sortTasks, type SortKey, type SortState } from "../pages/TasksPage";

type Task = {
  subjectNumber?: number | null;
  status: string;
  attemptCount: number;
  policyVersion: string;
  updatedAt: string;
};

const tasks: Task[] = [
  { subjectNumber: 3, status: "failed", attemptCount: 2, policyVersion: "issue-analysis-v1", updatedAt: "2026-08-21T10:00:00Z" },
  { subjectNumber: 1, status: "queued", attemptCount: 1, policyVersion: "issue-analysis-v2", updatedAt: "2026-08-21T08:00:00Z" },
  { subjectNumber: null, status: "completed", attemptCount: 1, policyVersion: "pr-review-v1", updatedAt: "2026-08-21T12:00:00Z" },
];

const state = (key: SortKey, dir: "asc" | "desc"): SortState => ({ key, dir });

describe("sortTasks", () => {
  it("sorts by subjectNumber ascending, nulls last", () => {
    const out = sortTasks(tasks, state("subjectNumber", "asc"));
    expect(out.map((t) => t.subjectNumber)).toEqual([1, 3, null]);
  });

  it("sorts by subjectNumber descending, nulls last", () => {
    const out = sortTasks(tasks, state("subjectNumber", "desc"));
    expect(out.map((t) => t.subjectNumber)).toEqual([3, 1, null]);
  });

  it("sorts by status alphabetically", () => {
    const out = sortTasks(tasks, state("status", "asc"));
    expect(out.map((t) => t.status)).toEqual(["completed", "failed", "queued"]);
  });

  it("sorts by attemptCount descending", () => {
    const out = sortTasks(tasks, state("attempt", "desc"));
    expect(out.map((t) => t.attemptCount)).toEqual([2, 1, 1]);
  });

  it("sorts by policyVersion ascending", () => {
    const out = sortTasks(tasks, state("policy", "asc"));
    expect(out[0]!.policyVersion).toBe("issue-analysis-v1");
    expect(out[2]!.policyVersion).toBe("pr-review-v1");
  });

  it("sorts by updatedAt descending (default)", () => {
    const out = sortTasks(tasks, state("updatedAt", "desc"));
    expect(out[0]!.updatedAt).toBe("2026-08-21T12:00:00Z");
    expect(out[2]!.updatedAt).toBe("2026-08-21T08:00:00Z");
  });

  it("does not mutate the input array", () => {
    const copy = [...tasks];
    sortTasks(tasks, state("subjectNumber", "asc"));
    expect(tasks).toEqual(copy);
  });
});
