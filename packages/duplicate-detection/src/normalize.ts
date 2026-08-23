/**
 * Normalizes issue title/body into a canonical form for indexing, embedding,
 * and candidate recall. Template boilerplate and low-signal boilerplate are
 * stripped so duplicated imports or templated bug reports do not dominate
 * similarity.
 */

const defaultBoilerplatePatterns: readonly RegExp[] = [
  /\bwhen\s+submitting\s+(an|a)\s+(issue|bug)\b[\s\S]*?(?=\n\n|$)/giu,
  /\b(please|kindly)\s+(provide|include)\b[^\n]*/giu,
  /\bexport(ed)?\s*:\s*\S+/giu,
  /\bos\s*version\s*:?\s*[^\n]*/giu,
  /\bbrowser\s*:?\s*[^\n]*/giu,
];

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Lowercase, trim, and collapse whitespace for comparison. */
export function normalizeTokenString(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

/** Remove URLs to reduce cross-repo/issue boilerplate noise. */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+|\b[\w.-]+\.\w{2,}(?:\/\S*)?\b/gu, " ");
}

/**
 * Drops Markdown image and link syntax, keeping any human-written link text.
 * Screenshot-only issues are common, and without this the leftover `![ ](`
 * fragments become the only indexed "content" for them.
 */
export function stripMarkdownMedia(text: string): string {
  return (
    text
      // Images carry no searchable text; alt text is usually a generated filename.
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
      // Links: keep the label, drop the target.
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
      // Bare HTML tags appear when users paste directly from a browser.
      .replace(/<(?:img|video)\b[^>]*>/giu, " ")
      // Scaffolding left behind once URLs have already been stripped.
      .replace(/!\[[^\]]*\]?|\]\(/gu, " ")
  );
}

/**
 * Extracts overlapping CJK character n-grams.
 *
 * PostgreSQL's `simple` FTS config treats an entire CJK run as a single token,
 * so two differently-worded Chinese titles never match by full text, and an
 * `ilike '%whole title%'` fallback requires one title to literally contain the
 * other. Verified on the live database: `一直连接失败` vs `连接bug 仪表盘一直显示连接中断`
 * matched by neither. N-grams give the recall layer something to intersect on.
 */
export function cjkNgrams(text: string, size = 2): string[] {
  const runs = text.match(/[㐀-鿿぀-ヿ]{2,}/gu) ?? [];
  const grams = new Set<string>();
  for (const run of runs) {
    if (run.length <= size) {
      grams.add(run);
      continue;
    }
    for (let i = 0; i + size <= run.length; i += 1) {
      grams.add(run.slice(i, i + size));
    }
  }
  return [...grams];
}

/**
 * Removes template boilerplate sections and collapses the result. Keeps the
 * meaningful first quarter of the body as the highest-signal text.
 */
export function normalizeBody(body: string): string {
  let text = body || "";
  for (const pattern of defaultBoilerplatePatterns) {
    text = text.replace(pattern, " ");
  }
  // Media syntax first: stripUrls would otherwise leave `![ ](` scaffolding.
  return collapseWhitespace(stripUrls(stripMarkdownMedia(text)));
}

export function normalizeTitle(title: string): string {
  return collapseWhitespace(stripUrls(stripMarkdownMedia(title || "")));
}

export function normalizeVersion(text: string): string {
  return (
    (text.match(/\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?/u) ?? [])[0] ?? ""
  );
}

/**
 * Canonical text used for embedding and full-text recall: normalized title
 * plus the normalized body. Down-weighting is not applied here; the caller
 * chooses how much body to include.
 */
export function normalizedIndexText(input: {
  title: string;
  body: string;
}): string {
  const title = normalizeTitle(input.title);
  const body = normalizeBody(input.body);
  const titlePart = title.length > 0 ? title : "";
  const bodyPart = body.length > 0 ? body : "";
  return [titlePart, bodyPart].filter(Boolean).join(" ");
}
