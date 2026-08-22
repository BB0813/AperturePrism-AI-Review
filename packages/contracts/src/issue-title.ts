import type { IssueAnalysisResult } from "./issue-analysis.js";

/** GitHub 标题上限 256 字符；留出余量避免被截断在多字节字符中间。 */
const maxTitleLength = 200;

export type IssueImportance = "low" | "medium" | "high";

/**
 * 由已校验的 severity/priority 推导重要度。两者取更紧急的一方，因为高影响
 * 与高紧急都值得让维护者先看到。unknown/needs_triage 不抬高重要度。
 */
export function deriveImportance(
  result: Pick<IssueAnalysisResult, "severity" | "priority">,
): IssueImportance {
  if (result.severity === "S0" || result.priority === "P0") return "high";
  if (result.severity === "S1" || result.priority === "P1") return "high";
  if (result.severity === "S2" || result.priority === "P2") return "medium";
  return "low";
}

/** 去掉已有的前缀，避免反复改写标题时叠加 [x][y][x][y]。 */
function stripExistingPrefix(title: string): string {
  let rest = title.trim();
  // 只剥离形如 [xxx] 的连续前缀，正文里的方括号不受影响。
  while (true) {
    const match = /^\[[^\]]{1,40}\]\s*/.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length);
  }
  return rest.trim();
}

/**
 * 按 issue #5 的要求拼装 `[标签][重要度]标题`。前缀由服务端拼装而非要求模型
 * 自造：标签与重要度已经是结构化字段，让模型再拼一遍只会引入格式漂移。
 *
 * 无可用标签时省略标签段，不输出 `[]` 占位。
 */
export function formatSuggestedTitle(
  result: Pick<
    IssueAnalysisResult,
    "severity" | "priority" | "suggestedLabels" | "suggestedTitle"
  >,
): string | undefined {
  const base = stripExistingPrefix(result.suggestedTitle ?? "");
  if (base.length === 0) return undefined;

  const label = (result.suggestedLabels[0] ?? "").trim();
  const importance = deriveImportance(result);
  const prefix = label ? `[${label}][${importance}]` : `[${importance}]`;
  return `${prefix}${base}`.slice(0, maxTitleLength);
}
