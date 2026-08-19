/**
 * Agent Skills: a registry + pure selection/render helpers. Aligns with the
 * reference project's `skill_service` / `builtin_skills`: each skill is a
 * reusable capability that attaches a focused prompt fragment to a model call.
 */

export type SkillAppliesTo = "issue" | "pr";

export type Skill = {
  id: string;
  name: string;
  appliesTo: SkillAppliesTo;
  description: string;
  promptFragment: string;
};

/** Keyword sets per skill id, used by `selectSkills` for context matching. */
const SKILL_KEYWORDS: Record<string, readonly string[]> = {
  issue_triage: [
    "bug",
    "crash",
    "error",
    "exception",
    "错误",
    "崩溃",
    "缺陷",
    "异常",
    "无法",
    "失败",
  ],
  security_review: [
    "password",
    "token",
    "secret",
    "credential",
    "key",
    "sql",
    "injection",
    "xss",
    "csrf",
    "auth",
    "cookie",
    "header",
    "permission",
    "密钥",
    "凭据",
    "注入",
    "权限",
    "越权",
    "泄露",
  ],
  dependency_review: [
    "package.json",
    "package-lock",
    "pnpm",
    "yarn",
    "lockfile",
    "dependency",
    "dependencies",
    "devdependency",
    "version",
    "upgrade",
    "依赖",
    "升级",
    "降级",
  ],
  performance_review: [
    "for (",
    "while",
    "recursion",
    "recursive",
    "cache",
    "redis",
    "async",
    "await",
    "timeout",
    "memory",
    "循环",
    "递归",
    "缓存",
    "性能",
    "复杂度",
    "并发",
  ],
  docs_review: [
    "readme",
    "doc",
    "documentation",
    "comment",
    "example",
    "usage",
    "说明",
    "文档",
    "注释",
    "示例",
  ],
  test_effectiveness: [
    "test",
    "spec",
    "jest",
    "vitest",
    "assert",
    "expect",
    "coverage",
    "it(",
    "describe(",
    "测试",
    "断言",
    "用例",
    "覆盖",
  ],
};

export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    id: "issue_triage",
    name: "Issue 分类与优先级评估",
    appliesTo: "issue",
    description:
      "对 Issue 进行快速分类（缺陷/需求/疑问）与影响范围评估，给出严重度、优先级与建议动作。",
    promptFragment:
      "请从 Issue 分类与优先级的角度审视：该 Issue 是缺陷、需求还是疑问？影响范围多大？\
严重度与优先级如何？是否存在缺失的关键信息（复现步骤、环境、日志）？\
给出可执行的下一步建议，避免仅做表面归类。",
  },
  {
    id: "security_review",
    name: "安全审查",
    appliesTo: "pr",
    description:
      "从安全视角审查变更：注入、认证/授权、密钥泄露、SSRF/路径穿越、敏感数据暴露等。",
    promptFragment:
      "请从应用安全的角度审查变更：是否存在注入（SQL/命令/模板）、认证与授权绕过、\
硬编码或泄露的密钥/凭据、SSRF/路径穿越、敏感数据（PII/Token）暴露、不安全的加密或哈希用法？\
证据不足时不要臆测，只针对 diff 中真实出现的风险点给出意见。",
  },
  {
    id: "dependency_review",
    name: "依赖审查",
    appliesTo: "pr",
    description:
      "审查依赖变更：版本升级/降级影响、已知漏洞、兼容性破坏、锁文件一致性。",
    promptFragment:
      "请从依赖治理的角度审查变更：版本升级/降级是否带来破坏性变更或已知漏洞？\
新增依赖是否必要、来源是否可信？锁文件（package-lock/pnpm-lock/yarn.lock）是否与声明一致？\
若上下文未包含具体依赖内容，请在总结中说明无法核实，不要凭空断言某个依赖存在漏洞。",
  },
  {
    id: "performance_review",
    name: "性能审查",
    appliesTo: "pr",
    description:
      "评估变更的性能影响：算法复杂度、循环/递归、I/O 与网络、缓存、资源泄漏与并发。",
    promptFragment:
      "请从性能的角度审查变更：是否存在无界循环/递归、O(n²) 及以上的复杂度退化、\
重复计算、不必要的同步阻塞、连接/句柄/内存泄漏、缺少缓存或并发竞争？\
对每次请求高频路径上的热点代码尤其敏感；对一次性脚本或低频路径不要过度苛责。",
  },
  {
    id: "docs_review",
    name: "文档与可读性审查",
    appliesTo: "pr",
    description:
      "检查文档/可读性：注释、README/API 文档是否随变更更新，命名与对外契约是否清晰。",
    promptFragment:
      "请从文档与可读性的角度审查变更：对外 API/契约变更是否同步更新了文档与示例？\
关键逻辑是否有清晰注释？命名是否表意、与既有风格一致？\
文档缺失属于低危意见，请以 suggestion 呈现，不要因此阻塞整体结论。",
  },
  {
    id: "test_effectiveness",
    name: "测试有效性审查",
    appliesTo: "pr",
    description:
      "评估测试质量：变更是否被测试覆盖、断言是否有效、边界与回归风险。",
    promptFragment:
      "请从测试有效性的角度审查变更：关键行为是否有对应测试？断言是否真正校验了行为\
（而非只测了实现细节或从不失败）？边界条件、错误路径、回归风险是否被覆盖？\
缺少测试属于 suggestion 级别意见，请具体指出应补充的用例场景。",
  },
];

/**
 * Selects skills for a target type. The context text is matched against each
 * skill's keyword set; when nothing hits, the full set for that type is kept
 * so a review always carries the relevant perspectives.
 */
export function selectSkills(
  appliesTo: SkillAppliesTo,
  contextText: string,
): Skill[] {
  const ofType = BUILTIN_SKILLS.filter(
    (skill) => skill.appliesTo === appliesTo,
  );
  const text = contextText.toLowerCase();
  const matched = ofType.filter((skill) =>
    (SKILL_KEYWORDS[skill.id] ?? []).some((keyword) =>
      text.includes(keyword.toLowerCase()),
    ),
  );
  return matched.length > 0 ? matched : ofType;
}

/** Renders selected skills as one text block appended to a model prompt. */
export function renderSkillPrompts(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  return skills
    .map(
      (skill) =>
        `## 技能：${skill.name}（${skill.id}）\n${skill.promptFragment}`,
    )
    .join("\n\n");
}
