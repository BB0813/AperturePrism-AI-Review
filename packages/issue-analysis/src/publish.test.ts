import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import { publishIssueComment, type PublicationStore } from "./publish.js";

function fakeGithub() {
  const createdBodies: string[] = [];
  const updatedBodies: string[] = [];
  const github = {
    createIssueComment: async (input: { body: string }) => {
      createdBodies.push(input.body);
      return {
        id: createdBodies.length,
        htmlUrl: `https://c/${createdBodies.length}`,
      };
    },
    updateIssueComment: async (input: { body: string }) => {
      updatedBodies.push(input.body);
      return { id: 99, htmlUrl: "https://c/99" };
    },
  } as unknown as GitHubClient;
  return { github, createdBodies, updatedBodies };
}

function memoryStore() {
  const rows = new Map<string, string>();
  const touches: string[] = [];
  const store: PublicationStore = {
    findExternalObjectId: async (key) => rows.get(key) ?? null,
    insert: async (input) => {
      rows.set(input.idempotencyKey, input.externalObjectId);
    },
    touch: async (key) => {
      touches.push(key);
    },
  };
  return { store, rows, touches };
}

const baseInput = {
  github: undefined as unknown as GitHubClient,
  store: undefined as unknown as PublicationStore,
  taskId: "task-1",
  installationId: "42",
  owner: "o",
  name: "r",
  issueNumber: 7,
  idempotencyKey: "github-issue-comment:o/r:7:rev-1",
  body: "hello",
};

describe("idempotent comment publishing", () => {
  it("creates the comment and persists the external id on first publish", async () => {
    const { github, createdBodies } = fakeGithub();
    const { store, rows } = memoryStore();

    const result = await publishIssueComment({
      ...baseInput,
      github,
      store,
      body: "placeholder",
    });

    expect(result.created).toBe(true);
    expect(createdBodies).toEqual(["placeholder"]);
    expect(rows.get(baseInput.idempotencyKey)).toBe("1");
  });

  it("updates the existing comment in place instead of creating a second one", async () => {
    const { github, createdBodies, updatedBodies } = fakeGithub();
    const { store, rows, touches } = memoryStore();
    rows.set(baseInput.idempotencyKey, "7");

    const result = await publishIssueComment({
      ...baseInput,
      github,
      store,
      body: "final analysis",
    });

    expect(result.created).toBe(false);
    expect(createdBodies).toEqual([]);
    expect(updatedBodies).toEqual(["final analysis"]);
    expect(touches).toEqual([baseInput.idempotencyKey]);
  });

  it("treats distinct idempotency keys as separate comments", async () => {
    const { github, createdBodies } = fakeGithub();
    const { store } = memoryStore();

    await publishIssueComment({
      ...baseInput,
      github,
      store,
      idempotencyKey: "key-a",
    });
    await publishIssueComment({
      ...baseInput,
      github,
      store,
      idempotencyKey: "key-b",
    });

    expect(createdBodies).toEqual(["hello", "hello"]);
  });
});
