import { describe, expect, it } from "vitest";
import {
  cjkNgrams,
  normalizeBody,
  normalizeTitle,
  normalizedIndexText,
  stripMarkdownMedia,
} from "./normalize.js";

describe("stripMarkdownMedia", () => {
  it("removes image syntax entirely", () => {
    // 截图型 Issue 很常见；不清理的话 `![ ](` 会成为唯一被索引的「内容」。
    const body =
      "![Image_1787378041313_762.jpg](https://github.com/user-attachments/assets/abc)\n仪表盘一直显示连接中断";
    const normalized = normalizeBody(body);
    expect(normalized).not.toContain("![");
    expect(normalized).not.toContain("](");
    expect(normalized).toContain("仪表盘一直显示连接中断");
  });

  it("keeps link labels but drops targets", () => {
    expect(stripMarkdownMedia("见 [部署文档](https://example.com/doc)").trim()).toBe(
      "见 部署文档",
    );
  });

  it("drops pasted HTML media tags", () => {
    expect(stripMarkdownMedia('<img src="x.png" /> 报错').trim()).toBe("报错");
  });

  it("leaves a screenshot-only body with no leftover scaffolding", () => {
    const onlyImage = "![x.jpg](https://github.com/u/a/1)\n\n";
    expect(normalizeBody(onlyImage)).toBe("");
  });

  it("also cleans titles", () => {
    expect(normalizeTitle("![x](https://e.com/1) 连接失败")).toBe("连接失败");
  });
});

describe("cjkNgrams", () => {
  it("splits Chinese runs into overlapping bigrams", () => {
    expect(cjkNgrams("一直连接失败")).toEqual([
      "一直",
      "直连",
      "连接",
      "接失",
      "失败",
    ]);
  });

  it("lets two differently-worded Chinese titles share tokens", () => {
    // 这正是 #8 与 #9 的情形：同一问题、不同措辞。simple 全文配置把整段中文
    // 当作单个 token，旧的 ilike 整串包含也匹配不上，因此两者互不召回。
    const a = cjkNgrams("一直连接失败");
    const b = cjkNgrams("连接bug 仪表盘一直显示连接中断");
    expect(a.filter((gram) => b.includes(gram))).toEqual(["一直", "连接"]);
  });

  it("returns nothing for non-CJK text so recall falls back to full text", () => {
    expect(cjkNgrams("connection failed")).toEqual([]);
  });

  it("keeps a short run whole", () => {
    expect(cjkNgrams("连接")).toEqual(["连接"]);
  });

  it("never emits regex metacharacters, so patterns can be concatenated", () => {
    const grams = cjkNgrams("连接失败：超时（30 秒）后 [重试] a.b*c");
    const metacharacters = /[.*+?^${}()|[\]\\]/u;
    expect(grams.every((gram) => !metacharacters.test(gram))).toBe(true);
  });
});

describe("normalizedIndexText", () => {
  it("produces searchable text for a screenshot-only issue", () => {
    const text = normalizedIndexText({
      title: "一直连接失败",
      body: "![x.jpg](https://github.com/u/a/1)\n\n",
    });
    expect(text).toBe("一直连接失败");
  });
});
