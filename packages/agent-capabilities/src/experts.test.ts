import { describe, expect, it } from "vitest";
import { EXPERT_TEAM, getExpertsFor } from "./experts.js";

describe("expert team registry", () => {
  it("exposes at least four built-in experts", () => {
    expect(EXPERT_TEAM.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(EXPERT_TEAM.map((expert) => expert.id));
    for (const expected of ["fullstack", "security", "dependency", "docs"]) {
      expect(ids.has(expected)).toBe(true);
    }
    for (const expert of EXPERT_TEAM) {
      expect(expert.rolePrompt.length).toBeGreaterThan(0);
      expect(expert.name.length).toBeGreaterThan(0);
    }
  });

  it("filters experts by the subject type", () => {
    const pr = getExpertsFor("pr");
    expect(pr.length).toBeGreaterThanOrEqual(4);
    for (const expert of pr) expect(expert.appliesTo).toBe("pr");
    const issue = getExpertsFor("issue");
    for (const expert of issue) expect(expert.appliesTo).toBe("issue");
  });
});
