import { readFile } from "node:fs/promises";
import { inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { GithubAppResolution } from "./github-app-provider.js";

type Database = PostgresJsDatabase<typeof schema>;

export {
  createGithubAppProvider,
  githubAppFingerprint,
  type GithubAppCredentials,
  type GithubAppProviderOptions,
  type GithubAppResolution,
} from "./github-app-provider.js";

/** 解开 `github_app_private_key` 用的最小接口，避免本模块依赖 config 包。 */
export type PrivateKeyOpener = { open: (sealed: string) => string };

export type GithubAppEnvFallback = {
  appId: string | undefined;
  /** 私钥文件路径；DB 里存的是密文本身，env 里存的是路径。 */
  privateKeyPath: string | undefined;
};

/**
 * GitHub App 凭据：优先用 WebUI 保存到 `system_settings` 的那一份（私钥
 * AES-GCM 加密），其次回落到环境变量 + 私钥文件。
 *
 * 之所以要共享：此前只有 api 进程会读数据库，analysis / index / scan 三个
 * worker 仍只看环境变量。于是用户在界面上配好、界面显示「已验证通过」，
 * 三个 worker 却依旧认为没配 GitHub App，任务照旧失败 —— UI 报告了并不存在的
 * 成功。凭据解析必须只有一处实现。
 *
 * 不在这里打日志：6 个进程各有自己的 logger，返回结构化结果由调用方决定记什么
 * 级别；也不吞掉解密失败，见 `decrypt_failed`。
 */
export async function resolveGithubAppCredentials(
  db: Database,
  input: { opener: PrivateKeyOpener | null; env: GithubAppEnvFallback },
): Promise<GithubAppResolution> {
  const rows = await db
    .select({
      key: schema.systemSettings.key,
      value: schema.systemSettings.value,
    })
    .from(schema.systemSettings)
    .where(
      inArray(schema.systemSettings.key, [
        "github_app_id",
        "github_app_private_key",
      ]),
    );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const storedAppId = (stored.get("github_app_id") ?? "").trim();
  const sealedKey = stored.get("github_app_private_key") ?? "";

  if (storedAppId && sealedKey) {
    if (!input.opener)
      return { outcome: "decrypt_failed", reason: "master_key_missing" };
    try {
      return {
        outcome: "ok",
        credentials: {
          appId: storedAppId,
          privateKeyPem: input.opener.open(sealedKey),
          source: "database",
        },
      };
    } catch {
      return { outcome: "decrypt_failed", reason: "open_failed" };
    }
  }

  if (input.env.appId && input.env.privateKeyPath) {
    return {
      outcome: "ok",
      credentials: {
        appId: input.env.appId,
        privateKeyPem: await readFile(input.env.privateKeyPath, "utf8"),
        source: "env",
      },
    };
  }
  return { outcome: "not_configured" };
}
