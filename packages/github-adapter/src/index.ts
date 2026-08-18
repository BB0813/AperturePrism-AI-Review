import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CreateTaskInput } from "../../../packages/domain/src/index.js";

export * from "./client.js";

export type GitHubEventName =
  "issues" | "issue_comment" | "pull_request" | "ping";

export type NormalizedGitHubEvent = {
  deliveryId: string;
  eventName: GitHubEventName;
  action: string;
  installationId: string | null;
  repositoryId: string | null;
  repositoryFullName: string | null;
  subjectNumber: number | null;
  subjectRevision: string | null;
  receivedAt: string;
  payload: unknown;
};

export type GitHubTaskMapping =
  | { outcome: "task"; task: CreateTaskInput }
  | { outcome: "ignored"; reason: string }
  | { outcome: "invalid"; reason: string };

export class WebhookSignatureError extends Error {
  constructor() {
    super("invalid GitHub webhook signature");
    this.name = "WebhookSignatureError";
  }
}

export class UnsupportedGitHubEventError extends Error {
  constructor(eventName: string) {
    super(`unsupported GitHub event: ${eventName}`);
    this.name = "UnsupportedGitHubEventError";
  }
}

export function verifyWebhookSignature(
  payload: Buffer,
  signature: string | undefined,
  secret: string,
): void {
  if (!signature?.startsWith("sha256=") || !secret)
    throw new WebhookSignatureError();
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
  );
  const received = Buffer.from(signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new WebhookSignatureError();
  }
}

function stringValue(value: unknown): string | null {
  return (typeof value === "string" || typeof value === "number") &&
    String(value).length > 0
    ? String(value)
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeGitHubEvent(
  eventName: string,
  deliveryId: string,
  payload: unknown,
  receivedAt = new Date().toISOString(),
): NormalizedGitHubEvent {
  if (
    !["issues", "issue_comment", "pull_request", "ping"].includes(eventName)
  ) {
    throw new UnsupportedGitHubEventError(eventName);
  }
  const root = objectValue(payload);
  const repository = objectValue(root.repository);
  const installation = objectValue(root.installation);
  const issue = objectValue(root.issue);
  const pullRequest = objectValue(root.pull_request);
  const subject = eventName === "pull_request" ? pullRequest : issue;

  return {
    deliveryId,
    eventName: eventName as GitHubEventName,
    action: stringValue(root.action) ?? "unknown",
    installationId: stringValue(installation.id),
    repositoryId: stringValue(repository.id),
    repositoryFullName: stringValue(repository.full_name),
    subjectNumber: numberValue(subject.number),
    subjectRevision:
      eventName === "pull_request"
        ? stringValue(pullRequest.head && objectValue(pullRequest.head).sha)
        : stringValue(issue.updated_at),
    receivedAt,
    payload,
  };
}

const issueActions = new Set(["opened", "edited", "reopened"]);
const pullRequestActions = new Set(["opened", "reopened", "synchronize"]);

function policyRevision(event: NormalizedGitHubEvent): string {
  return createHash("sha256")
    .update(
      [
        event.eventName,
        event.repositoryId,
        event.subjectNumber,
        event.subjectRevision,
      ].join(":"),
    )
    .digest("hex");
}

export function mapGitHubEventToTask(
  event: NormalizedGitHubEvent,
  repositoryId: string,
  policyVersion: string,
): GitHubTaskMapping {
  if (event.eventName === "ping") return { outcome: "ignored", reason: "ping" };
  if (event.eventName === "issue_comment")
    return { outcome: "ignored", reason: "comment_commands_not_enabled" };
  if (
    (event.eventName === "issues" && !issueActions.has(event.action)) ||
    (event.eventName === "pull_request" &&
      !pullRequestActions.has(event.action))
  ) {
    return { outcome: "ignored", reason: "unsupported_action" };
  }
  if (!event.repositoryId || !event.repositoryFullName)
    return { outcome: "invalid", reason: "missing_repository" };
  if (event.subjectNumber === null)
    return { outcome: "invalid", reason: "missing_subject_number" };
  if (!event.subjectRevision)
    return { outcome: "invalid", reason: "missing_subject_revision" };

  const taskType =
    event.eventName === "issues" ? "issue_analysis" : "pr_review";
  const keyPrefix =
    event.eventName === "issues" ? "issue-analysis" : "pr-review";
  return {
    outcome: "task",
    task: {
      taskType,
      repositoryId,
      subjectNumber: event.subjectNumber,
      subjectRevision: event.subjectRevision,
      policyVersion,
      dedupeKey: `${keyPrefix}:${repositoryId}:${event.subjectNumber}:${event.subjectRevision}:${policyVersion}`,
      payload: {
        installationId: event.installationId,
        repositoryExternalId: event.repositoryId,
        repositoryFullName: event.repositoryFullName,
        subjectNumber: event.subjectNumber,
        subjectRevision: event.subjectRevision,
        sourceEvent: event.eventName,
        sourceRevision: policyRevision(event),
      },
    },
  };
}
