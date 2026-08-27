import { createDecipheriv } from "node:crypto";

const master = "gT/RpSN9E0K8P0MpJnWZfWz1PKbEaoVDzstBvNfd27o=";
const key = Buffer.from(master, "base64");
function open(sealed) {
  const [v, ivB, tagB, ctB] = sealed.split(".");
  const iv = Buffer.from(ivB, "base64");
  const tag = Buffer.from(tagB, "base64");
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
}
const newapiKey = open("v1.2sajYYyliuhaZ8Dj.1tTS8KAbpwGXqme/P7Mv4A==.Reyz9zHgQCTOFPk01pFUHh64z97/2HK+bXFdtO3EdqUeBYKlPQLk21d6UaU9/Q3cgrSc");
const cdnKey = open("v1.PUUCU8NNaC1wkbEm.GCFgnGCi7aIZ25BKBf0dZA==.sb3P1unyodJi+w27pBDWDf8XpTdaj8E2yDe+xwWDSOhFsCv+cUuXrKiPsuXc+VG0h1yv");

const tools = [
  { type: "function", function: { name: "read_file", description: "读取仓库中某个文件的 UTF-8 内容。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_directory", description: "列出目录条目。", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "get_git_info", description: "获取 PR 元信息。", parameters: { type: "object", properties: {} } } },
];

const system = "你是一个严谨的 GitHub Issue 分析器。输出必须严格符合契约 JSON。可以调用 read_file / list_directory / get_git_info 查看仓库源码，以定位这个 Issue 描述的问题出在哪个文件。proposedChanges 里的 path 必须是你确实读到过的真实文件；找不到相关代码时省略该字段，不要编造。";
const user = "仓库: BB0813/AperturePrism-AI-Review\nIssue #30\n标题: 建议在审核结果中标注具体代码行号\n正文: 建议可以将每个issue的功能请求或bug改进方案具体在哪些行写出来，这样更省时间，方便上手\n\n请读取源码定位并给出带行号的修改建议。";

async function chat(baseUrl, apiKey, body) {
  try {
    const r = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    return { err: e.message };
  }
}

for (const [name, base, k] of [["newapi", "https://newapi.binbim.top/v1", newapiKey], ["cdn", "https://cdn-newapi.binbim.top/v1", cdnKey]]) {
  // 第一轮：带 tools
  const r1 = await chat(base, k, { model: "deepseek-v3.2", messages: [{ role: "system", content: system }, { role: "user", content: user }], tools, max_tokens: 2000, temperature: 0.2 });
  console.log(name, "round1 =>", r1.status ?? r1.err, r1.status >= 200 && r1.status < 300 ? "OK" : r1.text?.slice?.(0, 200) ?? "");
  if (!(r1.status >= 200 && r1.status < 300)) continue;
  let parsed;
  try { parsed = JSON.parse(r1.text); } catch { console.log(name, "round1 not json"); continue; }
  const msg = parsed.choices?.[0]?.message;
  const calls = msg?.tool_calls;
  console.log(name, "tool_calls:", calls ? calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(", ") : "none");
  if (!calls || calls.length === 0) continue;
  // 执行工具（模拟 read_file 返回内容）
  const results = calls.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments }));
  const toolMessages = [
    { role: "system", content: system },
    { role: "user", content: user },
    { role: "assistant", content: "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } })) },
    ...results.map((r) => ({ role: "tool", tool_call_id: r.id, content: `这是 ${r.name} 的结果：\n文件 src/main.ts 内容:\nconst x = 1;\nexport function foo() { return x; }\n` })),
  ];
  // 第二轮：带 tool 结果
  const r2 = await chat(base, k, { model: "deepseek-v3.2", messages: toolMessages, max_tokens: 2000, temperature: 0.2 });
  console.log(name, "round2 =>", r2.status ?? r2.err, r2.status >= 200 && r2.status < 300 ? "OK" : r2.text?.slice?.(0, 300) ?? "");
  await new Promise((res) => setTimeout(res, 600));
}
