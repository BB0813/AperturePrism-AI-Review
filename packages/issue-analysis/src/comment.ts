import type { GradedIssueAnalysis } from "../../../packages/contracts/src/index.js";
import type { RelatedIssueRow } from "../../../packages/duplicate-detection/src/index.js";

const severityLabels: Readonly<Record<string, string>> = {
  S0: "S0（灾难性）",
  S1: "S1（严重）",
  S2: "S2（中等）",
  S3: "S3（轻微）",
  unknown: "unknown（未知）",
};

const priorityLabels: Readonly<Record<string, string>> = {
  P0: "P0（立即处理）",
  P1: "P1（尽快处理）",
  P2: "P2（常规）",
  P3: "P3（低优先级）",
  needs_triage: "needs_triage（待人工分诊）",
};

const qualityLabels: Readonly<Record<string, string>> = {
  complete: "complete（完整）",
  actionable: "actionable（可操作）",
  incomplete: "incomplete（不完整）",
  invalid: "invalid（无效）",
};

const evidenceKindLabels: Readonly<Record<string, string>> = {
  reproduction_steps: "复现步骤",
  logs: "日志",
  stack_trace: "堆栈",
  data_loss: "数据损坏",
  security_path: "安全路径",
  impact_scope: "影响范围",
};

export function buildPlaceholderComment(): string {
  return "🤖 **AperturePrism** 正在分析该 Issue，完成后会原位更新此评论。";
}

export function buildIssueAnalysisComment(
  analysis: GradedIssueAnalysis,
  related: readonly RelatedIssueRow[] = [],
): string {
  const { result, adjustments } = analysis;
  const lines: string[] = [
    "## 🤖 AperturePrism 分析",
    "",
    `**分类**：${result.category}`,
    `**Severity**：${severityLabels[result.severity] ?? result.severity}`,
    `**Priority**：${priorityLabels[result.priority] ?? result.priority}`,
    `**信息质量**：${qualityLabels[result.quality] ?? result.quality}`,
    "",
    "### 摘要",
    result.summary,
  ];

  if (result.suggestedTitle && result.suggestedTitle.trim().length > 0) {
    lines.push("", `### 建议标题`, result.suggestedTitle.trim());
  }

  if (result.evidence.length > 0) {
    lines.push("", "### 证据", "");
    for (const item of result.evidence) {
      lines.push(
        `- **${evidenceKindLabels[item.kind] ?? item.kind}**：> ${item.excerpt}`,
      );
    }
  }

  if (result.missingInformation.length > 0) {
    lines.push("", "### 缺失信息", "");
    for (const item of result.missingInformation) lines.push(`- ${item}`);
  }

  if (result.suggestedActions.length > 0) {
    lines.push("", "### 建议动作", "");
    for (const item of result.suggestedActions) lines.push(`- [ ] ${item}`);
  }

  if (result.suggestedLabels.length > 0) {
    lines.push("", `### 建议标签`, result.suggestedLabels.join(" "));
  }

  if (adjustments.length > 0) {
    lines.push("", "### 评级调整（服务端规则）", "");
    for (const item of adjustments) {
      lines.push(
        `- ${item.field}: ${item.from} → ${item.to}（${item.reason}）`,
      );
    }
  }

  if (related.length > 0) {
    lines.push("", "### 可能相关的历史 Issue（仅供参考，不自动关联）", "");
    for (const item of related.slice(0, 5)) {
      const repo = item.repositoryFullName ?? "unknown/repo";
      const reason = item.reasons.includes("signal") ? "信号" : "文本";
      lines.push(
        `- [#${item.issueNumber}](https://github.com/${repo}/issues/${item.issueNumber}) · ${repo}（${reason} 相似）`,
      );
    }
  }

  const confidence = result.confidence;
  lines.push(
    "",
    "---",
    "> 置信度：severity "
      .concat(formatConfidence(confidence.severity))
      .concat(" · root cause ")
      .concat(formatConfidence(confidence.rootCause))
      .concat(" · suggestion ")
      .concat(formatConfidence(confidence.suggestion)),
    "> 由 AperturePrism 自动生成，评级已由服务端规则校验。",
  );

  return lines.join("\n");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}
