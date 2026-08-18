# AperturePrism-AI-Review

独立开发的 GitHub Issue 分析与 Pull Request 审查平台。

- 总体设计：`docs/APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md`
- 模块化开发计划：`docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md`

> 参考项目 Sakura-AI 仅用作本地只读参考资料（`archive/`），不随仓库提交。

## 当前进度

- **已完成**：M0–M7（工程基线 → Webhook → 任务引擎 → 多模型路由 → Issue 分析 → 重复检测 → PR Review MVP），以及 QQ 机器人渠道（NTQQ + 官方开放平台）。
- **进行中 / 下一步**：M8 WebUI —— 概览 / **Issue / PR 结果页**（结构化结果已持久化到 `subject_results`，`/results` API）/ 任务列表（cursor 分页）/ 任务详情（生命周期时间线 + attempts）/ **Provider 页**；后续接入认证与 SSE 任务事件推送。再往后 M9 索引与 RAG。
- 关键链路已在 NAS 隔离测试环境（postgres+redis）以真实 GitHub 与真实模型验证：
  - Issue 全纵向：webhook 幂等 → GitHub 拉取 → 多模型分析 → 评级 → 幂等评论发布。
  - 重复检测全链路：全文+信号+向量(pgvector)召回 → deepseek 裁决 → 服务端裁决。
- M6 附带一个轻量标注数据集（`eval-data.ts`）与离线评测脚本（`eval-runner.ts`），可计算 precision / recall / 误报率 / 人工介入率等指标。

## 开发阶段

| 阶段 | 主要内容 | 状态 |
| --- | --- | --- |
| M0 | Monorepo 与工程基线 | ✅ 已完成 |
| M1 | 数据库、配置与可观测性 | ✅ 已完成 |
| M2 | GitHub App 与事件入口（Webhook） | ✅ 已完成 |
| M3 | 持久任务引擎（状态机/租约/幂等），NAS 实测通过 | ✅ 已完成 |
| M4 | 多模型路由器（统一 deadline/故障转移），NAS 实测通过 | ✅ 已完成 |
| M5 | Issue 分析 MVP（上下文/提示词/受限修复/幂等评论），NAS 实测通过 | ✅ 已完成 |
| M6 | 重复 Issue 检测（标准化/召回/裁决/评测），NAS 实测通过 | ✅ 已完成 |
| M7 | PR Review MVP：diff 解析/行映射、大小与预算降级、结构化 finding/严重度策略、受限修复、幂等发布 | ✅ 已完成 |
| M10 | QQ 机器人（NTQQ：OneBot 11 / Satori / Milky；官方 api-v2） | ✅ 已完成 |
| M8 | WebUI 与增量事件（SSE）——提前开发 | 🚧 进行中（标签/任务列表/详情时间线已就位） |
| M9 | 索引与 RAG | ⏳ 待开发 |
| M11 | 生产加固与发布 | ⏳ 待开发 |

> 阶段编号沿用模块化开发计划，实现顺序以仓库为准；WebUI（M8）按需求提前到 M7 之前。

## 本地命令

```bash
npm install
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run build
```

## 配置（本地 `.env`，不入 git）

- 数据库 / Redis / 日志 / 健康检查
- WebUI：`WEBUI_API_TOKEN`（可选 Bearer 令牌，保护 `/tasks`、`/results`、`/providers`、`/events`；不设则开放）
- GitHub App：`GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY_PATH`、`GITHUB_WEBHOOK_SECRET`
- 模型：`MODEL_PROVIDER_BASE_URLS`（review 模型）+ `CREDENTIAL_MASTER_KEY`（加密存 provider 密钥到数据库）
- Embedding（与 review 模型**独立**配置 API 与 Key）：
  - `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`（默认 `nvidia/nv-embed-v1`，4096 维）
- QQ：`QQ_BOT_PROTOCOLS`（NTQQ）或 `QQ_OFFICIAL_APP_ID/APP_SECRET`（官方）

详见 `.env.example`。

## 说明

- Telegram Bot 不属于本项目范围。
- QQ 机器人通过独立渠道适配器接入：
  - NTQQ 第三方 Bot 协议：OneBot 11、Satori、Milky
    - (OneBot 11)：[https://github.com/botuniverse/onebot-11]
    - Satori：<https://satori.chat/zh-CN/protocol/>
    - Milky：<https://milky.ntqqrev.org/>
  - 官方 QQ 开放平台机器人（api-v2）：<https://bot.q.qq.com/wiki/develop/api-v2/>
- 重复检测：向量仅用于召回，最终裁决由服务端策略完成，第一版不自动关闭 Issue。
- 模型选择（newapi 通道）：`deepseek-chat` 会被路由到推理模型（输出 `think` 块、不支持 `json_object`），结构化输出请用 `deepseek-v4-flash`（实测干净 JSON）。三类角色策略（issue_analysis / duplicate_judgment / pr_review）均已配置为此模型。