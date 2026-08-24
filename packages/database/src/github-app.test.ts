import { describe, expect, it, vi } from "vitest";
import {
  createGithubAppProvider,
  githubAppFingerprint,
  type GithubAppResolution,
} from "./github-app-provider.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function ok(appId: string, key: string): GithubAppResolution {
  return {
    outcome: "ok",
    credentials: { appId, privateKeyPem: key, source: "database" },
  };
}

describe("githubAppFingerprint", () => {
  it("changes when either the app id or the private key changes", () => {
    const base = githubAppFingerprint({
      appId: "1",
      privateKeyPem: "a",
      source: "database",
    });
    expect(
      githubAppFingerprint({ appId: "2", privateKeyPem: "a", source: "database" }),
    ).not.toBe(base);
    expect(
      githubAppFingerprint({ appId: "1", privateKeyPem: "b", source: "database" }),
    ).not.toBe(base);
  });

  it("is stable for identical credentials regardless of source", () => {
    const a = githubAppFingerprint({
      appId: "1",
      privateKeyPem: "a",
      source: "database",
    });
    const b = githubAppFingerprint({
      appId: "1",
      privateKeyPem: "a",
      source: "env",
    });
    expect(a).toBe(b);
  });

  it("never embeds the private key material itself", () => {
    const print = githubAppFingerprint({
      appId: "1",
      privateKeyPem: "SUPER-SECRET-PEM",
      source: "database",
    });
    expect(print).not.toContain("SUPER-SECRET-PEM");
    expect(print).toHaveLength(16);
  });
});

describe("createGithubAppProvider", () => {
  it("builds the client once and reuses it while credentials are unchanged", async () => {
    const createClient = vi.fn((c: { appId: string }) => ({ id: c.appId }));
    const provider = createGithubAppProvider({
      resolve: async () => ok("1", "pem"),
      logger: silent,
      createClient,
    });

    const first = await provider.get();
    const second = await provider.get();

    expect(first).toBe(second);
    // 指纹没变就不该重建：重建会丢掉客户端内部的 installation token 缓存。
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the credentials rotate", async () => {
    const createClient = vi.fn((c: { appId: string }) => ({ id: c.appId }));
    let current = ok("1", "pem");
    const provider = createGithubAppProvider({
      resolve: async () => current,
      logger: silent,
      createClient,
    });

    const before = await provider.get();
    current = ok("2", "other-pem");
    const after = await provider.get();

    expect(before).not.toBe(after);
    expect(after).toEqual({ id: "2" });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing client when the lookup throws", async () => {
    const createClient = vi.fn((c: { appId: string }) => ({ id: c.appId }));
    let fail = false;
    const provider = createGithubAppProvider({
      resolve: async () => {
        if (fail) throw new Error("database down");
        return ok("1", "pem");
      },
      logger: silent,
      createClient,
    });

    const before = await provider.get();
    fail = true;
    const during = await provider.get();

    // 数据库抖一下不该让正在跑的 worker 失去 GitHub 访问能力。
    expect(during).toBe(before);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("drops the client when credentials become unconfigured", async () => {
    let current: GithubAppResolution = ok("1", "pem");
    const provider = createGithubAppProvider({
      resolve: async () => current,
      logger: silent,
      createClient: (c) => ({ id: c.appId }),
    });

    expect(await provider.get()).not.toBeNull();
    current = { outcome: "not_configured" };
    expect(await provider.get()).toBeNull();
  });

  it("returns null and never falls back when the stored key cannot be decrypted", async () => {
    const createClient = vi.fn((c: { appId: string }) => ({ id: c.appId }));
    const provider = createGithubAppProvider({
      resolve: async () => ({
        outcome: "decrypt_failed",
        reason: "open_failed",
      }),
      logger: silent,
      createClient,
    });

    // 回落到 env 会让用户以为界面里保存的凭据在生效，实际却在用另一个身份。
    expect(await provider.get()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("recovers once the credentials become usable again", async () => {
    let current: GithubAppResolution = { outcome: "not_configured" };
    const provider = createGithubAppProvider({
      resolve: async () => current,
      logger: silent,
      createClient: (c) => ({ id: c.appId }),
    });

    expect(await provider.get()).toBeNull();
    current = ok("7", "pem");
    // 未配置时不能永久放弃：用户随时可能在 WebUI 里配好。
    expect(await provider.get()).toEqual({ id: "7" });
  });

  it("logs a repeated problem only once", async () => {
    const warn = vi.fn();
    const provider = createGithubAppProvider({
      resolve: async () => ({ outcome: "not_configured" }),
      logger: { ...silent, warn },
      createClient: (c) => ({ id: c.appId }),
    });

    await provider.get();
    await provider.get();
    await provider.get();

    // 每轮 pass 都刷同一条会淹没日志。
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs again after the problem changes", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    let current: GithubAppResolution = { outcome: "not_configured" };
    const provider = createGithubAppProvider({
      resolve: async () => current,
      logger: { ...silent, warn, error },
      createClient: (c) => ({ id: c.appId }),
    });

    await provider.get();
    current = { outcome: "decrypt_failed", reason: "master_key_missing" };
    await provider.get();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
