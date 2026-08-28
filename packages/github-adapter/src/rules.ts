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
