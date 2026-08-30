import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import type { IssueContext } from "./context.js";
import {
  detectSpamIssue,
  parseSpamJson,
  type SpamDetectorOptions,
} from "./spam.js";

const candidate: ModelCandidate = {
  provider: "provider-a",
  model: "model-a",
  accountName: "account-a",
};

const context: IssueContext = {
  repository: { owner: "o", name: "r" },
  installationId: "42",
  issue: {
    number: 7,
    title: "买会员，加微信 xxx 领优惠券",
    body: "限时优惠，点击链接领取专属折扣 https://example.com/sale",
    state: "open",
    htmlUrl: "https://github.test/o/r/issues/7",
    author: "spammer",
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T01:00:00Z",
    labels: [],
  },
  comments: [],
  degraded: [],
  estimatedTokens: 10,
  images: [],
};

const spamVerdictJson = JSON.stringify({
  isSpam: true,
  reason: "纯营销推广内容，与仓库无关",
  confidence: 0.97,
});

function scriptedAdapter(provider: string, contents: readonly string[]) {
  let calls = 0;
  const adapter: ModelProviderAdapter = {
    provider,
    invoke: async () => {
      const content = contents[Math.min(calls, contents.length - 1)] ?? "";
      calls += 1;
      return { content, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { adapter, calls: () => calls };
}

function failingAdapter(
  provider: string,
  category: ModelInvocationError["category"],
) {
  const adapter: ModelProviderAdapter = {
    provider,
    invoke: async () => {
      throw new ModelInvocationError(category, `provider ${category}`);
    },
  };
  return adapter;
}

function options(
  adapters: ModelProviderAdapter[],
  candidates: readonly ModelCandidate[],
): SpamDetectorOptions {
  return {
    adapters: new Map(adapters.map((entry) => [entry.provider, entry])),
    candidates,
    deadlineMs: 10_000,
    retryPolicy: {
      maxAttemptsPerCandidate: 1,
      baseDelayMs: 10,
      maxDelayMs: 100,
    },
    now: () => 0,
    sleep: async () => undefined,
  };
}

describe("spam detection orchestration", () => {
  it("returns a verdict for valid model output", async () => {
    const { adapter, calls } = scriptedAdapter("provider-a", [spamVerdictJson]);
    const outcome = await detectSpamIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.verdict).toEqual({
      isSpam: true,
      reason: "纯营销推广内容，与仓库无关",
      confidence: 0.97,
    });
    expect(calls()).toBe(1);
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("performs one bounded repair and accepts the corrected output", async () => {
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "not valid json",
      spamVerdictJson,
    ]);
    const outcome = await detectSpamIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.verdict.isSpam).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("reports invalid when the repair also fails", async () => {
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "not valid json",
      JSON.stringify({ isSpam: "yes" }),
    ]);
    const outcome = await detectSpamIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("invalid");
  });

  it("degrades to invalid instead of throwing on a provider timeout", async () => {
    const adapter = failingAdapter("provider-a", "timeout");
    const outcome = await detectSpamIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(outcome.outcome).toBe("invalid");
  });

  it("degrades to invalid instead of throwing on a hard provider failure", async () => {
    const adapter = failingAdapter("provider-a", "server_error");
    const outcome = await detectSpamIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(outcome.outcome).toBe("invalid");
  });
});

describe("parseSpamJson", () => {
  it("accepts a well-formed verdict", () => {
    const parsed = parseSpamJson(spamVerdictJson);
    expect(parsed.outcome).toBe("valid");
    if (parsed.outcome !== "valid") return;
    expect(parsed.verdict.isSpam).toBe(true);
  });

  it("rejects non-JSON input with a structured issue", () => {
    const parsed = parseSpamJson("definitely not json");
    expect(parsed.outcome).toBe("invalid");
    if (parsed.outcome !== "invalid") return;
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("rejects extra contract fields", () => {
    const parsed = parseSpamJson(
      JSON.stringify({ ...JSON.parse(spamVerdictJson), extra: 1 }),
    );
    expect(parsed.outcome).toBe("invalid");
  });
});
