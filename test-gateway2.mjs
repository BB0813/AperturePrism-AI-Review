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
  { type: "function", function: { name: "read_file", description: "读取仓库中某个文件的 UTF-8 内容（基于当前 PR 的 head 分支）。path 是仓库内相对路径，如 src/main.ts。大文件只返回开头部分。仅用于读取，禁止修改。", parameters: { type: "object", properties: { path: { type: "string", description: "仓库内相对文件路径" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_directory", description: "列出仓库中某个目录下的条目（文件名与子目录名）。path 为仓库内相对路径，传空字符串表示仓库根目录。", parameters: { type: "object", properties: { path: { type: "string", description: "目录相对路径（空=仓库根目录）" } } } } },
  { type: "function", function: { name: "get_git_info", description: "获取当前 PR 的元信息：标题、head 分支与 sha、base 分支。用于了解变更范围与目标分支。", parameters: { type: "object", properties: {} } } },
];

// 模拟 worker 的请求：较长的 system + user，带 tools。
const system = "你是一个严谨的 GitHub Issue 分析器。你的任务是基于 Issue 正文和评论，输出一份结构化分析 JSON。输出必须严格符合契约。";
const user = "仓库: BB0813/AperturePrism-AI-Review\nIssue #30\n状态: open\n标题: 建议在审核结果中标注具体代码行号\n正文: 建议可以将每个issue的功能请求或bug改进方案具体在哪些行写出来，这样更省时间，方便上手";

async function call(baseUrl, apiKey) {
  const body = {
    model: "deepseek-v3.2",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools,
    max_tokens: 2500,
    temperature: 0.2,
  };
  try {
    const r = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    return { status: r.status, preview: text.slice(0, 120) };
  } catch (e) {
    return { err: e.message };
  }
}

for (const [name, base, k] of [["newapi", "https://newapi.binbim.top/v1", newapiKey], ["cdn", "https://cdn-newapi.binbim.top/v1", cdnKey]]) {
  let ok = 0, fail = 0;
  for (let i = 0; i < 5; i++) {
    const r = await call(base, k);
    const good = r.status >= 200 && r.status < 300;
    if (good) ok++; else fail++;
    console.log(`${name} #${i + 1} =>`, JSON.stringify(r).slice(0, 200));
    await new Promise((res) => setTimeout(res, 800));
  }
  console.log(`${name}: ok=${ok} fail=${fail}`);
}
