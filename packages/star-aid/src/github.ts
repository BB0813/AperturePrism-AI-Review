export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const USER_AGENT = "apertureprism-star-aid";

export type StarAidErrorCategory =
  | "invalid_token"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "network"
  | "invalid_request";

/** A GitHub API failure mapped to a stable category for star-aid callers. */
export class StarAidGithubError extends Error {
  readonly category: StarAidErrorCategory;
  readonly status: number | null;

  constructor(category: StarAidErrorCategory, message: string, status: number | null) {
    super(message);
    this.name = "StarAidGithubError";
    this.category = category;
    this.status = status;
  }
}

function baseUrl(apiBaseUrl: string | undefined): string {
  return (apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/$/, "");
}

function categorize(status: number): StarAidGithubError {
  if (status === 401)
    return new StarAidGithubError(
      "invalid_token",
      `GitHub responded with ${status}`,
      status,
    );
  if (status === 429)
    return new StarAidGithubError(
      "rate_limited",
      `GitHub responded with ${status}`,
      status,
    );
  if (status === 404)
    return new StarAidGithubError("not_found", "GitHub object not found", status);
  if (status >= 500)
    return new StarAidGithubError(
      "server_error",
      `GitHub responded with ${status}`,
      status,
    );
  return new StarAidGithubError(
    "invalid_request",
    `GitHub responded with ${status}`,
    status,
  );
}

async function githubFetch(
  apiBaseUrl: string | undefined,
  path: string,
  init: {
    method: "GET" | "PUT";
    token: string | null;
  },
): Promise<Response> {
  try {
    return await fetch(`${baseUrl(apiBaseUrl)}${path}`, {
      method: init.method,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        ...(init.token === null
          ? {}
          : { authorization: `Bearer ${init.token}` }),
        ...(init.method === "PUT" ? { "content-length": "0" } : {}),
      },
    });
  } catch (error) {
    throw new StarAidGithubError(
      "network",
      error instanceof Error ? error.message : "GitHub request failed",
      null,
    );
  }
}

/**
 * Validates a PAT against the GitHub API and returns the account identity it
 * belongs to. A 401 is categorized as `invalid_token` so registration can
 * reject a bad token before it is stored.
 */
export async function verifyGitHubToken(
  apiBaseUrl: string | undefined,
  token: string,
): Promise<{ login: string; name?: string | undefined }> {
  const response = await githubFetch(apiBaseUrl, "/user", {
    method: "GET",
    token,
  });
  if (!response.ok) throw categorize(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new StarAidGithubError(
      "invalid_request",
      "GitHub response was not JSON",
      response.status,
    );
  }
  const record = body as Record<string, unknown>;
  const login = typeof record.login === "string" ? record.login : "";
  if (login.length === 0)
    throw new StarAidGithubError(
      "invalid_request",
      "GitHub /user returned no login",
      null,
    );
  const name =
    typeof record.name === "string" && record.name.length > 0
      ? record.name
      : undefined;
  return name === undefined ? { login } : { login, name };
}

/**
 * Stars a repository with the account PAT (PUT /user/starred/{owner}/{repo}).
 * The full name is validated as `owner/repo` before hitting the API.
 */
export async function starGitHubRepo(
  apiBaseUrl: string | undefined,
  token: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  const fullName = `${owner}/${repo}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new StarAidGithubError(
      "invalid_request",
      `invalid repository full name: ${fullName}`,
      null,
    );
  }
  const response = await githubFetch(
    apiBaseUrl,
    `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { method: "PUT", token },
  );
  if (response.status === 204) return true;
  if (!response.ok) throw categorize(response.status);
  return true;
}

/**
 * Reads a repository's `description` for storage on a star-aid target.
 * Best-effort: any failure (auth, 404, network) degrades to "".
 */
export async function fetchRepoDescription(
  apiBaseUrl: string | undefined,
  token: string | null,
  owner: string,
  repo: string,
): Promise<string> {
  try {
    const response = await githubFetch(
      apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: "GET", token },
    );
    if (!response.ok) return "";
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body.description === "string" ? body.description : "";
  } catch {
    return "";
  }
}
