import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRepoDescription,
  StarAidGithubError,
  starGitHubRepo,
  verifyGitHubToken,
} from "./github.js";

type Call = { url: string; init: RequestInit };

/** Stubs the global fetch and records every call for URL/header assertions. */
function stubFetch(
  responder: (call: Call) => Response | Promise<Response>,
): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return responder(call);
    }),
  );
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("star-aid GitHub helpers", () => {
  it("verifies a token against GET {base}/user with a Bearer header", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ login: "alice", name: "Alice" }),
    );
    const identity = await verifyGitHubToken(
      "https://api.github.test",
      "ghp-token",
    );
    expect(identity).toEqual({ login: "alice", name: "Alice" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.test/user");
    expect(calls[0]?.init.method).toBe("GET");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ghp-token");
    expect(headers["user-agent"]).toBeTruthy();
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const { calls } = stubFetch(() => jsonResponse({ login: "alice" }));
    await verifyGitHubToken("https://api.github.test/", "t");
    expect(calls[0]?.url).toBe("https://api.github.test/user");
  });

  it("maps a 401 to the invalid_token category", async () => {
    stubFetch(() => new Response("bad credentials", { status: 401 }));
    try {
      await verifyGitHubToken(undefined, "bad-token");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StarAidGithubError);
      expect((error as StarAidGithubError).category).toBe("invalid_token");
      expect((error as StarAidGithubError).status).toBe(401);
    }
  });

  it("uses the default api.github.com when no base URL is given", async () => {
    const { calls } = stubFetch(() => jsonResponse({ login: "alice" }));
    await verifyGitHubToken(undefined, "t");
    expect(calls[0]?.url).toBe("https://api.github.com/user");
  });

  it("stars a repo with PUT /user/starred/{owner}/{repo}", async () => {
    const { calls } = stubFetch(() => new Response(null, { status: 204 }));
    const starred = await starGitHubRepo(
      "https://api.github.test",
      "t",
      "o",
      "r",
    );
    expect(starred).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://api.github.test/user/starred/o/r",
    );
    expect(calls[0]?.init.method).toBe("PUT");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t");
    expect(headers["content-length"]).toBe("0");
  });

  it("rejects an invalid full name before any fetch", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    try {
      await starGitHubRepo(undefined, "t", "o r", "x");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as StarAidGithubError).category).toBe("invalid_request");
    }
    expect(calls).toHaveLength(0);
  });

  it("maps a 404 star to the not_found category", async () => {
    stubFetch(() => new Response("missing", { status: 404 }));
    try {
      await starGitHubRepo(undefined, "t", "o", "nope");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as StarAidGithubError).category).toBe("not_found");
    }
  });

  it("fetches a repo description via GET /repos/{owner}/{repo}", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ description: "A great repo" }),
    );
    const description = await fetchRepoDescription(
      "https://api.github.test",
      null,
      "o",
      "r",
    );
    expect(description).toBe("A great repo");
    expect(calls[0]?.url).toBe("https://api.github.test/repos/o/r");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("degrades to an empty description on failure", async () => {
    stubFetch(() => new Response("missing", { status: 404 }));
    expect(await fetchRepoDescription(undefined, "t", "o", "nope")).toBe("");
  });

  it("reports network failures as the network category", async () => {
    stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    try {
      await verifyGitHubToken(undefined, "t");
      throw new Error("expected the request to fail");
    } catch (error) {
      expect((error as StarAidGithubError).category).toBe("network");
    }
  });
});
