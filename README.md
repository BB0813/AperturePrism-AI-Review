# AperturePrism-AI-Review

独立开发的 GitHub Issue 分析与 Pull Request 审查平台。

- 总体设计：`docs/APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md`
- 模块化开发计划：`docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md`

> 参考项目 Sakura-AI 仅用作本地只读参考资料（`archive/`），不随仓库提交。

## 当前进度

- **已完成**：M0–M7（工程基线 → Webhook → 任务引擎 → 多模型路由 → Issue 分析 → 重复检测 → PR Review MVP），以及 QQ 机器人渠道（NTQQ + 官方开放平台）。
- **已完成**：M8 WebUI（深色控制台 + Bearer/OAuth 认证 + SSE 实时推送 + 断线回放）、M9 索引与 RAG（index-worker 内容哈希去重/批量 embedding/状态与重建 + `/index/*` 只读接口 + Issue 分析相关 Issue 召回）、M11 生产加固（scheduler 租约回收、生产 compose、迁移/备份脚本、速率限制、runbook）。
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
| M8 | WebUI 与增量事件（SSE）——提前开发 | ✅ 已完成（认证/路由保护/SSE 推送与断线回放/任务与结果页） |
| M9 | 索引与 RAG | ✅ 已完成（index-worker 哈希去重/批量 embedding/状态与重建 + 只读召回接口 + 分析接入相关 Issue） |
| M11 | 生产加固与发布 | ✅ 已完成（scheduler/速率限制/生产 compose/迁移备份/runbook） |

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
    - OneBot 11：<https://github.com/botuniverse/onebot-11>
    - Satori：<https://satori.chat/zh-CN/protocol/>
    - Milky：<https://milky.ntqqrev.org/>
  - 官方 QQ 开放平台机器人（api-v2）：<https://bot.q.qq.com/wiki/develop/api-v2/>
- 重复检测：向量仅用于召回，最终裁决由服务端策略完成，第一版不自动关闭 Issue。

## WebUI 功能对齐路线

参考产品（Sakura-AI）的功能清单，AperturePrism 采用「能整合的整合、能写出的写出」。**M8 / M9 / M11 已完成**，剩余与 Agent 能力 / 用户体系绑定的功能（专家团队、Skills、互助、用户管理、配置备份）继续按此表逐项评估。当前状态：

| 参考功能 | 当前状态 | 落点 / 计划 |
| --- | --- | --- |
| 仪表盘 | ✅ 已上线 | 概览 KPI + 状态分布 + 依赖健康 + 实时事件流 |
| 实时监控 | ✅ 已整合 | 并入「日志总览」（历史 + 实时 + 断点续传） |
| 审查日志 | ✅ 已整合 | 并入「日志总览」+ 复制诊断包 |
| 操作日志 | ✅ 已整合 | 并入「日志总览」（Webhook 投递 + 任务事件） |
| PR 审查 | ✅ 已上线 | 结果页（PR） |
| Issue 分析 | ✅ 已上线 | 结果页（Issue）+ 富结果卡 |
| 审查队列 | ✅ 已上线 | 任务队列（筛选 + 详情） |
| 已安装仓库 | ✅ 已上线 | 仓库列表 + 统计 |
| 向量存储 & 数据库 | ✅ 已上线 | 向量存储页（issue_documents 统计 + 索引触发 / 重建 / 最近轮次） |
| 审查策略 / AI 配置 | ✅ 已整合 | 「模型路由」页 + 系统设置热更新 |
| 全局配置 | ✅ 已整合 | 「系统配置」页 |
| 标签配置 | 🚧 部分 | Issue 结果内展示建议标签；编辑留待后续 |
| 安全管理 | 🚧 部分 | Webhook 开关 / 密钥热更新 / API 与 Webhook 速率限制；细粒度权限留待后续 |
| 系统配置 | ✅ 已上线 | 含 Bot 设置 / 接入状态 |
| 安装向导 | ✅ 已上线 | `/setup` 环境检测 + 一键初始化 |
| 关于 | ✅ 已上线 | 官网 https://www.aprism.top + 模块/范围说明 |
| 仓库扫描 | ✅ 已上线 | index-worker 定时扫描 + `/index/run`、`/index/rebuild`、`/index/status` |
| Agent 专家团队 | ⏳ 计划 | 依赖 Agent 能力，M11 后评估 |
| Agent Skills | ⏳ 计划 | 依赖 Agent 能力，M11 后评估 |
| 仓库互助 | ⏳ 计划 | 与 Agent/知识库绑定，M11 后评估 |
| 用户管理 | ⏳ 计划 | 多账号体系，M11 后评估 |
| 个人设置 | ⏳ 计划 | 跟随用户体系，M11 后评估 |
| 配置备份 | ⏳ 计划 | 导出/导入设置与策略，M11 后评估 |
| Sakura 记忆管理 | ⏳ 计划 | 记忆本体不在本项目范围，不强行对齐 |