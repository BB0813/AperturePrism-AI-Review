import { describe, expect, it } from "vitest";
import type { AnalysisTask } from "../src/index.js";

describe("domain", () => {
  it("represents a queued analysis task", () => {
    const task: AnalysisTask = {
      id: "task-1",
      taskType: "issue_analysis",
      status: "queued",
      dedupeKey: "issue-analysis:1:2:3:v1",
    };

    expect(task.status).toBe("queued");
  });
});
