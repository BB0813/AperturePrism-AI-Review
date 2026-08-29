import type {
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelMessage,
  ModelToolCall,
  ModelToolSpec,
} from "../../../packages/domain/src/index.js";
import type { GitHubClient } from "../../../packages/github-adapter/src/client.js";

/**
 * AI 主动探索工具系统：审查模型可按需调用工具读取仓库上下文，
 * 而不是只依赖一次性注入的 diff。工具执行严格受限于目标仓库（只读）。
 */

/** 工具执行上下文：GitHub 只读访问 + 目标仓库定位。 */
export type ToolExecutionContext = {
  client: GitHubClient;
  installationId: string;
  owner: string;
  name: string;
  /** 读取文件所用的 ref（PR head sha）。 */
  ref: string;
  /** 单文件最大返回字节数（超出截断）。 */
  maxFileBytes?: number;
};

export type ToolResult = { ok: boolean; content: string };

/** 内置工具定义（暴露给模型的 JSON Schema）。 */
export function builtinTools(): ModelToolSpec[] {
  return [
    {
      name: "read_file",
      description:
        "读取仓库中某个文件的 UTF-8 内容（基于当前 PR 的 head 分支）。path 是仓库内相对路径，如 src/main.ts。大文件只返回开头部分。仅用于读取，禁止修改。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "仓库内相对文件路径" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_directory",
      description:
        "列出仓库中某个目录下的条目（文件名与子目录名）。path 为仓库内相对路径，传空字符串表示仓库根目录。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录相对路径（空=仓库根目录）" },
        },
      },
    },
    {
      name: "get_git_info",
      description:
        "获取当前 PR 的元信息：标题、head 分支与 sha、base 分支。用于了解变更范围与目标分支。",
      parameters: { type: "object", properties: {} },
    },
  ];
}

function safePath(raw: string): string {
  return String(raw || "").replace(/^\/+/, "").replace(/\.\.(\/|$)/g, "");
}

/** 执行单个工具调用，返回给模型的结果文本。 */
export async function executeToolCall(
  name: string,
  rawArgs: string,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, content: "工具参数不是合法 JSON" };
  }

  try {
    switch (name) {
      case "read_file": {
        const path = safePath(typeof args.path === "string" ? args.path : "");
        if (!path) return { ok: false, content: "read_file: 缺少 path 参数" };
        const file = await ctx.client.getFileContents({
          installationId: ctx.installationId,
          owner: ctx.owner,
          name: ctx.name,
          path,
          ref: ctx.ref,
        });
        if (!file)
          return { ok: false, content: `read_file: 文件不存在或不是文件：${path}` };
        const maxBytes = ctx.maxFileBytes ?? 200_000;
        const content =
          file.content.length > maxBytes
            ? `${file.content.slice(0, maxBytes)}\n…[已截断，文件较大]`
            : file.content;
        return { ok: true, content };
      }

      case "list_directory": {
        const path = safePath(typeof args.path === "string" ? args.path : "");
        const entries = await ctx.client.listDirectory({
          installationId: ctx.installationId,
          owner: ctx.owner,
          name: ctx.name,
          path,
          ref: ctx.ref,
        });
        if (entries.length === 0) return { ok: true, content: "(空目录或路径不存在)" };
        return {
          ok: true,
          content: entries
            .map((e) => `${e.type === "dir" ? "dir " : "file"}  ${e.path}`)
            .join("\n"),
        };
      }

      case "get_git_info":
        return {
          ok: true,
          content: `仓库: ${ctx.owner}/${ctx.name}\n读取 ref: ${ctx.ref}`,
        };

      default:
        return { ok: false, content: `未知工具: ${name}` };
    }
  } catch (error) {
    return {
      ok: false,
      content: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type ToolLoopOptions = {
  /** 暴露给模型的工具（默认内置工具）。 */
  tools?: readonly ModelToolSpec[];
  /** 最大工具调用轮数（超出后强制模型收尾）。 */
  maxRounds?: number;
  /** 注入给模型的"开始探索"引导消息。 */
  exploreInstruction?: string;
};

/**
 * 多轮 tool-calling 循环：不断把模型的 tool_calls 交给执行器并把结果回传，
 * 直到模型直接给出最终内容或达到最大轮数。返回最终消息序列与轮数。
 */
export async function runToolLoop(
  invoke: (request: ModelInvocationRequest) => Promise<ModelInvocationResponse>,
  messages: readonly ModelMessage[],
  ctx: ToolExecutionContext,
  options: ToolLoopOptions = {},
): Promise<{ messages: ModelMessage[]; rounds: number }> {
  const tools = options.tools ?? builtinTools();
  const maxRounds = options.maxRounds ?? 6;
  let rounds = 0;
  let current: ModelMessage[] = [...messages];

  if (options.exploreInstruction) {
    current = [...current, { role: "user", content: options.exploreInstruction }];
  }

  // 空响应重试：模型（如 kimi-k3）在工具循环中偶发返回「既无 content 也无
  // tool_calls」的空消息，openai-compatible 适配器据此抛 invalid_output
  // （"did not contain message content"）。这是瞬态抖动而非真实失败——重试当前
  // 轮即可，若直接上抛会让整个 deep 分析无谓地致命失败。
  const invokeWithEmptyRetry: typeof invoke = async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await invoke(request);
      } catch (error) {
        const emptyResponse =
          error instanceof Error &&
          /did not contain message content/.test(error.message);
        if (!emptyResponse || attempt >= 2) throw error;
      }
    }
  };

  for (;;) {
    const response = await invokeWithEmptyRetry({ messages: current, tools });
    rounds += 1;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      current = [...current, { role: "assistant", content: response.content }];
      return { messages: current, rounds };
    }

    const assistantMsg: ModelMessage = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls as readonly ModelToolCall[],
    };
    const toolResults: ModelMessage[] = [];
    for (const call of response.toolCalls) {
      const result = await executeToolCall(call.name, call.arguments, ctx);
      toolResults.push({
        role: "tool",
        content: result.content,
        toolCallId: call.id,
      });
    }
    current = [...current, assistantMsg, ...toolResults];

    if (rounds >= maxRounds) {
      const final = await invokeWithEmptyRetry({
        messages: [
          ...current,
          {
            role: "user",
            content:
              "工具调用轮次已达上限。请停止继续调用工具，基于已获取的信息直接输出最终审查结果。",
          },
        ],
      });
      return {
        messages: [...current, { role: "assistant", content: final.content }],
        rounds: rounds + 1,
      };
    }
  }
}
