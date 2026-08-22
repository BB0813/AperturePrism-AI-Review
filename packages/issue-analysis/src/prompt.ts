import type {
  ModelInvocationRequest,
  ModelMessage,
} from "../../../packages/domain/src/index.js";
import type { IssueContext } from "./context.js";

/** Bump when the prompt semantics change so the idempotency key changes too. */
export const ISSUE_ANALYSIS_PROMPT_VERSION = "v1" as const;
/** Policy version embedded in task dedupe keys; must include the prompt version. */
export const ISSUE_ANALYSIS_POLICY_VERSION =
  `issue-analysis-${ISSUE_ANALYSIS_PROMPT_VERSION}` as const;

const CONTRACT_VERSION = "issue-analysis/v1";

const systemPrompt = `你是一个严谨的 GitHub Issue 分析器。你的任务是基于 Issue 正文和评论，输出一份结构化分析 JSON。

输出必须严格符合以下契约（JSON 对象，不要输出任何解释、Markdown 代码块或额外文字）：
{
  "contractVersion": "${CONTRACT_VERSION}",
  "category": "bug | feature | question | security | performance | documentation | other",
  "summary": "不超过 2000 字符的一句话或短段落总结",
  "severity": "S0 | S1 | S2 | S3 | unknown",
  "priority": "P0 | P1 | P2 | P3 | needs_triage",
  "quality": "complete | actionable | incomplete | invalid",
  "suggestedTitle": "可选：当原标题含糊/冗长时给出的更清晰标题（≤120 字符）；原标题已清晰则省略该字段",
  "evidence": [{ "kind": "reproduction_steps | logs | stack_trace | data_loss | security_path | impact_scope", "excerpt": "来自 Issue 的原文摘录" }],
  "missingInformation": ["Issue 未提供、且对判断很重要的事实，最多 10 条"],
  "suggestedLabels": ["建议的标签，最多 10 个"],
  "suggestedActions": ["建议的下一步动作，最多 10 条"],
  "confidence": { "severity": 0-1, "rootCause": 0-1, "suggestion": 0-1 }
}

评分规则（必须遵守）：
- severity 与 priority 是两个独立的判断，不要合并。
- 只有存在实质证据时才能给出 S0/S1 或 P0/P1。实质证据包括：复现步骤、日志、堆栈、数据损坏、安全路径。
- "impact_scope"（影响范围）不是实质证据：模型可以凭空声称影响所有用户，但造不出堆栈或日志。仅有 impact_scope 时，severity 应为 unknown、priority 应为 needs_triage。
- missingInformation 只能列出 Issue 中实际缺失的事实，绝对不要编造。
- missingInformation 必须与本 Issue 的具体故障直接相关，只列出「拿到后能推进定位」的信息；不要套用通用报告模板。特别注意：
  - 不要索要与故障无关的环境信息。WebUI 或服务端的功能缺陷通常与用户的操作系统、浏览器版本无关，只有在问题表现为渲染异常、兼容性或前端崩溃时才值得询问。
  - 不要在与模型调用无关的问题上索要模型名称或模型配置方式。界面按钮、同步、连接状态一类的缺陷与选用哪个模型无关。
  - 优先索要能直接定位的线索：确切的错误提示原文、失败的操作步骤、相关服务日志、涉及的仓库或任务标识。
- 用户可能无法提供日志（例如故障出现在 WebUI 内部或第三方插件中）。这种情况下不要把「提供日志」作为唯一动作，应基于现有描述给出可执行的排查或修复方向。
- 信息不足以判断根因时，quality 使用 incomplete，并在 missingInformation 中说明缺什么。
- 这是第一版分析：只建议标签和动作，不要建议关闭 Issue。
- 上下文可能被降级（正文被截断或评论被省略），此时要更谨慎，不要凭残缺信息下高置信度结论。`;

export function buildIssueAnalysisMessages(
  context: IssueContext,
): readonly ModelMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: renderIssueContext(context) },
  ];
}

export function buildIssueAnalysisRepairRequest(
  context: IssueContext,
  invalidText: string,
  issues: readonly string[],
): ModelInvocationRequest {
  return {
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `${renderIssueContext(context)}

你上一次的输出没有通过契约校验，错误如下：
${issues.map((issue) => `- ${issue}`).join("\n")}

你上一次的输出：
${invalidText}

请根据错误列表修正，重新只输出一个符合契约的 JSON 对象。`,
      },
    ],
    responseFormat: "json",
    maxOutputTokens: 1_500,
    temperature: 0.1,
  };
}

export function buildIssueAnalysisRequest(
  context: IssueContext,
): ModelInvocationRequest {
  return {
    messages: buildIssueAnalysisMessages(context),
    responseFormat: "json",
    maxOutputTokens: 1_500,
    temperature: 0.2,
  };
}

function renderIssueContext(context: IssueContext): string {
  const { issue, repository } = context;
  const lines: string[] = [
    `仓库: ${repository.owner}/${repository.name}`,
    `Issue #${issue.number}: ${issue.title}`,
    `状态: ${issue.state}`,
    `作者: ${issue.author ?? "unknown"}`,
    `创建时间: ${issue.createdAt || "unknown"}`,
    `标签: ${issue.labels.length > 0 ? issue.labels.join(", ") : "无"}`,
    `URL: ${issue.htmlUrl || "unknown"}`,
    "",
    "## 正文",
    issue.body.length > 0 ? issue.body : "（无正文）",
  ];
  if (context.comments.length > 0) {
    lines.push("", "## 评论");
    for (const comment of context.comments) {
      lines.push(
        `- @${comment.author ?? "unknown"} (${comment.createdAt || "unknown"}): ${comment.body}`,
      );
    }
  }
  if (context.degraded.length > 0) {
    lines.push("", `注意：上下文被降级：${context.degraded.join("、")}。`);
  }
  if (context.repoMemory && context.repoMemory.length > 0) {
    lines.push(
      "",
      "## 仓库记忆（过往分析经验）",
      context.repoMemory,
      "",
      "以上是该仓库历史上沉淀的规则与知识，仅供参考：若与当前 Issue 的事实冲突，以当前 Issue 为准，不要盲从。",
    );
  }
  lines.push("", "请输出上述契约要求的 JSON 对象。");
  return lines.join("\n");
}
