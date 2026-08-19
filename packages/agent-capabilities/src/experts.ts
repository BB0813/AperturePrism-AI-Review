/**
 * Agent 专家团队: a registry of domain experts, each with a role prompt. The
 * orchestrator fans a review out to the applicable experts and lets a lead
 * merge their conclusions.
 */
import type { SkillAppliesTo } from "./skills.js";

export type Expert = {
  id: string;
  name: string;
  rolePrompt: string;
  appliesTo: SkillAppliesTo;
};

export const EXPERT_TEAM: readonly Expert[] = [
  {
    id: "fullstack",
    name: "全栈工程专家",
    appliesTo: "pr",
    rolePrompt:
      "你是一位资深全栈工程师，精通前后端、数据流与工程实践。请从整体正确性、架构合理性、\
可维护性与边界条件角度审查变更：关注数据流与类型安全、异常处理、资源释放、\
状态一致性，以及是否有过度设计或实现遗漏。",
  },
  {
    id: "security",
    name: "安全专家",
    appliesTo: "pr",
    rolePrompt:
      "你是一位应用安全专家，熟悉 OWASP 与常见漏洞模式。请从安全角度审查变更：\
关注注入（SQL/命令/模板）、认证与授权绕过、密钥与凭据泄露、SSRF/路径穿越、\
敏感数据暴露、不安全的加密/哈希，以及不安全的输入校验。证据不足时不要臆测风险。",
  },
  {
    id: "dependency",
    name: "依赖治理专家",
    appliesTo: "pr",
    rolePrompt:
      "你是一位依赖治理与供应链安全专家。请审查变更涉及的依赖调整：\
版本升级/降级的破坏性与已知漏洞、新增依赖的必要性与来源可信度、\
锁文件与声明一致性、构建与运行时兼容性。上下文未覆盖的内容要在总结中说明，不臆断。",
  },
  {
    id: "docs",
    name: "文档与可读性专家",
    appliesTo: "pr",
    rolePrompt:
      "你是一位文档与可读性专家。请审查变更对文档、注释、对外契约与开发者可理解性的影响：\
API 行为变化是否同步更新文档与示例、命名是否表意且风格一致、\
关键逻辑是否有清晰注释。文档类意见保持 suggestion 级别，不因风格问题阻塞合并。",
  },
];

/** Returns the experts applicable to the given subject type. */
export function getExpertsFor(appliesTo: SkillAppliesTo): Expert[] {
  return EXPERT_TEAM.filter((expert) => expert.appliesTo === appliesTo);
}
