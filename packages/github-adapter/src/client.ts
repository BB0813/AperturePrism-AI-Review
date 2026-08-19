import { createSign } from "node:crypto";

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  htmlUrl: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  labels: readonly string[];
};

export type GitHubIssueComment = {
  id: number;
  body: string;
  htmlUrl: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubCreatedComment = {
  id: number;
  htmlUrl: string;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  headSha: string;
  headRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
};

export type GitHubErrorCategory =
  | "rate_limited"
  | "authentication_failed"
  | "not_found"
  | "server_error"
  | "invalid_request"
  | "network"
  | "canceled";

/**
 * A GitHub API failure mapped onto stable categories so callers can decide
 * whether a retry could ever help instead of swallowing provider specifics.
 */
export class GitHubApiError extends Error {
  readonly category: GitHubErrorCategory;
  readonly status: number | null;
  readonly retryAfterMs: number | undefined;

  constructor(
    category: GitHubErrorCategory,
    message: string,
    status: number | null,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.category = category;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type GitHubClientOptions = {
  appId: string;
  /** PEM-encoded GitHub App private key, used only to mint JWTs. */
  privateKeyPem: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type InstallationToken = {
  token: string;
  expiresAt: string;
};

export type GitHubClient = {
  getInstallationToken: (
    installationId: string,
    signal?: AbortSignal,
  ) => Promise<InstallationToken>;
  getIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubIssue>;
  /** Lists repository issues (PRs excluded), newest first, paged. */
  listIssues: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      state?: "open" | "closed" | "all";
      perPage?: number;
      page?: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubIssue[]>;
  getPullRequest: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubPullRequest>;
  /** Returns the raw unified diff text of a pull request. */
  getPullRequestDiff: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<string>;
  listIssueComments: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubIssueComment[]>;
  createIssueComment: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      body: string;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubCreatedComment>;
  /**
   * Adds labels to an issue. Idempotent: GitHub ignores labels that already
   * exist. Used by the worker to apply configured label rules after analysis.
   */
  addIssueLabels: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      labels: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  updateIssueComment: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      commentId: number;
      body: string;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubCreatedComment>;
  /** Submits an immutable PR review tied to a commit (head) SHA. */
  createPullRequestReview: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      pullNumber: number;
      commitId: string;
      body: string;
      event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number }>;
};

function signAppJwt(
  appId: string,
  privateKeyPem: string,
  nowMs: number,
): string {
  const nowSec = Math.floor(nowMs / 1_000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(privateKeyPem, "base64url");
  return `${header}.${claims}.${signature}`;
}

function retryAfterMs(headers: Headers): number | undefined {
  const header = headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function categorizeStatus(
  status: number,
  retryAfter: number | undefined,
): GitHubApiError {
  if (status === 429)
    return new GitHubApiError(
      "rate_limited",
      `GitHub responded with ${status}`,
      status,
      retryAfter,
    );
  if (status === 401 || status === 403)
    return new GitHubApiError(
      "authentication_failed",
      `GitHub responded with ${status}`,
      status,
    );
  if (status === 404)
    return new GitHubApiError("not_found", "GitHub object not found", status);
  if (status >= 500)
    return new GitHubApiError(
      "server_error",
      `GitHub responded with ${status}`,
      status,
    );
  return new GitHubApiError(
    "invalid_request",
    `GitHub responded with ${status}`,
    status,
  );
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/$/,
    "",
  );
  const now = options.now ?? (() => Date.now());

  const request = async <T>(
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH";
      token: string;
      body?: unknown | undefined;
      signal?: AbortSignal | undefined;
      /** Override the Accept header, e.g. for a diff (text/plain). */
      accept?: string | undefined;
      rawText?: boolean | undefined;
    },
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          accept: init.accept ?? "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${init.token}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
    } catch (error) {
      if (init.signal?.aborted)
        throw new GitHubApiError("canceled", "request was canceled", null);
      throw new GitHubApiError(
        "network",
        error instanceof Error ? error.message : "GitHub request failed",
        null,
      );
    }

    if (!response.ok) {
      throw categorizeStatus(response.status, retryAfterMs(response.headers));
    }
    if (init.rawText) return (await response.text()) as T;
    if (response.status === 204) return null as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubApiError(
        "invalid_request",
        "GitHub response was not JSON",
        response.status,
      );
    }
  };

  /**
   * The installation access_tokens endpoint intermittently returns 401 even
   * with a valid App JWT (observed repeatedly on the live test repo). Re-sign
   * a fresh JWT and retry once before giving up, so a transient rejection
   * never fails the whole operation.
   */
  const getInstallationToken = async (
    installationId: string,
    signal?: AbortSignal,
    attempt = 0,
  ): Promise<string> => {
    try {
      const response = await request<{ token: string }>(
        `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        {
          method: "POST",
          token: signAppJwt(options.appId, options.privateKeyPem, now()),
          body: {},
          signal,
        },
      );
      return response.token;
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof GitHubApiError &&
        error.category === "authentication_failed"
      ) {
        return getInstallationToken(installationId, signal, 1);
      }
      throw error;
    }
  };

  /**
   * Mints an installation token and issues a request, retrying once on a 401:
   * GitHub intermittently rejects a freshly-minted installation token on the
   * API call itself (observed repeatedly). A fresh token + one retry covers it.
   */
  const authorized = async <T>(
    installationId: string,
    init: {
      method: "GET" | "POST" | "PATCH";
      path: string;
      body?: unknown;
      accept?: string;
      rawText?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getInstallationToken(installationId, signal);
      try {
        return await request<T>(init.path, {
          method: init.method,
          token,
          body: init.body,
          accept: init.accept,
          rawText: init.rawText,
          signal,
        });
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof GitHubApiError &&
          error.category === "authentication_failed"
        )
          continue;
        throw error;
      }
    }
    throw new GitHubApiError(
      "authentication_failed",
      "authorized request failed after retry",
      401,
    );
  };

  return {
    getInstallationToken: async (installationId, signal) => ({
      token: await getInstallationToken(installationId, signal),
      expiresAt: new Date(now() + 60_000).toISOString(),
    }),

    getIssue: async ({ installationId, owner, name, number }, signal) => {
      const issue = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
        },
        signal,
      );
      return mapIssue(issue);
    },

    listIssues: async (
      { installationId, owner, name, state = "all", perPage = 100, page = 1 },
      signal,
    ) => {
      const query = new URLSearchParams({
        state,
        per_page: String(perPage),
        page: String(page),
      }).toString();
      const items = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?${query}`,
        },
        signal,
      );
      // The issues endpoint also returns pull requests; skip them.
      return items.filter((item) => !item.pull_request).map(mapIssue);
    },

    getPullRequest: async ({ installationId, owner, name, number }, signal) => {
      const pullRequest = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
        },
        signal,
      );
      return mapPullRequest(pullRequest);
    },

    getPullRequestDiff: async (
      { installationId, owner, name, number },
      signal,
    ) =>
      authorized<string>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
          accept: "application/vnd.github.diff",
          rawText: true,
        },
        signal,
      ),

    listIssueComments: async (
      { installationId, owner, name, number },
      signal,
    ) => {
      const comments = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
        },
        signal,
      );
      return comments.map(mapComment);
    },

    createIssueComment: async (
      { installationId, owner, name, number, body },
      signal,
    ) => {
      const comment = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
          body: { body },
        },
        signal,
      );
      return mapComment(comment);
    },

    addIssueLabels: async (
      { installationId, owner, name, number, labels },
      signal,
    ) => {
      const unique = [...new Set(labels)].filter((label) => label.trim().length > 0);
      if (unique.length === 0) return;
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/labels`,
          body: { labels: unique },
        },
        signal,
      );
    },

    updateIssueComment: async (
      { installationId, owner, name, commentId, body },
      signal,
    ) => {
      const comment = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${commentId}`,
          body: { body },
        },
        signal,
      );
      return mapComment(comment);
    },

    createPullRequestReview: async (
      { installationId, owner, name, pullNumber, commitId, body, event },
      signal,
    ) => {
      const review = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullNumber}/reviews`,
          body: { commit_id: commitId, body, event },
        },
        signal,
      );
      return { id: numberValue(review.id) };
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function mapPullRequest(value: Record<string, unknown>): GitHubPullRequest {
  const head = objectOr(value.head);
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: value.state === "closed" ? "closed" : "open",
    headSha: stringValue(head.sha),
    headRef: stringValue(head.ref),
    changedFiles: numberValue(value.changed_files),
    additions: numberValue(value.additions),
    deletions: numberValue(value.deletions),
  };
}

function objectOr(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function mapIssue(value: Record<string, unknown>): GitHubIssue {
  const labels = Array.isArray(value.labels)
    ? value.labels
        .map((label) =>
          typeof label === "object" && label !== null
            ? stringValue((label as Record<string, unknown>).name)
            : stringValue(label),
        )
        .filter((label) => label.length > 0)
    : [];
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    body: stringValue(value.body),
    state: value.state === "closed" ? "closed" : "open",
    htmlUrl: stringValue(value.html_url),
    author: stringOrNull(
      typeof value.user === "object" && value.user !== null
        ? (value.user as Record<string, unknown>).login
        : null,
    ),
    createdAt: stringValue(value.created_at),
    updatedAt: stringValue(value.updated_at),
    labels,
  };
}

function mapComment(value: Record<string, unknown>): GitHubIssueComment {
  return {
    id: numberValue(value.id),
    body: stringValue(value.body),
    htmlUrl: stringValue(value.html_url),
    author: stringOrNull(
      typeof value.user === "object" && value.user !== null
        ? (value.user as Record<string, unknown>).login
        : null,
    ),
    createdAt: stringValue(value.created_at),
    updatedAt: stringValue(value.updated_at),
  };
}
