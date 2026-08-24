/**
 * 编辑 Issue 后是否值得重新分析。
 *
 * `issues.edited` 会为每一次编辑创建新任务（正文的 `updated_at` 是任务修订号），
 * 所以改一个错别字也会重跑完整分析：既花掉一次模型调用，又会用新结论覆盖既有
 * 评论。这里按「归一化正文的变化幅度」判定，低于阈值就跳过。
 *
 * 只有 webhook 的 `issues.edited` 受此限制。opened / reopened / 手动触发 /
 * 评论指令 / 仓库扫描一律照常分析 —— 那些路径要么本来就没有旧结论，要么是用户
 * 明确要求，跳过它们才是错的。
 */

/**
 * 归一化文本的字符级变化比例（0 = 完全相同，1 = 面目全非）。
 *
 * 剥掉公共前缀与公共后缀后，剩下的就是真正改动的那一段；用它对总长度取比例。
 * 不用编辑距离：正文可达上万字符，O(n²) 的代价不值得——这里只需要判断「小修
 * 还是重写」，不需要精确的编辑脚本。段落搬家会被算成大改动，那个方向是安全的
 * （宁可多分析一次，也不要漏掉真实修改）。
 */
export function normalizedChangeRatio(before: string, after: string): number {
  if (before === after) return 0;
  const longest = Math.max(before.length, after.length);
  if (longest === 0) return 0;

  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before[start] === after[start]) start += 1;
  // 后缀不能吃回已经被前缀吃掉的部分，否则短串会被重复计数。
  let end = 0;
  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  const changed = Math.max(
    before.length - start - end,
    after.length - start - end,
  );
  return Math.min(1, changed / longest);
}

/** 低于这个变化比例视为小修，不重新分析。10% 是估计值，可按仓库覆盖。 */
export const DEFAULT_MIN_CHANGE_RATIO = 0.1;

/** 上一版正文快照：`issue_documents` 里由索引任务写入的归一化文本。 */
export type IssueTextSnapshot = {
  text: string;
  /**
   * 快照最后一次写入的时间，用来确认它确实早于本次编辑。取 `updated_at` 而非
   * `indexed_at`：upsert 只刷新前者，`indexed_at` 停留在首次入库时间。
   */
  updatedAt: Date;
};

export type ReanalysisDecision =
  | {
      reanalyze: true;
      reason: "not_gated" | "no_usable_snapshot" | "substantial_change";
      changeRatio: number | null;
    }
  | {
      reanalyze: false;
      reason: "unchanged" | "minor_change";
      changeRatio: number;
    };

export type ReanalysisInput = {
  /** 是否受变化幅度限制；只有 webhook 的 `issues.edited` 传 true。 */
  gated: boolean;
  snapshot: IssueTextSnapshot | null;
  /** 本次任务对应的 Issue `updated_at`；解析失败传 null。 */
  revisionAt: Date | null;
  /** 当前正文的归一化文本，必须与快照同一套归一化规则。 */
  currentText: string;
  minChangeRatio: number;
};

export function decideReanalysis(input: ReanalysisInput): ReanalysisDecision {
  if (!input.gated)
    return { reanalyze: true, reason: "not_gated", changeRatio: null };

  // 快照由索引任务按 10 分钟一轮写入，可能已经包含本次编辑的内容。只有
  // 写入时间严格早于本次修订号时，它才确实是「上一版」；否则无从比较，按分析
  // 处理。这一条同时让新建 Issue 走对：刚开的 Issue 若已被索引，快照必然晚于
  // 它的 updated_at，于是不会被误判成「没变化」。
  if (
    !input.snapshot ||
    !input.revisionAt ||
    input.snapshot.updatedAt.getTime() >= input.revisionAt.getTime()
  ) {
    return { reanalyze: true, reason: "no_usable_snapshot", changeRatio: null };
  }

  const ratio = normalizedChangeRatio(input.snapshot.text, input.currentText);
  if (ratio === 0) return { reanalyze: false, reason: "unchanged", changeRatio: 0 };

  const threshold = Math.min(1, Math.max(0, input.minChangeRatio));
  if (ratio < threshold)
    return { reanalyze: false, reason: "minor_change", changeRatio: ratio };
  return { reanalyze: true, reason: "substantial_change", changeRatio: ratio };
}

/** 解析 `issue_reanalyze_min_change` 设置值；非法值回落到默认阈值。 */
export function parseMinChangeRatio(value: string | undefined | null): number {
  if (value === undefined || value === null) return DEFAULT_MIN_CHANGE_RATIO;
  const text = value.trim();
  if (text.length === 0) return DEFAULT_MIN_CHANGE_RATIO;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
    return DEFAULT_MIN_CHANGE_RATIO;
  return parsed;
}
