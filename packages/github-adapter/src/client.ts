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

export type GitHubCreatedIssue = {
  number: number;
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

/** A repository installed to the GitHub App, from `GET /installation/repositories`. */
export type InstalledRepository = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
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
  /** Lists pull requests (PRs only, unlike `/issues`), newest first, paged. */
  listPullRequests: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      state?: "open" | "closed" | "all";
      perPage?: number;
      page?: number;
    },
    signal?: AbortSignal,
  ) => Promise<GitHubPullRequest[]>;
  /** Creates a new issue in the repository and returns its number + URL. */
  createIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      title: string;
      body: string;
      labels?: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<GitHubCreatedIssue>;
  /**
   * Patches an existing issue (rewrite title and/or assign users). Idempotent:
   * GitHub ignores unchanged fields and re-assigning the same assignee is a no-op.
   */
  updateIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      title?: string;
      assignees?: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<{ number: number; htmlUrl: string }>;
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
  /** Reads a single file's UTF-8 content at a ref via the contents API. */
  getFileContents: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      path: string;
      ref: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ content: string; truncated?: boolean } | null>;
  /** Lists directory entries at a ref via the contents API. */
  listDirectory: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      path: string;
      ref: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ name: string; path: string; type: string }[]>;
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
   * Closes an issue. When `body` is given, a closing comment is posted first
   * (best-effort, failures do not block the close) and then the issue state
   * is patched to "closed".
   */
  closeIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      body?: string;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Deletes an issue. GitHub requires the token to have write/admin access to
   * the repository; otherwise it responds 403, which surfaces as a
   * `authentication_failed` GitHubApiError so callers can degrade to close.
   */
  deleteIssue: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
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
      /** Optional inline review comments (diff position by new-file line). */
      comments?: readonly { path: string; line: number; body: string }[];
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number }>;
  /** Lists the reviews already submitted on a pull request. */
  listPullRequestReviews: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      pullNumber: number;
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number; state: string }[]>;
  /** Dismisses a submitted PR review (one-click revoke support). */
  dismissPullRequestReview: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      pullNumber: number;
      reviewId: number;
      message: string;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Creates a GitHub Check Run tied to a head SHA so the analysis state is
   * visible in the PR checks UI. Requires `checks: write` on the App.
   */
  createCheckRun: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      headSha: string;
      runName: string;
      status: "queued" | "in_progress" | "completed";
      conclusion?:
        | "success"
        | "failure"
        | "neutral"
        | "cancelled"
        | "timed_out"
        | "action_required";
      title?: string;
      summary?: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number; htmlUrl: string }>;
  /** Updates an existing check run (e.g. in_progress -> completed). */
  updateCheckRun: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      checkRunId: number;
      status: "queued" | "in_progress" | "completed";
      conclusion?:
        | "success"
        | "failure"
        | "neutral"
        | "cancelled"
        | "timed_out"
        | "action_required";
      title?: string;
      summary?: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ id: number; htmlUrl: string }>;
  /** Removes the given labels from an issue (idempotent). */
  removeIssueLabels: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      number: number;
      labels: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Deletes an issue comment by id. */
  deleteIssueComment: (
    input: {
      installationId: string;
      owner: string;
      name: string;
      commentId: number;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Lists every repository installed to the app for a given installation. */
  listInstallationRepositories: (
    installationId: string,
    signal?: AbortSignal,
  ) => Promise<InstalledRepository[]>;
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
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
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
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
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

    listPullRequests: async (
      { installationId, owner, name, state = "open", perPage = 100, page = 1 },
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
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?${query}`,
        },
        signal,
      );
      return items.map(mapPullRequest);
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

    getFileContents: async (
      { installationId, owner, name, path, ref },
      signal,
    ) => {
      const safePath = String(path || "").replace(/^\/+/, "");
      if (!safePath) return null;
      const encoded = safePath.split("/").map(encodeURIComponent).join("/");
      let data: Record<string, unknown>;
      try {
        data = await authorized<Record<string, unknown>>(
          installationId,
          {
            method: "GET",
            path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
          },
          signal,
        );
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return null;
        throw error;
      }
      // A directory path returns an array instead of a file object.
      if (Array.isArray(data)) return null;
      if (typeof data.type === "string" && data.type !== "file") return null;
      const base64 = typeof data.content === "string" ? data.content : "";
      if (!base64) return null;
      return {
        content: Buffer.from(base64, "base64").toString("utf8"),
        truncated: data.truncated === true,
      };
    },

    listDirectory: async ({ installationId, owner, name, path, ref }, signal) => {
      const safePath = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
      const encoded = safePath.split("/").map(encodeURIComponent).join("/");
      let data: unknown;
      try {
        data = await authorized<unknown>(
          installationId,
          {
            method: "GET",
            path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
          },
          signal,
        );
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return [];
        throw error;
      }
      if (!Array.isArray(data)) return [];
      return (data as Record<string, unknown>[]).map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        path: typeof entry.path === "string" ? entry.path : "",
        type: typeof entry.type === "string" ? entry.type : "file",
      }));
    },

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

    createIssue: async (
      { installationId, owner, name, title, body, labels },
      signal,
    ) => {
      const issue = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
          body: {
            title,
            body,
            ...(labels && labels.length > 0 ? { labels: [...labels] } : {}),
          },
        },
        signal,
      );
      return { number: numberValue(issue.number), htmlUrl: stringValue(issue.html_url) };
    },

    updateIssue: async (
      { installationId, owner, name, number, title, assignees },
      signal,
    ) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined && title.trim().length > 0) body.title = title.trim();
      if (assignees !== undefined && assignees.length > 0)
        body.assignees = [...assignees];
      if (Object.keys(body).length === 0)
        return { number, htmlUrl: `https://github.com/${owner}/${name}/issues/${number}` };
      const issue = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body,
        },
        signal,
      );
      return { number: numberValue(issue.number), htmlUrl: stringValue(issue.html_url) };
    },

    closeIssue: async (
      { installationId, owner, name, number, body },
      signal,
    ) => {
      if (body && body.trim().length > 0) {
        try {
          await authorized<Record<string, unknown>>(
            installationId,
            {
              method: "POST",
              path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
              body: { body },
            },
            signal,
          );
        } catch (error) {
          // The closing comment is best-effort; never block the close on it.
          void error;
        }
      }
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: { state: "closed" },
        },
        signal,
      );
    },

    deleteIssue: async ({ installationId, owner, name, number }, signal) => {
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "DELETE",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
        },
        signal,
      );
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
      { installationId, owner, name, pullNumber, commitId, body, event, comments },
      signal,
    ) => {
      const review = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullNumber}/reviews`,
          body: {
            commit_id: commitId,
            body,
            event,
            ...(comments && comments.length > 0 ? { comments: [...comments] } : {}),
          },
        },
        signal,
      );
      return { id: numberValue(review.id) };
    },

    listPullRequestReviews: async (
      { installationId, owner, name, pullNumber },
      signal,
    ) => {
      const data = await authorized<Record<string, unknown>[]>(
        installationId,
        {
          method: "GET",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullNumber}/reviews`,
        },
        signal,
      );
      return data.map((review) => ({
        id: numberValue(review.id),
        state: stringValue(review.state),
      }));
    },

    dismissPullRequestReview: async (
      { installationId, owner, name, pullNumber, reviewId, message },
      signal,
    ) => {
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PUT",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullNumber}/reviews/${reviewId}/dismissals`,
          body: { message },
        },
        signal,
      );
    },

    createCheckRun: async (
      { installationId, owner, name, headSha, runName, status, conclusion, title, summary },
      signal,
    ) => {
      const output = title || summary ? { title: title ?? runName, summary: summary ?? "" } : undefined;
      const run = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs`,
          body: {
            head_sha: headSha,
            name: runName,
            status,
            ...(conclusion === undefined ? {} : { conclusion }),
            ...(output === undefined ? {} : { output }),
          },
        },
        signal,
      );
      return {
        id: numberValue(run.id),
        htmlUrl: stringValue(run.html_url),
      };
    },

    updateCheckRun: async (
      { installationId, owner, name, checkRunId, status, conclusion, title, summary },
      signal,
    ) => {
      const output = title || summary ? { title: title ?? `Check ${checkRunId}`, summary: summary ?? "" } : undefined;
      const run = await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs/${checkRunId}`,
          body: {
            status,
            ...(conclusion === undefined ? {} : { conclusion }),
            ...(output === undefined ? {} : { output }),
          },
        },
        signal,
      );
      return {
        id: numberValue(run.id),
        htmlUrl: stringValue(run.html_url),
      };
    },

    removeIssueLabels: async (
      { installationId, owner, name, number, labels },
      signal,
    ) => {
      for (const label of labels) {
        if (!label || label.trim().length === 0) continue;
        try {
          await authorized<Record<string, unknown>>(
            installationId,
            {
              method: "DELETE",
              path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/labels/${encodeURIComponent(label.trim())}`,
            },
            signal,
          );
        } catch {
          // Removing a label that is not present returns 404; treat as done.
        }
      }
    },

    deleteIssueComment: async (
      { installationId, owner, name, commentId },
      signal,
    ) => {
      await authorized<Record<string, unknown>>(
        installationId,
        {
          method: "DELETE",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${commentId}`,
        },
        signal,
      );
    },

    listInstallationRepositories: async (installationId, signal) => {
      const data = await authorized<Record<string, unknown>>(
        installationId,
        { method: "GET", path: "/installation/repositories" },
        signal,
      );
      const list = Array.isArray(data.repositories)
        ? (data.repositories as Record<string, unknown>[])
        : [];
      return list.map((repo) => {
        const owner = objectOr(repo.owner);
        return {
          id: numberValue(repo.id),
          owner: stringValue(owner.login),
          name: stringValue(repo.name),
          fullName: stringValue(repo.full_name),
        };
      });
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
