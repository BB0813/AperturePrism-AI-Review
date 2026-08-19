import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelInvocationRequest,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import {
  ModelRoutingFailedError,
  backoffDelayMs,
  orderCandidates,
  routeModelInvocation,
  type RetryPolicy,
} from "./index.js";

const request: ModelInvocationRequest = {
  messages: [{ role: "user", content: "analyze" }],
};

const retryPolicy: RetryPolicy = {
  maxAttemptsPerCandidate: 2,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

/** Asserts the routing call failed and narrows the error for inspection. */
async function expectRoutingFailure(
  promise: Promise<unknown>,
): Promise<ModelRoutingFailedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelRoutingFailedError);
    return error as ModelRoutingFailedError;
  }
  throw new Error("expected model routing to fail");
}

const primary: ModelCandidate = {
  provider: "provider-a",
  model: "model-a",
  accountName: "account-a",
};
const fallback: ModelCandidate = {
  provider: "provider-b",
  model: "model-b",
  accountName: "account-b",
};

function usage() {
  return { inputTokens: 10, outputTokens: 5 };
}

/** Records every invocation so tests can assert retry and fallback behavior. */
function adapter(
  provider: string,
  handler: (attempt: number, signal: AbortSignal) => Promise<string>,
): { adapter: ModelProviderAdapter; calls: () => number } {
  let calls = 0;
  return {
    adapter: {
      provider,
      invoke: async (_candidate, _request, signal) => {
        calls += 1;
        return { content: await handler(calls, signal), usage: usage() };
      },
    },
    calls: () => calls,
  };
}

function adapters(...entries: ModelProviderAdapter[]) {
  return new Map(entries.map((entry) => [entry.provider, entry]));
}

/** Deterministic clock so deadline assertions never depend on real time. */
function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("model routing order and backoff", () => {
  it("tries the sticky candidate first but keeps other fallbacks", () => {
    expect(orderCandidates([primary, fallback], fallback)).toEqual([
      fallback,
      primary,
    ]);
    expect(orderCandidates([primary, fallback], undefined)).toEqual([
      primary,
      fallback,
    ]);
  });

  it("ignores a sticky candidate that is no longer allowed", () => {
    const removed: ModelCandidate = {
      provider: "provider-c",
      model: "model-c",
      accountName: "account-c",
    };
    expect(orderCandidates([primary, fallback], removed)).toEqual([
      primary,
      fallback,
    ]);
  });

  it("grows backoff exponentially up to the cap", () => {
    expect(backoffDelayMs(1, retryPolicy)).toBe(100);
    expect(backoffDelayMs(2, retryPolicy)).toBe(200);
    expect(backoffDelayMs(9, retryPolicy)).toBe(1_000);
  });
});

describe("model routing retries and fallback", () => {
  it("retries a rate limited candidate and honors Retry-After", async () => {
    const waits: number[] = [];
    const first = adapter("provider-a", async (attempt) => {
      if (attempt === 1)
        throw new ModelInvocationError("rate_limited", "429", 250);
      return "recovered";
    });

    const result = await routeModelInvocation(adapters(first.adapter), {
      candidates: [primary],
      request,
      deadlineMs: 10_000,
      retryPolicy,
      now: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(result.response.content).toBe("recovered");
    expect(waits).toEqual([250]);
    expect(result.attempts.map((a) => a.errorCategory)).toEqual([
      "rate_limited",
      null,
    ]);
  });

  it("falls over to the next provider after server errors", async () => {
    const failing = adapter("provider-a", async () => {
      throw new ModelInvocationError("server_error", "503");
    });
    const healthy = adapter("provider-b", async () => "from-b");

    const result = await routeModelInvocation(
      adapters(failing.adapter, healthy.adapter),
      {
        candidates: [primary, fallback],
        request,
        deadlineMs: 10_000,
        retryPolicy,
        now: () => 0,
        sleep: async () => undefined,
      },
    );

    expect(result.candidate).toEqual(fallback);
    expect(result.response.content).toBe("from-b");
    expect(failing.calls()).toBe(retryPolicy.maxAttemptsPerCandidate);
    expect(healthy.calls()).toBe(1);
  });

  it("does not retry the same candidate after authentication failure", async () => {
    const unauthorized = adapter("provider-a", async () => {
      throw new ModelInvocationError("authentication_failed", "401");
    });
    const healthy = adapter("provider-b", async () => "from-b");

    const result = await routeModelInvocation(
      adapters(unauthorized.adapter, healthy.adapter),
      {
        candidates: [primary, fallback],
        request,
        deadlineMs: 10_000,
        retryPolicy,
        now: () => 0,
        sleep: async () => undefined,
      },
    );

    expect(unauthorized.calls()).toBe(1);
    expect(result.candidate).toEqual(fallback);
  });

  it("retries the same candidate on authentication failure when opted in", async () => {
    const flaky = adapter("provider-a", async (attempt) => {
      if (attempt === 1)
        throw new ModelInvocationError("authentication_failed", "401");
      return "recovered";
    });

    const result = await routeModelInvocation(adapters(flaky.adapter), {
      candidates: [primary],
      request,
      deadlineMs: 10_000,
      retryPolicy: { ...retryPolicy, retryAuthentication: true },
      now: () => 0,
      sleep: async () => undefined,
    });

    expect(result.response.content).toBe("recovered");
    expect(flaky.calls()).toBe(2);
  });

  it("does not retry model_not_found or context_overflow on the same candidate", async () => {
    for (const category of ["model_not_found", "context_overflow"] as const) {
      const failing = adapter("provider-a", async () => {
        throw new ModelInvocationError(category, category);
      });
      await expect(
        routeModelInvocation(adapters(failing.adapter), {
          candidates: [primary],
          request,
          deadlineMs: 10_000,
          retryPolicy,
          now: () => 0,
          sleep: async () => undefined,
        }),
      ).rejects.toBeInstanceOf(ModelRoutingFailedError);
      expect(failing.calls()).toBe(1);
    }
  });

  it("treats an unregistered provider as an unusable candidate", async () => {
    const healthy = adapter("provider-b", async () => "from-b");
    const result = await routeModelInvocation(adapters(healthy.adapter), {
      candidates: [primary, fallback],
      request,
      deadlineMs: 10_000,
      retryPolicy,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(result.candidate).toEqual(fallback);
    expect(result.attempts[0]?.errorCategory).toBe("model_not_found");
  });

  it("classifies connection failures and unknown provider faults", async () => {
    const failing = adapter("provider-a", async (attempt) => {
      if (attempt === 1)
        throw new ModelInvocationError("connection_failed", "ECONNRESET");
      throw new Error("socket exploded");
    });

    const error = await expectRoutingFailure(
      routeModelInvocation(adapters(failing.adapter), {
        candidates: [primary],
        request,
        deadlineMs: 10_000,
        retryPolicy,
        now: () => 0,
        sleep: async () => undefined,
      }),
    );

    expect(error.attempts.map((a) => a.errorCategory)).toEqual([
      "connection_failed",
      "unknown",
    ]);
    expect(error.lastCategory).toBe("unknown");
  });

  it("surfaces invalid structured output as a retryable category", async () => {
    const failing = adapter("provider-a", async (attempt) => {
      if (attempt === 1)
        throw new ModelInvocationError("invalid_output", "not json");
      return "{}";
    });

    const result = await routeModelInvocation(adapters(failing.adapter), {
      candidates: [primary],
      request,
      deadlineMs: 10_000,
      retryPolicy,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(result.attempts[0]?.errorCategory).toBe("invalid_output");
    expect(result.response.content).toBe("{}");
  });
});

describe("model routing deadline and cancellation", () => {
  it("stops once the shared deadline is exhausted instead of per candidate", async () => {
    const time = clock();
    const slow = adapter("provider-a", async () => {
      time.advance(600);
      throw new ModelInvocationError("server_error", "503");
    });
    const second = adapter("provider-b", async () => "unreachable");

    const error = await expectRoutingFailure(
      routeModelInvocation(adapters(slow.adapter, second.adapter), {
        candidates: [primary, fallback],
        request,
        deadlineMs: 1_000,
        retryPolicy,
        now: time.now,
        sleep: async (ms) => {
          time.advance(ms);
        },
      }),
    );

    expect(error.lastCategory).toBe("timeout");
    expect(second.calls()).toBe(0);
  });

  it("reports a timeout when a candidate exceeds the remaining budget", async () => {
    const hanging = adapter(
      "provider-a",
      (_attempt, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    );

    const error = await expectRoutingFailure(
      routeModelInvocation(adapters(hanging.adapter), {
        candidates: [primary],
        request,
        deadlineMs: 30,
        retryPolicy: { ...retryPolicy, maxAttemptsPerCandidate: 1 },
        sleep: async () => undefined,
      }),
    );

    expect(error.lastCategory).toBe("timeout");
  });

  it("propagates caller cancellation without trying more candidates", async () => {
    const controller = new AbortController();
    const canceled = adapter("provider-a", async (_attempt, signal) => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) {
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        throw abortError;
      }
      return "unexpected";
    });
    const second = adapter("provider-b", async () => "unreachable");

    const error = await expectRoutingFailure(
      routeModelInvocation(adapters(canceled.adapter, second.adapter), {
        candidates: [primary, fallback],
        request,
        deadlineMs: 10_000,
        retryPolicy,
        signal: controller.signal,
        sleep: async () => undefined,
      }),
    );

    expect(error.lastCategory).toBe("canceled");
    expect(second.calls()).toBe(0);
  });

  it("refuses to start when the caller already canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    const never = adapter("provider-a", async () => "unreachable");

    const error = await expectRoutingFailure(
      routeModelInvocation(adapters(never.adapter), {
        candidates: [primary],
        request,
        deadlineMs: 10_000,
        retryPolicy,
        signal: controller.signal,
      }),
    );

    expect(error.lastCategory).toBe("canceled");
    expect(never.calls()).toBe(0);
  });
});
