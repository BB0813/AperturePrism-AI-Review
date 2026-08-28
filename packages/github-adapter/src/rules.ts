import type { GitHubClient } from "./client.js";

/**
 * 仓库审核规则文件夹（Sakura 式专属目录）。每个仓库可在默认分支根部维护
 * `.apertureprism/rules/` 目录，放入任意数量的 Markdown 规则文件（如
 * `review-checklist.md`、`hard-rules.md`）。分析 Issue / PR 时这些规则会被
 * 读取并注入上下文，使各仓库可用同一套审核引擎 + 各自专属的审核规则。
 *
 * 路径命名对标 Sakura 的 `.sakura/` 专属目录，本项目专属前缀为
 * `.apertureprism/`。
 */
export const REPO_RULES_DIR = ".apertureprism/rules";

/** 单个规则文件的读取上限（字符），防止超大文件撑爆上下文。 */
export const MAX_RULE_FILE_CHARS = 8_000;
/** 最多读取的规则文件数，超过部分忽略。 */
export const MAX_RULE_FILES = 10;

export type RepoRulesOptions = {
  installationId: string;
  owner: string;
  name: string;
};

/**
 * 首次分析时自动创建的示例规则文件名。目录本身由 Contents API 随文件创建。
 * 该文件标记为「示例」，供维护者参考与被 GitHub 识别目录结构；是否实际纳入
 * 读取由维护者自行决定 —— 示例文件是普通的 .md，若保留会像其它规则文件一样
 * 被读取注入（内容本身就是无害的说明文字）。
 */
export const EXAMPLE_RULES_FILE = ".apertureprism/rules/README.md";

const EXAMPLE_RULES_CONTENT = `# AperturePrism 仓库审核规则

本目录（\`.apertureprism/rules/\`）由 AperturePrism 审核机器人读取：目录下的
\`.md\` 文件内容会在分析 Issue / PR 时注入作为该仓库的专属审核规则。

这是一个**示例文件**，由机器人首次分析本仓库时自动创建，供你参考格式。
你可以：
- 编辑本文件，写入你仓库真正想遵循的审核规则；
- 新增其它 \`.md\` 规则文件（按文件名排序合并读取）；
- 或直接删除本目录/文件，机器人将不再注入规则。

示例规则：
- 禁止提交明文密钥 / 硬编码密码
- 所有密码必须使用 argon2 或 bcrypt 等强哈希存储
`;

/**
 * 第一次分析某仓库时，若 `.apertureprism/rules/` 目录还不存在，则自动创建一个
 * 示例规则文件，让维护者知道有此功能（并可据此补充真实规则）。
 *
 * best-effort：目录已存在 / 写入失败 / 无写权限都不算错误，静默返回是否真的
 * 创建了。调用方不应依赖返回值做决策，仅用于可观测日志。
 */
export async function ensureRepoRulesDir(
  github: GitHubClient,
  options: RepoRulesOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const repo = await github.getRepository(
      { installationId: options.installationId, owner: options.owner, name: options.name },
      signal,
    );
    const ref = repo?.defaultBranch ?? "main";
    const entries = await github.listDirectory(
      { installationId: options.installationId, owner: options.owner, name: options.name, path: REPO_RULES_DIR, ref },
      signal,
    );
    // 目录已存在（可能为空或有文件）→ 不创建。
    if (entries.length > 0) return false;
    return await github.writeFileContents(
      {
        installationId: options.installationId,
        owner: options.owner,
        name: options.name,
        path: EXAMPLE_RULES_FILE,
        ref,
        content: EXAMPLE_RULES_CONTENT,
      },
      signal,
    );
  } catch {
    return false;
  }
}

/**
 * 读取仓库 `.apertureprism/rules/` 目录下的 Markdown 规则文件，合并为一段
 * 参考文本（按文件名排序）。目录不存在、无 `.md` 文件或读取失败一律返回
 * undefined —— 规则是增强项，任何失败都不能打断分析流程。
 */
export async function fetchRepoRules(
  github: GitHubClient,
  options: RepoRulesOptions,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    // 默认分支：规则文件以默认分支（通常是 main/master）为准，与 PR 的 head
    // 无关，保证规则在 Issue 与 PR 分析时指向同一份内容。
    const repo = await github.getRepository(
      {
        installationId: options.installationId,
        owner: options.owner,
        name: options.name,
      },
      signal,
    );
    const ref = repo?.defaultBranch ?? "main";
    const entries = await github.listDirectory(
      {
        installationId: options.installationId,
        owner: options.owner,
        name: options.name,
        path: REPO_RULES_DIR,
        ref,
      },
      signal,
    );

    const files = entries
      .filter(
        (entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md"),
      )
      .slice(0, MAX_RULE_FILES)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (files.length === 0) return undefined;

    const blocks: string[] = [];
    for (const file of files) {
      const contents = await github.getFileContents(
        {
          installationId: options.installationId,
          owner: options.owner,
          name: options.name,
          path: file.path,
          ref,
        },
        signal,
      );
      if (!contents) continue;
      const body =
        contents.content.length > MAX_RULE_FILE_CHARS
          ? `${contents.content.slice(0, MAX_RULE_FILE_CHARS)}\n…[规则文件过长，已截断]`
          : contents.content;
      if (body.trim().length === 0) continue;
      blocks.push(`### ${file.name}\n${body}`);
    }

    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  } catch {
    // best-effort：读取失败视为没有规则，绝不阻断分析。
    return undefined;
  }
}
