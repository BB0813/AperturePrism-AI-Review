import { z } from "zod";
import type {
  ModelAttemptOutcome,
  ModelCandidate,
  ModelInvocationRequest,
  ModelMessage,
  ModelProviderAdapter,
  ModelUsage,
} from "../../../packages/domain/src/index.js";
import {
  ModelRoutingFailedError,
  routeModelInvocation,
  type RetryPolicy,
} from "../../../packages/model-router/src/index.js";
import type { IssueContext } from "./context.js";

/**
 * System prompt for the ad/spam Issue detector. Deliberately conservative:
 * only the Issue's own content is judged, and `isSpam` must be high-confidence
 * so real reports (even sloppy ones) are never auto-closed.
 */
export const SPAM_SYSTEM_PROMPT = `你是一个严格的 GitHub Issue 内容审核器。你的任务是判断一个 GitHub Issue 是否属于广告 / 垃圾 / 营销内容。

只根据 Issue 的标题与正文内容判断，不要考虑作者身份、发布时间、仓库背景、链接域名等外部因素。

判定为广告/垃圾（isSpam=true）的高置信特征：
- 纯推广性质：推销商品、服务、付费课程、会员、代刷、加群、私信引流等
- 无实质内容的灌水、乱码、随机字符、占位文本
- 与仓库主题完全无关的营销、招聘刷屏、垃圾外链推广
- 明显的营销话术（“限时优惠”“加微信”“点击链接领取”等）

不要误判（isSpam=false）的情形：
- 正常的技术提问、Bug 报告、功能建议，即使表述不够专业
- 主体是真实问题、仅附带少量参考链接的内容
- 信息不足、无法确定时，一律不要判为垃圾

只有高置信度时才输出 isSpam=true；否则输出 isSpam=false，并在 reason 中简要说明理由。

输出必须严格符合以下契约（JSON 对象，不要输出任何解释、Markdown 代码块或额外文字）：
{
  "isSpam": boolean,
  "reason": "不超过 500 字符的判断理由",
  "confidence": 0-1
}`;

export const spamContractSchema = z
  .object({
    isSpam: z.boolean(),
    reason: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type SpamVerdict = z.infer<typeof spamContractSchema>;

export type SpamJsonParse =
  | { outcome: "valid"; verdict: SpamVerdict }
  | { outcome: "invalid"; issues: readonly string[] };

/**
 * Parses a JSON model response without letting syntax errors escape. Returns
 * structured issues so the router can attempt exactly one bounded repair.
 */
export function parseSpamJson(text: string): SpamJsonParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      outcome: "invalid",
      issues: ["root: response was not valid JSON"],
    };
  }
  const parsed = spamContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    };
  }
  return { outcome: "valid", verdict: parsed.data };
}

export function buildSpamDetectionMessages(
  context: IssueContext,
): readonly ModelMessage[] {
  return [
    { role: "system", content: SPAM_SYSTEM_PROMPT },
    { role: "user", content: renderSpamContext(context) },
  ];
}

export function buildSpamDetectionRequest(
  context: IssueContext,
): ModelInvocationRequest {
  return {
    messages: buildSpamDetectionMessages(context),
    responseFormat: "json",
    maxOutputTokens: 500,
    temperature: 0.1,
  };
}

export function buildSpamDetectionRepairRequest(
  context: IssueContext,
  invalidText: string,
  issues: readonly string[],
): ModelInvocationRequest {
  return {
    messages: [
      { role: "system", content: SPAM_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${renderSpamContext(context)}

你上一次的输出没有通过契约校验，错误如下：
${issues.map((issue) => `- ${issue}`).join("\n")}

你上一次的输出：
${invalidText}

请根据错误列表修正，重新只输出一个符合契约的 JSON 对象。`,
      },
    ],
    responseFormat: "json",
    maxOutputTokens: 500,
    temperature: 0.1,
  };
}

function renderSpamContext(context: IssueContext): string {
  const { issue, repository } = context;
  return [
    `仓库: ${repository.owner}/${repository.name}`,
    `Issue #${issue.number}: ${issue.title}`,
    "",
    "## 正文",
    issue.body.length > 0 ? issue.body : "（无正文）",
    "",
    "请仅依据上面的标题与正文内容，输出上述契约要求的 JSON 对象。",
  ].join("\n");
}

export type SpamDetectorOptions = {
  adapters: ReadonlyMap<string, ModelProviderAdapter>;
  candidates: readonly ModelCandidate[];
  /** Shared logical deadline across the main call, retries, and the repair. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type SpamDetectionOutcome =
  | {
      outcome: "valid";
      verdict: SpamVerdict;
      usage: ModelUsage;
      attempts: readonly ModelAttemptOutcome[];
      durationMs: number;
    }
  | {
      outcome: "invalid";
      usage: ModelUsage;
      attempts: readonly ModelAttemptOutcome[];
      durationMs: number;
    };

function totalUsage(...usage: readonly ModelUsage[]): ModelUsage {
  return usage.reduce(
    (total, entry) => ({
      inputTokens: total.inputTokens + entry.inputTokens,
      outputTokens: total.outputTokens + entry.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

function usageFromAttempts(
  attempts: readonly ModelAttemptOutcome[],
): ModelUsage {
  return attempts.reduce(
    (total, attempt) =>
      attempt.usage
        ? {
            inputTokens: total.inputTokens + attempt.usage.inputTokens,
            outputTokens: total.outputTokens + attempt.usage.outputTokens,
          }
        : total,
    { inputTokens: 0, outputTokens: 0 },
  );
}

/**
 * Runs the spam detection, validates the contract, and performs exactly one
 * bounded repair when the contract fails. A model-routing failure (timeout,
 * exhausted candidates) degrades to `invalid` instead of throwing, so callers
 * can always fall back to the normal analysis flow.
 */
export async function detectSpamIssue(
  options: SpamDetectorOptions,
  context: IssueContext,
): Promise<SpamDetectionOutcome> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  try {
    const main = await routeModelInvocation(options.adapters, {
      candidates: options.candidates,
      request: buildSpamDetectionRequest(context),
      deadlineMs: options.deadlineMs,
      retryPolicy: options.retryPolicy,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });

    const validation = parseSpamJson(main.response.content);
    if (validation.outcome === "valid") {
      return {
        outcome: "valid",
        verdict: validation.verdict,
        usage: main.response.usage,
        attempts: main.attempts,
        durationMs: now() - startedAt,
      };
    }

    const remainingMs = Math.max(0, options.deadlineMs - (now() - startedAt));
    const repair = await routeModelInvocation(options.adapters, {
      candidates: options.candidates,
      request: buildSpamDetectionRepairRequest(
        context,
        main.response.content,
        validation.issues,
      ),
      deadlineMs: remainingMs,
      retryPolicy: options.retryPolicy,
      // Prefer the candidate that already answered, so repairs stay consistent.
      stickyCandidate: main.candidate,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });

    const repaired = parseSpamJson(repair.response.content);
    const attempts = [...main.attempts, ...repair.attempts];
    const usage = totalUsage(main.response.usage, repair.response.usage);

    if (repaired.outcome === "valid") {
      return {
        outcome: "valid",
        verdict: repaired.verdict,
        usage,
        attempts,
        durationMs: now() - startedAt,
      };
    }

    return {
      outcome: "invalid",
      usage,
      attempts,
      durationMs: now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ModelRoutingFailedError) {
      return {
        outcome: "invalid",
        usage: usageFromAttempts(error.attempts),
        attempts: error.attempts,
        durationMs: now() - startedAt,
      };
    }
    throw error;
  }
}
