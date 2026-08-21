import { describe, expect, it } from "vitest";
import type {
  ModelInvocationRequest,
  ModelInvocationResponse,
} from "../../../packages/domain/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import {
  builtinTools,
  executeToolCall,
  runToolLoop,
  type ToolExecutionContext,
} from "./tools.js";

function clientWith(overrides: Partial<GitHubClient>): GitHubClient {
  return {
    getFileContents: async () => ({ content: "const x = 1;\n" }),
    listDirectory: async () => [
      { name: "src", path: "src", type: "dir" },
      { name: "README.md", path: "README.md", type: "file" },
    ],
    ...overrides,
  } as GitHubClient;
}

const ctx: ToolExecutionContext = {
  client: clientWith({}),
  installationId: "42",
  owner: "owner",
  name: "repo",
  ref: "abc123",
};

describe("builtinTools", () => {
  it("exposes read_file / list_directory / get_git_info", () => {
    const names = builtinTools().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("list_directory");
    expect(names).toContain("get_git_info");
  });
});

describe("executeToolCall", () => {
  it("reads a file via the contents API", async () => {
    const result = await executeToolCall(
      "read_file",
      '{"path":"src/a.ts"}',
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe("const x = 1;\n");
  });

  it("reports a missing file", async () => {
    const missingCtx = {
      ...ctx,
      client: clientWith({ getFileContents: async () => null }),
    };
    const result = await executeToolCall(
      "read_file",
      '{"path":"nope.ts"}',
      missingCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("文件不存在");
  });

  it("truncates oversized files", async () => {
    const big = "a".repeat(5000);
    const bigCtx = {
      ...ctx,
      client: clientWith({ getFileContents: async () => ({ content: big }) }),
    };
    const result = await executeToolCall(
      "read_file",
      '{"path":"big.ts"}',
      { ...bigCtx, maxFileBytes: 100 },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已截断");
    expect(result.content.length).toBeLessThan(big.length);
  });

  it("sanitizes traversal paths", async () => {
    let requested = "";
    const traversalCtx = {
      ...ctx,
      client: clientWith({
        getFileContents: async ({ path }) => {
          requested = path;
          return { content: "ok" };
        },
      }),
    };
    await executeToolCall(
      "read_file",
      '{"path":"../etc/passwd"}',
      traversalCtx,
    );
    expect(requested).not.toContain("..");
  });

  it("lists a directory", async () => {
    const result = await executeToolCall(
      "list_directory",
      '{"path":"src"}',
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("dir   src");
    expect(result.content).toContain("file  README.md");
  });

  it("returns git info", async () => {
    const result = await executeToolCall("get_git_info", "{}", ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("owner/repo");
  });

  it("rejects unknown tools and bad JSON", async () => {
    const unknown = await executeToolCall("rm_rf", "{}", ctx);
    expect(unknown.ok).toBe(false);
    const bad = await executeToolCall("read_file", "not json", ctx);
    expect(bad.ok).toBe(false);
  });
});

describe("runToolLoop", () => {
  const finalResponse = (content: string): ModelInvocationResponse => ({
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const toolCallResponse = (): ModelInvocationResponse => ({
    content: "",
    usage: { inputTokens: 1, outputTokens: 1 },
    toolCalls: [
      { id: "c1", name: "read_file", arguments: '{"path":"src/a.ts"}' },
    ],
  });

  it("executes tool calls and returns the final assistant content", async () => {
    let calls = 0;
    const invoke = async (
      request: ModelInvocationRequest,
    ): Promise<ModelInvocationResponse> => {
      calls += 1;
      if (calls === 1) {
        expect(request.tools).toBeDefined();
        return toolCallResponse();
      }
      return finalResponse('{"summary":"ok"}');
    };

    const result = await runToolLoop(invoke, [
      { role: "user", content: "review" },
    ], ctx);

    expect(calls).toBe(2);
    const last = result.messages[result.messages.length - 1];
    expect(last?.content).toBe('{"summary":"ok"}');
    // assistant tool-call + tool result were appended between the rounds.
    expect(
      result.messages.some((m) => m.role === "tool" && m.toolCallId === "c1"),
    ).toBe(true);
  });

  it("stops immediately when the model returns content without tools", async () => {
    const invoke = async () => finalResponse("done");
    const result = await runToolLoop(invoke, [
      { role: "user", content: "hi" },
    ], ctx);
    expect(result.rounds).toBe(1);
    expect(result.messages[result.messages.length - 1]?.content).toBe("done");
  });

  it("forces a final answer after reaching maxRounds", async () => {
    let calls = 0;
    const invoke = async (): Promise<ModelInvocationResponse> => {
      calls += 1;
      // Always request tools except the very last forced turn.
      if (calls <= 2) return toolCallResponse();
      return finalResponse("final");
    };
    const result = await runToolLoop(
      invoke,
      [{ role: "user", content: "hi" }],
      ctx,
      { maxRounds: 2 },
    );
    expect(result.messages[result.messages.length - 1]?.content).toBe("final");
  });
});
