import { createHash } from "node:crypto";

/**
 * GitHub App 凭据的纯逻辑：指纹与「按需重建客户端」的状态机。
 *
 * 单独一个文件、不 import drizzle：缓存与轮换是真正容易出错的地方，放在这里就能
 * 在任何环境下单测，不必先能连上数据库。数据库读取在 `github-app.ts`。
 */

export type GithubAppCredentials = {
  appId: string;
  privateKeyPem: string;
  /** 凭据来源，用于把「界面里保存的」与「环境变量里的」区分开来展示。 */
  source: "database" | "env";
};

/**
 * 解析结果刻意区分「没有凭据」与「有凭据但解不开」。
 */
export type GithubAppResolution =
  | { outcome: "ok"; credentials: GithubAppCredentials }
  | { outcome: "not_configured" }
  /**
   * 库里存了凭据但解不开（主密钥换过、记录被改过、或没提供主密钥）。
   * 绝不因此回落到环境变量：那会让用户以为界面里保存的凭据在生效，实际却在用
   * 另一个身份访问仓库。
   */
  | { outcome: "decrypt_failed"; reason: "master_key_missing" | "open_failed" };

/**
 * 凭据指纹，用来判断「换过 App 了吗」而不必每轮都重新解密建客户端。
 *
 * 只取 sha256 前 16 个十六进制字符：够区分不同私钥，又不会把密钥材料本身留在
 * 长期变量或日志里。
 */
export function githubAppFingerprint(
  credentials: GithubAppCredentials,
): string {
  return createHash("sha256")
    .update(`${credentials.appId}:${credentials.privateKeyPem}`)
    .digest("hex")
    .slice(0, 16);
}

type Logger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type GithubAppProviderOptions<TClient> = {
  /**
   * 解析一次凭据。注入而非直接收 db，好让本模块保持无数据库依赖、可单测。
   */
  resolve: () => Promise<GithubAppResolution>;
  logger: Logger;
  /**
   * 用解析出的凭据构造真正的 GitHub 客户端。由调用方注入，本模块因此不依赖
   * github-adapter —— database 已被 github-adapter 依赖，反向引用会成环。
   */
  createClient: (credentials: GithubAppCredentials) => TClient;
};

/**
 * 按需重建的 GitHub App 客户端，供 api 与三个 worker 共用。
 *
 * 此前每个 worker 启动时读一次环境变量就把客户端定死：用户在 WebUI 保存了
 * GitHub App、界面显示「已验证通过」，worker 却依旧认为没配，任务照旧失败。
 * 现在凭据从数据库解析（env 兜底），换了 App 也不需要重启容器。
 *
 * 用指纹判断是否真的换了凭据：变了才重建，避免每次都解密私钥、丢掉客户端内部的
 * installation token 缓存。
 */
export function createGithubAppProvider<TClient>(
  options: GithubAppProviderOptions<TClient>,
): { get: () => Promise<TClient | null> } {
  const { resolve, logger, createClient } = options;
  let client: TClient | null = null;
  let fingerprint: string | null = null;
  /** 只在状态变化时记日志，否则每轮 pass 都会刷同一条。 */
  let lastProblem: string | null = null;

  const note = (problem: string, log: () => void): void => {
    if (lastProblem === problem) return;
    lastProblem = problem;
    log();
  };

  return {
    async get(): Promise<TClient | null> {
      let resolution: GithubAppResolution;
      try {
        resolution = await resolve();
      } catch (error) {
        // 数据库抖动时保留现有客户端：一次读失败不该让正在跑的 worker 失去
        // GitHub 访问能力。
        note("lookup_failed", () =>
          logger.warn({ err: error }, "GitHub App credential lookup failed"),
        );
        return client;
      }

      if (resolution.outcome === "not_configured") {
        note("not_configured", () =>
          logger.warn({}, "GitHub App is not configured"),
        );
        client = null;
        fingerprint = null;
        return null;
      }

      if (resolution.outcome === "decrypt_failed") {
        const reason = resolution.reason;
        note(`decrypt_failed:${reason}`, () =>
          logger.error(
            { reason },
            "stored GitHub App private key could not be used",
          ),
        );
        client = null;
        fingerprint = null;
        return null;
      }

      const next = githubAppFingerprint(resolution.credentials);
      if (client && next === fingerprint) return client;

      client = createClient(resolution.credentials);
      const rotated = fingerprint !== null;
      fingerprint = next;
      lastProblem = null;
      logger.info(
        { source: resolution.credentials.source, rotated },
        rotated
          ? "GitHub App credentials changed; client rebuilt"
          : "GitHub App client ready",
      );
      return client;
    },
  };
}
