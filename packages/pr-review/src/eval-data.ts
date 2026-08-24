/**
 * pr-review 最小 eval 基线集（黄金输出集）。
 *
 * 与 duplicate-detection / issue-analysis 的 eval 思路一致：这些是带标注的
 * 模型输出，由 `eval.test.ts` 用 parsePrReviewJson 逐个跑，锁定「契约解析 +
 * 服务端严重度策略 + 发布过滤」不回归。
 */

export type PrEvalCase = {
  id: string;
  label: string;
  input: string;
  expected: "valid" | "invalid";
  /** valid 时断言策略过滤后的 findings 数量。 */
  expectedFindings?: number;
};

/** 一条带证据、可发布的高危 finding。 */
const validFinding = {
  rule: "missing-null-check",
  severity: "high",
  file: "src/a.ts",
  message: "可能为空的对象没有判空。",
  evidence: "const x = maybe(); x.foo();",
  impact: "运行时空指针崩溃。",
  confidence: 0.8,
  suggestion: "调用前先判空并给出降级路径。",
  afterLine: 12,
};

const validBase = {
  contractVersion: "pr-review/v1",
  summary: "本次改动把旧 helper 迁移到新 helper，并补了判空。",
  changedFileCount: 1,
  additions: 2,
  deletions: 1,
  overallTone: "changes_requested",
  findings: [validFinding],
};

export const prEvalCases: readonly PrEvalCase[] = [
  {
    id: "valid-approve-empty",
    label: "无问题的 PR 输出 approve 且 findings 为空",
    input: JSON.stringify({
      contractVersion: "pr-review/v1",
      summary: "改动简单且无风险。",
      changedFileCount: 1,
      additions: 1,
      deletions: 1,
      overallTone: "approve",
      findings: [],
    }),
    expected: "valid",
    expectedFindings: 0,
  },
  {
    id: "valid-changes-requested",
    label: "带证据的高危 finding 保留并发布",
    input: JSON.stringify(validBase),
    expected: "valid",
    expectedFindings: 1,
  },
  {
    id: "valid-info-nonpublishable",
    label: "info 级意见被发布策略过滤（输出仍合法）",
    input: JSON.stringify({
      ...validBase,
      overallTone: "comment",
      findings: [
        {
          rule: "style-naming",
          severity: "info",
          file: "src/a.ts",
          message: "变量命名建议。",
          evidence: "const x = 1;",
          impact: "可读性。",
          confidence: 0.9,
          suggestion: "改用更语义化的名字。",
          afterLine: 1,
        },
      ],
    }),
    expected: "valid",
    expectedFindings: 0,
  },
  {
    id: "valid-high-downgraded-no-line",
    label: "无行号的高危 finding 被降级但仍可发布",
    input: JSON.stringify({
      ...validBase,
      findings: [
        {
          ...validFinding,
          severity: "critical",
          afterLine: 0, // 无锚点行号 → 降级到 medium
        },
      ],
    }),
    expected: "valid",
    expectedFindings: 1,
  },
  {
    id: "invalid-not-json",
    label: "非 JSON 输出被拒绝",
    input: "这段 diff 没问题。",
    expected: "invalid",
  },
  {
    id: "invalid-wrong-contract-version",
    label: "契约版本不符被拒绝",
    input: JSON.stringify({ ...validBase, contractVersion: "pr-review/v2" }),
    expected: "invalid",
  },
  {
    id: "invalid-missing-summary",
    label: "缺 summary 被拒绝",
    input: JSON.stringify({
      contractVersion: "pr-review/v1",
      changedFileCount: 1,
      additions: 1,
      deletions: 1,
      overallTone: "approve",
      findings: [],
    }),
    expected: "invalid",
  },
  {
    id: "invalid-bad-severity",
    label: "非法严重度被拒绝",
    input: JSON.stringify({
      ...validBase,
      findings: [{ ...validFinding, severity: "urgent" }],
    }),
    expected: "invalid",
  },
  {
    id: "invalid-extra-field",
    label: "注入的额外字段被 strict 拒绝",
    input: JSON.stringify({ ...validBase, hacked: true }),
    expected: "invalid",
  },
  {
    id: "invalid-missing-evidence",
    label: "finding 缺证据字段被拒绝",
    input: JSON.stringify({
      ...validBase,
      findings: [
        {
          rule: "x",
          severity: "medium",
          file: "src/a.ts",
          message: "m",
          impact: "i",
          confidence: 0.8,
          suggestion: "s",
          afterLine: 1,
        },
      ],
    }),
    expected: "invalid",
  },
  {
    id: "invalid-negative-afterline",
    label: "负数行号被拒绝",
    input: JSON.stringify({
      ...validBase,
      findings: [{ ...validFinding, afterLine: -1 }],
    }),
    expected: "invalid",
  },
];
