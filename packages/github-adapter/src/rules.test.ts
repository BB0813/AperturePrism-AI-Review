import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "./client.js";
import { fetchRepoRules, REPO_RULES_DIR } from "./rules.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

type Call = { url: string; init: RequestInit };

function clientWith(responder: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const client = createGitHubClient({
    appId: "12345",
    privateKeyPem: privateKey,
    apiBaseUrl: "https://api.github.test",
    now: () => 1_700_000_000_000,
    fetchImpl: (async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  });
  return { client, calls };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Routes the mandatory installation-token exchange then hands off. */
function withToken(next: (call: Call) => Response) {
  return (call: Call): Response => {
    if (call.url.endsWith("/app/installations/42/access_tokens"))
      return jsonResponse({
        token: "installation-token",
        expires_at: "2026-08-18T00:00:00Z",
      });
    return next(call);
  };
}

describe("fetchRepoRules", () => {
  it("merges markdown files from .apertureprism/rules in name order", async () => {
    const { client } = clientWith(
      withToken((call) => {
        if (call.url.endsWith("/repos/o/r")) {
          return jsonResponse({ default_branch: "main" });
        }
        // 目录与文件读取都会请求 /contents/<path>?ref=...；必须区分两种：
        // 目录 URL 的 path 恰等于 REPO_RULES_DIR，而文件 URL 的 path 更长。
        const contentPath = call.url.match(/contents\/([^?]+)/)?.[1] ?? "";
        if (decodeURIComponent(contentPath) === REPO_RULES_DIR) {
          return jsonResponse([
            { name: "hard-rules.md", path: `${REPO_RULES_DIR}/hard-rules.md`, type: "file" },
            { name: "b.md", path: `${REPO_RULES_DIR}/b.md`, type: "file" },
            { name: "README.txt", path: `${REPO_RULES_DIR}/README.txt`, type: "file" },
            { name: "sub", path: `${REPO_RULES_DIR}/sub`, type: "dir" },
          ]);
        }
        const name = decodeURIComponent(contentPath.split("/").pop() ?? "");
        if (name === "b.md")
          return jsonResponse({ content: Buffer.from("规则 B").toString("base64"), encoding: "base64" });
        return jsonResponse({ content: Buffer.from("规则 A").toString("base64"), encoding: "base64" });
      }),
    );

    const text = await fetchRepoRules(client, {
      installationId: "42",
      owner: "o",
      name: "r",
    });

    expect(text).toBe("### b.md\n规则 B\n\n### hard-rules.md\n规则 A");
  });

  it("returns undefined when the rules folder does not exist", async () => {
    const { client } = clientWith(
      withToken((call) => {
        if (call.url.endsWith("/repos/o/r"))
          return jsonResponse({ default_branch: "main" });
        return jsonResponse({ message: "Not Found" }, 404);
      }),
    );

    const text = await fetchRepoRules(client, {
      installationId: "42",
      owner: "o",
      name: "r",
    });

    expect(text).toBeUndefined();
  });

  it("uses the repository default branch", async () => {
    const { client, calls } = clientWith(
      withToken((call) => {
        if (call.url.endsWith("/repos/o/r"))
          return jsonResponse({ default_branch: "develop" });
        // 目录 URL 的 path 恰等于 REPO_RULES_DIR，文件 URL 的 path 更长。
        const contentPath = call.url.match(/contents\/([^?]+)/)?.[1] ?? "";
        if (decodeURIComponent(contentPath) === REPO_RULES_DIR) {
          return jsonResponse([
            { name: "a.md", path: `${REPO_RULES_DIR}/a.md`, type: "file" },
          ]);
        }
        return jsonResponse({ content: Buffer.from("R").toString("base64"), encoding: "base64" });
      }),
    );

    await fetchRepoRules(client, { installationId: "42", owner: "o", name: "r" });

    const directoryCall = calls.find((c) =>
      c.url.includes(`/contents/${REPO_RULES_DIR}`),
    );
    expect(directoryCall?.url).toContain("ref=develop");
  });
});
