import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelErrorCategory,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";

export type OpenAICompatibleOptions = {
  provider: string;
  baseUrl: string;
  /** Resolves the decrypted API key for an account, kept out of this module. */
  resolveApiKey: (accountName: string) => Promise<string>;
  fetchImpl?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: { message?: { content?: unknown } }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
};

/**
 * Maps transport and protocol failures onto the shared categories. Retry and
 * fallback decisions belong to the router, never to this adapter.
 */
function categorizeStatus(status: number): ModelErrorCategory {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unknown";
}

function retryAfterMs(headers: Headers): number | undefined {
  const header = headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Context-overflow arrives as a 400 that only the body distinguishes, so the
 * message is inspected without ever echoing prompt content back to callers.
 */
function categorizeBadRequest(body: string): ModelErrorCategory {
  const normalized = body.toLowerCase();
  if (
    normalized.includes("context length") ||
    normalized.includes("context_length") ||
    normalized.includes("maximum context") ||
    normalized.includes("too many tokens")
  ) {
    return "context_overflow";
  }
  if (normalized.includes("model") && normalized.includes("not found"))
    return "model_not_found";
  return "unknown";
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleOptions,
): ModelProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider: options.provider,
    invoke: async (
      candidate: ModelCandidate,
      request: ModelInvocationRequest,
      signal: AbortSignal,
    ): Promise<ModelInvocationResponse> => {
      const apiKey = await options.resolveApiKey(candidate.accountName);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: candidate.model,
            messages: request.messages,
            ...(request.maxOutputTokens === undefined
              ? {}
              : { max_tokens: request.maxOutputTokens }),
            ...(request.temperature === undefined
              ? {}
              : { temperature: request.temperature }),
            ...(request.responseFormat === "json"
              ? { response_format: { type: "json_object" } }
              : {}),
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted)
          throw new ModelInvocationError("canceled", "invocation was canceled");
        throw new ModelInvocationError(
          "connection_failed",
          error instanceof Error ? error.message : "transport failure",
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const category =
          response.status === 400
            ? categorizeBadRequest(body)
            : categorizeStatus(response.status);
        const delay = retryAfterMs(response.headers);
        throw new ModelInvocationError(
          category,
          `provider responded with ${response.status}`,
          ...(delay === undefined ? [] : [delay]),
        );
      }

      let parsed: ChatCompletionResponse;
      try {
        parsed = (await response.json()) as ChatCompletionResponse;
      } catch {
        throw new ModelInvocationError(
          "invalid_output",
          "provider response was not valid JSON",
        );
      }

      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0)
        throw new ModelInvocationError(
          "invalid_output",
          "provider response did not contain message content",
        );

      return {
        content,
        usage: {
          inputTokens: integerOrZero(parsed.usage?.prompt_tokens),
          outputTokens: integerOrZero(parsed.usage?.completion_tokens),
        },
      };
    },
  };
}
