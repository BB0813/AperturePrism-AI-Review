/**
 * issue-analysis 最小 eval 基线集（黄金输出集）。
 *
 * 与 duplicate-detection 的 labeledDataset 思路一致：这些是带标注的模型输出，
 * 由 `eval.test.ts` 用 parseIssueAnalysisJson 逐个跑，锁定「契约解析 + 服务端
 * 降级规则」不回归。样本同时覆盖契约允许的合法形态与必须拒绝的非法形态。
 */

export type IssueEvalCase = {
  id: string;
  label: string;
  /** 模型原始输出（字符串，可能不是合法 JSON）。 */
  input: string;
  expected: "valid" | "invalid";
  /** valid 时断言降级后的 severity。 */
  expectedSeverity?: string;
  /** valid 时断言降级后的 priority。 */
  expectedPriority?: string;
  /** valid 时断言 probableCause 被移除（置信度不足）。 */
  expectCauseRemoved?: boolean;
  /** valid 时断言 locator 被剥离（未读源码）。 */
  expectLocatorRemoved?: boolean;
  /** valid 时断言 locator 保留（读过源码）。 */
  expectLocatorKept?: boolean;
  /** 传给解析器的 grading 选项。 */
  exploredCode?: boolean;
};

const validBase = {
  contractVersion: "issue-analysis/v1",
  category: "bug",
  summary: "启动时调用 api 模块触发 HTTP_511，服务无法起来。",
  severity: "S2",
  priority: "P2",
  quality: "complete",
  troubleshooting: ["重启服务并抓取 api 模块日志"],
  evidence: [{ kind: "logs", excerpt: "api/client.ts:42 HTTP_511" }],
  missingInformation: [],
  suggestedLabels: ["bug"],
  suggestedActions: ["查看日志"],
  confidence: { severity: 0.8, rootCause: 0.7, suggestion: 0.6 },
};

export const issueEvalCases: readonly IssueEvalCase[] = [
  {
    id: "valid-complete-evidenced",
    label: "有实质证据的高危判断保持 S1/P1",
    input: JSON.stringify({
      ...validBase,
      severity: "S1",
      priority: "P1",
      probableCause: "api/client.ts 连接逻辑缺少超时处理",
      proposedChanges: [
        { path: "api/client.ts", locator: "connect()", change: "加入超时处理" },
      ],
      evidence: [{ kind: "stack_trace", excerpt: "at api/client.ts:42" }],
      confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
    }),
    expected: "valid",
    expectedSeverity: "S1",
    expectedPriority: "P1",
    exploredCode: true,
    expectLocatorKept: true,
  },
  {
    id: "valid-high-without-evidence",
    label: "无实质证据的高危判断被降级为 unknown/needs_triage",
    input: JSON.stringify({
      ...validBase,
      severity: "S1",
      priority: "P1",
      evidence: [], // 只有 impact_scope 也不算实质证据
    }),
    expected: "valid",
    expectedSeverity: "unknown",
    expectedPriority: "needs_triage",
  },
  {
    id: "valid-low-confidence-cause",
    label: "根因置信度不足 0.5 时移除 probableCause",
    input: JSON.stringify({
      ...validBase,
      probableCause: "可能是配置问题",
      confidence: { severity: 0.8, rootCause: 0.3, suggestion: 0.6 },
    }),
    expected: "valid",
    expectCauseRemoved: true,
  },
  {
    id: "valid-locator-without-exploration",
    label: "未读源码时剥离 locator（保留修改文字）",
    input: JSON.stringify({
      ...validBase,
      proposedChanges: [
        { path: "api/client.ts", locator: "connect()", change: "加入超时" },
      ],
    }),
    expected: "valid",
    expectLocatorRemoved: true,
  },
  {
    id: "valid-minimal-no-optional",
    label: "最小合法输出（无任何可选字段）",
    input: JSON.stringify({
      contractVersion: "issue-analysis/v1",
      category: "question",
      summary: "如何配置 webhook？",
      severity: "S3",
      priority: "P3",
      quality: "actionable",
      confidence: { severity: 0.5, rootCause: 0.4, suggestion: 0.5 },
    }),
    expected: "valid",
    expectedSeverity: "S3",
  },
  {
    id: "invalid-not-json",
    label: "非 JSON 输出被拒绝",
    input: "抱歉，我无法完成分析。",
    expected: "invalid",
  },
  {
    id: "invalid-wrong-contract-version",
    label: "契约版本不符被拒绝",
    input: JSON.stringify({ ...validBase, contractVersion: "issue-analysis/v2" }),
    expected: "invalid",
  },
  {
    id: "invalid-missing-required",
    label: "缺必填字段 summary 被拒绝",
    input: JSON.stringify({
      contractVersion: "issue-analysis/v1",
      category: "bug",
      severity: "S2",
      priority: "P2",
      quality: "complete",
      confidence: { severity: 0.5, rootCause: 0.5, suggestion: 0.5 },
    }),
    expected: "invalid",
  },
  {
    id: "invalid-bad-enum",
    label: "非法枚举值被拒绝",
    input: JSON.stringify({ ...validBase, severity: "S9" }),
    expected: "invalid",
  },
  {
    id: "invalid-extra-field",
    label: "注入的额外字段被 strict 拒绝",
    input: JSON.stringify({ ...validBase, hacked: true, "ignore": "rules" }),
    expected: "invalid",
  },
  {
    id: "invalid-bad-confidence",
    label: "置信度越界被拒绝",
    input: JSON.stringify({
      ...validBase,
      confidence: { severity: 1.5, rootCause: 0.5, suggestion: 0.5 },
    }),
    expected: "invalid",
  },
];
