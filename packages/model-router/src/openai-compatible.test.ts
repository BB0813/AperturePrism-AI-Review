import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelInvocationRequest,
} from "../../../packages/domain/src/index.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";

const candidate: ModelCandidate = {
  provider: "openai-compatible",
  model: "test-model",
  accountName: "account-a",
};

const request: ModelInvocationRequest = {
  messages: [{ role: "user", content: "analyze" }],
  responseFormat: "json",
};

type FetchCall = { url: string; init: RequestInit };

function adapterWith(
  responder: (call: FetchCall) => Promise<Response> | Response,
) {
  const calls: FetchCall[] = [];
  const adapter = createOpenAICompatibleAdapter({
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1/",
    resolveApiKey: async () => "secret-api-key",
    fetchImpl: (async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  });
  return { adapter, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function completion(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  };
}

async function categoryOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelInvocationError);
    return (error as ModelInvocationError).category;
  }
  throw new Error("expected the invocation to fail");
}

describe("OpenAI-compatible adapter requests", () => {
  it("posts to the chat completions endpoint with the resolved key", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("{}")),
    );
    const result = await adapter.invoke(
      candidate,
      request,
      new AbortController().signal,
    );

    expect(calls[0]?.url).toBe("https://models.example/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-api-key");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("test-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(result).toEqual({
      content: "{}",
      usage: { inputTokens: 12, outputTokens: 7 },
    });
  });

  it("omits optional tuning fields when the caller does not set them", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonResponse(completion("ok")),
    );
    await adapter.invoke(
      candidate,
      { messages: request.messages },
      new AbortController().signal,
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
  });
});

describe("OpenAI-compatible adapter error mapping", () => {
  it("maps HTTP statuses to standard categories", async () => {
    const cases: [number, string][] = [
      [401, "authentication_failed"],
      [403, "authentication_failed"],
      [404, "model_not_found"],
      [408, "timeout"],
      [429, "rate_limited"],
      [500, "server_error"],
      [503, "server_error"],
      [418, "unknown"],
    ];

    for (const [status, expected] of cases) {
      const { adapter } = adapterWith(
        () => new Response("failure", { status }),
      );
      expect(
        await categoryOf(
          adapter.invoke(candidate, request, new AbortController().signal),
        ),
      ).toBe(expected);
    }
  });

  it("extracts Retry-After as milliseconds", async () => {
    const { adapter } = adapterWith(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "3" },
        }),
    );
    try {
      await adapter.invoke(candidate, request, new AbortController().signal);
      throw new Error("expected a rate limit failure");
    } catch (error) {
      expect((error as ModelInvocationError).retryAfterMs).toBe(3_000);
    }
  });

  it("distinguishes context overflow from other bad requests", async () => {
    const overflow = adapterWith(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "This model's maximum context length is 8192" },
          }),
          { status: 400 },
        ),
    );
    const other = adapterWith(
      () =>
        new Response(JSON.stringify({ error: "bad field" }), { status: 400 }),
    );

    expect(
      await categoryOf(
        overflow.adapter.invoke(
          candidate,
          request,
          new AbortController().signal,
        ),
      ),
    ).toBe("context_overflow");
    expect(
      await categoryOf(
        other.adapter.invoke(candidate, request, new AbortController().signal),
      ),
    ).toBe("unknown");
  });

  it("reports transport failures and cancellation distinctly", async () => {
    const broken = adapterWith(() => {
      throw new Error("ECONNRESET");
    });
    expect(
      await categoryOf(
        broken.adapter.invoke(candidate, request, new AbortController().signal),
      ),
    ).toBe("connection_failed");

    const controller = new AbortController();
    const canceled = adapterWith(() => {
      controller.abort();
      throw new Error("aborted");
    });
    expect(
      await categoryOf(
        canceled.adapter.invoke(candidate, request, controller.signal),
      ),
    ).toBe("canceled");
  });

  it("rejects malformed and empty completions as invalid output", async () => {
    const notJson = adapterWith(() => new Response("<html>", { status: 200 }));
    const noContent = adapterWith(() => jsonResponse({ choices: [] }));
    const emptyContent = adapterWith(() => jsonResponse(completion("")));

    for (const { adapter } of [notJson, noContent, emptyContent]) {
      expect(
        await categoryOf(
          adapter.invoke(candidate, request, new AbortController().signal),
        ),
      ).toBe("invalid_output");
    }
  });

  it("defaults missing usage counters to zero", async () => {
    const { adapter } = adapterWith(() =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const result = await adapter.invoke(
      candidate,
      request,
      new AbortController().signal,
    );
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
