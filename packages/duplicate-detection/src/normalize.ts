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
 * Removes template boilerplate sections and collapses the result. Keeps the
 * meaningful first quarter of the body as the highest-signal text.
 */
export function normalizeBody(body: string): string {
  let text = body || "";
  for (const pattern of defaultBoilerplatePatterns) {
    text = text.replace(pattern, " ");
  }
  return collapseWhitespace(stripUrls(text));
}

export function normalizeTitle(title: string): string {
  return collapseWhitespace(stripUrls(title || ""));
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
