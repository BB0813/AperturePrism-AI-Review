import { describe, expect, it } from "vitest";
import {
  NON_SECRET_EXPORTABLE_KEYS,
  redactBackupSetting,
} from "./backup-redact.js";

describe("redactBackupSetting", () => {
  it("never exports the value of a known secret", () => {
    // 这几项此前全部被明文写进备份文件，而界面还写着「密钥值已脱敏」。
    for (const key of [
      "webui_api_token",
      "github_webhook_secret",
      "oauth_client_secret",
      "embedding_api_key",
      "qq_official_app_secret",
      "github_app_private_key",
      "qq_bot_protocols",
    ]) {
      const row = redactBackupSetting({ key, value: "SUPER-SECRET" });
      expect(row.value).toBeNull();
      // 仍然告诉用户「这项已配置」，只是值需要手工重填。
      expect(row.hasValue).toBe(true);
    }
  });

  it("defaults to redacting an unregistered key", () => {
    // 默认拒绝是关键：新增键忘记登记时不会因此泄露。
    const row = redactBackupSetting({
      key: "some_future_credential",
      value: "leak-me",
    });
    expect(row.value).toBeNull();
  });

  it("redacts dynamic keys that can carry model conversation text", () => {
    const row = redactBackupSetting({
      key: "pr_review_history:owner/repo:42",
      value: JSON.stringify({ messages: [{ content: "internal source code" }] }),
    });
    expect(row.value).toBeNull();
  });

  it("exports the value of allowlisted non-secret settings", () => {
    expect(redactBackupSetting({ key: "log_level", value: "debug" }).value).toBe(
      "debug",
    );
    expect(
      redactBackupSetting({ key: "issue_rewrite_title", value: "false" }).value,
    ).toBe("false");
  });

  it("reports hasValue=false for an empty or whitespace-only value", () => {
    expect(redactBackupSetting({ key: "log_level", value: "" }).hasValue).toBe(
      false,
    );
    expect(
      redactBackupSetting({ key: "webui_api_token", value: "   " }).hasValue,
    ).toBe(false);
  });

  it("keeps every secret-ish key out of the allowlist", () => {
    // 白名单里不该出现任何名字里带 secret/token/key/password 的键。
    for (const key of NON_SECRET_EXPORTABLE_KEYS) {
      expect(key).not.toMatch(/secret|token|password/);
      // github_app_id 是编号不是密钥，api_key 之类才是。
      expect(key).not.toMatch(/api_key|private_key/);
    }
  });
});
