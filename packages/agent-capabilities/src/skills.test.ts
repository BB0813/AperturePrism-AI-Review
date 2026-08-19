import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS,
  renderSkillPrompts,
  selectSkills,
} from "./skills.js";

describe("builtin skills registry", () => {
  it("exposes at least six skills covering both issue and pr", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(6);
    const ids = new Set(BUILTIN_SKILLS.map((skill) => skill.id));
    for (const expected of [
      "issue_triage",
      "security_review",
      "dependency_review",
      "performance_review",
      "docs_review",
      "test_effectiveness",
    ]) {
      expect(ids.has(expected)).toBe(true);
    }
    expect(BUILTIN_SKILLS.some((skill) => skill.appliesTo === "issue")).toBe(
      true,
    );
    expect(BUILTIN_SKILLS.some((skill) => skill.appliesTo === "pr")).toBe(true);
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.promptFragment.length).toBeGreaterThan(0);
    }
  });
});

describe("selectSkills", () => {
  it("returns only skills of the requested type", () => {
    const selected = selectSkills("issue", "some issue text");
    for (const skill of selected) expect(skill.appliesTo).toBe("issue");
    const pr = selectSkills("pr", "some pr text");
    for (const skill of pr) expect(skill.appliesTo).toBe("pr");
  });

  it("matches security_review when the context mentions security keywords", () => {
    const selected = selectSkills(
      "pr",
      "the diff adds password hashing and a new sql query with user input",
    );
    expect(selected.map((skill) => skill.id)).toContain("security_review");
  });

  it("falls back to the full set for the type when nothing matches", () => {
    const selected = selectSkills("pr", "refactor variable names only");
    expect(selected.length).toBe(
      BUILTIN_SKILLS.filter((skill) => skill.appliesTo === "pr").length,
    );
  });
});

describe("renderSkillPrompts", () => {
  it("renders an empty string for no skills", () => {
    expect(renderSkillPrompts([])).toBe("");
  });

  it("includes each selected skill's name and prompt fragment", () => {
    const selected = selectSkills("pr", "password sql readme token");
    const security = selected.find((skill) => skill.id === "security_review");
    const docs = selected.find((skill) => skill.id === "docs_review");
    expect(security).toBeDefined();
    expect(docs).toBeDefined();
    const rendered = renderSkillPrompts([security!, docs!]);
    expect(rendered).toContain(security!.name);
    expect(rendered).toContain(security!.promptFragment);
    expect(rendered).toContain(docs!.name);
    expect(rendered).toContain(docs!.promptFragment);
  });
});
