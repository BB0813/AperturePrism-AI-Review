import { describe, expect, it } from "vitest";
import {
  buildRotationMeta,
  isRotationExpired,
  isRotationKey,
  parseRotationMeta,
  rotationKeyFor,
} from "./settings-rotation.js";

/** 纯函数层（无需 DB）的轮换逻辑单测。 */
describe("settings-rotation 纯函数", () => {
  it("rotationKeyFor / isRotationKey 维护伪键命名空间", () => {
    expect(rotationKeyFor("oauth_client_secret")).toBe(
      "_rotation:oauth_client_secret",
    );
    expect(isRotationKey("_rotation:x")).toBe(true);
    expect(isRotationKey("oauth_client_secret")).toBe(false);
  });

  it("buildRotationMeta 记录旧值、轮换时间与过期时间", () => {
    const now = new Date("2026-08-25T00:00:00Z");
    const meta = buildRotationMeta("old-secret", now, 86_400_000);
    expect(meta.value).toBe("old-secret");
    expect(meta.rotatedAt).toBe(now.toISOString());
    expect(meta.expiresAt).toBe("2026-08-26T00:00:00.000Z");
  });

  it("parseRotationMeta 解析合法元数据，拒绝非法/缺失", () => {
    const meta = buildRotationMeta("v", new Date("2026-08-25T00:00:00Z"));
    expect(parseRotationMeta(JSON.stringify(meta))).toEqual(meta);
    expect(parseRotationMeta(undefined)).toBeNull();
    expect(parseRotationMeta("not-json")).toBeNull();
    expect(parseRotationMeta('{"value":"v"}')).toBeNull(); // 缺时间字段
  });

  it("isRotationExpired 按窗口边界判断", () => {
    const meta = buildRotationMeta(
      "v",
      new Date("2026-08-25T00:00:00Z"),
      24 * 60 * 60 * 1_000,
    );
    expect(
      isRotationExpired(meta, new Date("2026-08-25T23:59:59Z")),
    ).toBe(false);
    expect(isRotationExpired(meta, new Date("2026-08-26T00:00:00Z"))).toBe(
      true,
    );
  });
});
