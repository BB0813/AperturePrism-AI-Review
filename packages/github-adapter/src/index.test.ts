import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  UnsupportedGitHubEventError,
  WebhookSignatureError,
  mapGitHubEventToTask,
  normalizeGitHubEvent,
  parseIssueCommand,
  verifyWebhookSignature,
} from "./index.js";

describe("GitHub webhook adapter", () => {
  const secret = "webhook-secret";
  const payload = Buffer.from('{"action":"opened"}');
  const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

  it("accepts a valid HMAC signature", () => {
    expect(() =>
      verifyWebhookSignature(payload, signature, secret),
    ).not.toThrow();
  });

  it("rejects missing, malformed, and incorrect signatures", () => {
    expect(() => verifyWebhookSignature(payload, undefined, secret)).toThrow(
      WebhookSignatureError,
    );
    expect(() => verifyWebhookSignature(payload, "sha1=bad", secret)).toThrow(
      WebhookSignatureError,
    );
    expect(() =>
      verifyWebhookSignature(payload, `${signature.slice(0, -1)}0`, secret),
    ).toThrow(WebhookSignatureError);
  });

  it("normalizes issue events without exposing provider-specific structure", () => {
    const event = normalizeGitHubEvent(
      "issues",
      "delivery-1",
      {
        action: "opened",
        installation: { id: 42 },
        repository: { id: 100, full_name: "owner/repo" },
        issue: { number: 7, updated_at: "2026-08-17T00:00:00Z" },
      },
      "2026-08-17T00:00:00.000Z",
    );
    expect(event).toMatchObject({
      deliveryId: "delivery-1",
      eventName: "issues",
      action: "opened",
      installationId: "42",
      repositoryId: "100",
      repositoryFullName: "owner/repo",
      subjectNumber: 7,
      subjectRevision: "2026-08-17T00:00:00Z",
    });
  });

  it("normalizes pull request head revisions", () => {
    const event = normalizeGitHubEvent("pull_request", "delivery-2", {
      action: "synchronize",
      installation: { id: "42" },
      repository: { id: "100", full_name: "owner/repo" },
      pull_request: { number: 8, head: { sha: "abc123" } },
    });
    expect(event.subjectRevision).toBe("abc123");
  });

  it("maps supported issue and PR revisions to stable task keys", () => {
    const issue = normalizeGitHubEvent("issues", "delivery-issue", {
      action: "edited",
      installation: { id: 42 },
      repository: { id: 100, full_name: "owner/repo" },
      issue: { number: 7, updated_at: "2026-08-17T01:00:00Z" },
    });
    const pr = normalizeGitHubEvent("pull_request", "delivery-pr", {
      action: "synchronize",
      repository: { id: 100, full_name: "owner/repo" },
      pull_request: { number: 8, head: { sha: "abc123" } },
    });

    expect(
      mapGitHubEventToTask(issue, "repository-uuid", "policy-v1"),
    ).toMatchObject({
      outcome: "task",
      task: {
        taskType: "issue_analysis",
        dedupeKey:
          "issue-analysis:repository-uuid:7:2026-08-17T01:00:00Z:policy-v1",
      },
    });
    expect(
      mapGitHubEventToTask(pr, "repository-uuid", "policy-v1"),
    ).toMatchObject({
      outcome: "task",
      task: {
        taskType: "pr_review",
        dedupeKey: "pr-review:repository-uuid:8:abc123:policy-v1",
      },
    });
  });

  it("ignores non-triggering events and rejects missing revisions", () => {
    const ping = normalizeGitHubEvent("ping", "delivery-ping", {});
    const comment = normalizeGitHubEvent("issue_comment", "delivery-comment", {
      action: "created",
    });
    const issue = normalizeGitHubEvent("issues", "delivery-invalid", {
      action: "opened",
      repository: { id: 100, full_name: "owner/repo" },
      issue: { number: 7 },
    });

    expect(mapGitHubEventToTask(ping, "repository-uuid", "policy-v1")).toEqual({
      outcome: "ignored",
      reason: "ping",
    });
    expect(
      mapGitHubEventToTask(comment, "repository-uuid", "policy-v1"),
    ).toEqual({
      outcome: "ignored",
      reason: "comment_commands_not_enabled",
    });
    expect(mapGitHubEventToTask(issue, "repository-uuid", "policy-v1")).toEqual(
      {
        outcome: "invalid",
        reason: "missing_subject_revision",
      },
    );
  });

  it("ignores events triggered by our own bot account", () => {
    // Our analysis comment bumps the issue's updated_at, which is the revision.
    // Reprocessing that event would create a new task and post another comment.
    const byBotType = normalizeGitHubEvent("issues", "delivery-bot-type", {
      action: "edited",
      repository: { id: 100, full_name: "owner/repo" },
      issue: { number: 7, updated_at: "2026-08-22T01:00:00Z" },
      sender: { login: "apertureprism", type: "Bot" },
    });
    const byBotSuffix = normalizeGitHubEvent("issues", "delivery-bot-suffix", {
      action: "edited",
      repository: { id: 100, full_name: "owner/repo" },
      issue: { number: 7, updated_at: "2026-08-22T02:00:00Z" },
      sender: { login: "clodbreeze-ai-reviewer[bot]", type: "User" },
    });

    expect(byBotType.senderIsBot).toBe(true);
    expect(byBotSuffix.senderIsBot).toBe(true);
    for (const event of [byBotType, byBotSuffix]) {
      expect(mapGitHubEventToTask(event, "repository-uuid", "v1")).toEqual({
        outcome: "ignored",
        reason: "bot_originated_event",
      });
    }
  });

  it("still analyzes events triggered by humans", () => {
    const byHuman = normalizeGitHubEvent("issues", "delivery-human", {
      action: "edited",
      repository: { id: 100, full_name: "owner/repo" },
      issue: { number: 7, updated_at: "2026-08-22T03:00:00Z" },
      sender: { login: "octocat", type: "User" },
    });
    expect(byHuman.senderIsBot).toBe(false);
    expect(byHuman.senderLogin).toBe("octocat");
    expect(
      mapGitHubEventToTask(byHuman, "repository-uuid", "v1").outcome,
    ).toBe("task");
  });

  it("rejects unsupported events", () => {
    expect(() => normalizeGitHubEvent("push", "delivery-3", {})).toThrow(
      UnsupportedGitHubEventError,
    );
  });
});

describe("parseIssueCommand", () => {
  it("recognizes short and namespaced commands", () => {
    expect(parseIssueCommand("/analyze")).toEqual({ kind: "analyze" });
    expect(parseIssueCommand("/apertureprism analyze")).toEqual({
      kind: "analyze",
    });
    expect(parseIssueCommand("/review")).toEqual({ kind: "review" });
    expect(parseIssueCommand("/apertureprism review")).toEqual({
      kind: "review",
    });
    expect(parseIssueCommand("/help")).toEqual({ kind: "help" });
    expect(parseIssueCommand("/apertureprism help")).toEqual({
      kind: "help",
    });
  });

  it("ignores prose, code blocks and unknown slash commands", () => {
    expect(parseIssueCommand("这是一段普通评论")).toEqual({ kind: "none" });
    expect(parseIssueCommand("```\n/analyze\n```")).toEqual({ kind: "none" });
    expect(parseIssueCommand("/some-other-bot do-thing")).toEqual({
      kind: "none",
    });
    expect(parseIssueCommand("")).toEqual({ kind: "none" });
    expect(parseIssueCommand("> /analyze")).toEqual({ kind: "analyze" });
  });
});
