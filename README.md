# AperturePrism-AI-Review

独立开发的 GitHub Issue 分析与 Pull Request 审查平台。

- 总体设计：`docs/APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md`
- 模块化开发计划：`docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md`

> 参考项目 Sakura-AI 仅用作本地只读参考资料（`archive/`），不随仓库提交。

## 当前进度

- **已完成**：M0–M7（工程基线 → Webhook → 任务引擎 → 多模型路由 → Issue 分析 → 重复检测 → PR Review MVP），以及 QQ 机器人渠道（NTQQ + 官方开放平台）。
- **已完成**：M8 WebUI（深色控制台 + Bearer/OAuth 认证 + SSE 实时推送 + 断线回放）、M9 索引与 RAG（index-worker 内容哈希去重/批量 embedding/状态与重建 + `/index/*` 只读接口 + Issue 分析相关 Issue 召回）、M11 生产加固（scheduler 租约回收、生产 compose、迁移/备份脚本、速率限制、runbook）。
- **已完成**：WebUI 功能对齐可落地项——配置备份（`/backup` 导出/导入）、标签配置（`/label-rules` 自动打标）、个人设置（`/account`）、用户管理（`/users` 管理员角色）。
- 关键链路已在 NAS 隔离测试环境（postgres+redis）以真实 GitHub 与真实模型验证：
  - Issue 全纵向：webhook 幂等 → GitHub 拉取 → 多模型分析 → 评级 → 幂等评论发布。
  - 重复检测全链路：全文+信号+向量(pgvector)召回 → deepseek 裁决 → 服务端裁决。
  - 标签自动打标：配置 `category:bug → bug` 规则后，分析完成的 Issue 被自动打上对应 GitHub 标签。
  - WebUI 登录闭环：`/auth/login` → GitHub 授权 → 本地回调校验 `state` → 签发会话令牌 → `/auth/me` 识别登录用户与管理员角色（真机验证通过）。
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
- GitHub OAuth（WebUI 登录）：`GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET`
  - **回调地址必须指向本实例**：在 GitHub OAuth App 设置中把回调（Authorization callback URL）配成 `http://127.0.0.1:3000/auth/callback`（本地）或对应部署域名。若回调指向别的域名，本地授权后 code 会送回那个域名，state 校验失败（真机联调实测的配置错位）。
- 模型：`MODEL_PROVIDER_BASE_URLS`（review 模型）+ `CREDENTIAL_MASTER_KEY`（加密存 provider 密钥到数据库；同时用于仓库互助 star_aid 的账户 token 加密、记忆合并与专家团队的模型调用）
- Embedding（与 review 模型**独立**配置 API 与 Key）：
  - `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`（默认 `nvidia/nv-embed-v1`，4096 维）
- QQ：`QQ_BOT_PROTOCOLS`（NTQQ）或 `QQ_OFFICIAL_APP_ID/APP_SECRET`（官方）

详见 `.env.example`。

## 本地启动

依赖：Node ≥ 22、PostgreSQL（pgvector 扩展）、Redis。

1. 安装与构建（Monorepo）：

   ```bash
   npm install
   npm run build
   ```

2. 在仓库根目录写 `.env`（参考 `.env.example`）：数据库 / Redis / 模型 / Embedding；WebUI 登录另配 GitHub OAuth（`GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`）。
3. 应用数据库迁移（需 `DATABASE_URL`）：

   ```bash
   node scripts/migrate.mjs
   ```

4. 启动后端服务（API + 分析 worker + 索引 worker + scheduler，各占一个终端）：

   ```bash
   npm run dev --workspace apps/api
   npm run dev --workspace apps/analysis-worker
   npm run dev --workspace apps/index-worker
   npm run dev --workspace apps/scheduler
   ```

   可选：QQ 机器人 `npm run dev --workspace apps/qq-bot`（需配置 `QQ_BOT_PROTOCOLS` 或 `QQ_OFFICIAL_*`）。
5. 启动 Web（`apps/web` 已移出根 workspaces，需独立安装）：

   ```bash
   cd apps/web && npm install && npm run dev
   ```

- API：http://127.0.0.1:3000（健康检查 `/health/live`、`/health/ready`）
- Web：http://localhost:5174（Vite 代理到 API :3000）
- GitHub OAuth 回调必须指向 `http://127.0.0.1:3000/auth/callback`（见「配置」）；首个 OAuth 登录用户自动成为管理员

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

参考产品（Sakura-AI）的功能清单，AperturePrism 采用「能整合的整合、能写出的写出」。**M8 / M9 / M11 已完成**；M11 后的能力补齐（一键安装、安全管理、记忆管理、Agent Skills + 专家团队、仓库互助）已全部上线。当前状态：

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
| 标签配置 | ✅ 已上线 | `/label-rules` 管理分析字段→GitHub 标签规则；worker 分析完成后自动打标（幂等） |
| 安全管理 | ✅ 已上线 | 独立「安全管理」页（访问控制 + 速率限制 + 操作审计日志 `/audit`）+ 敏感操作全记录 + 管理员门禁 |
| 系统配置 | ✅ 已上线 | 含 Bot 设置 / 接入状态 |
| 安装向导 | ✅ 已上线 | `/setup` 环境检测 + 一键初始化 |
| 关于 | ✅ 已上线 | 官网 https://www.aprism.top + 模块/范围说明 |
| 仓库扫描 | ✅ 已上线 | index-worker 定时扫描 + `/index/run`、`/index/rebuild`、`/index/status` |
| Agent 专家团队 | ✅ 已上线 | 多专家并行审查 + 主编合并（MVP），`/capabilities` 开关；配置 `expert_review` 模型角色策略后启用 |
| Agent Skills | ✅ 已上线 | 技能注册表（6 个内置：issue_triage/security/dependency/performance/docs/test_effectiveness），供审查提示词组合 |
| 仓库互助 | ✅ 已上线 | star_aid：注册账户（token AES-GCM 加密）+ 目标展示仓库 + 调度点星 + 互助页 |
| 用户管理 | ✅ 已上线 | `/users` 管理员角色（首个 OAuth 登录用户自动为管理员），用户列表 + 权限切换 |
| 个人设置 | ✅ 已上线 | `/account` 页显示登录账号 + 显示名设置（OAuth） |
| 配置备份 | ✅ 已上线 | `/backup` 导出（密钥脱敏）+ `/backup/import` 导入设置与策略 |
| Aprism 记忆管理 | ✅ 已上线 | `repo_memory` 反思沉淀（分析/审查后自动写入）+ 合并 Agent（scheduler 定期把反思合并为规则/知识）+ 上下文回灌 + 记忆页 |

## API 端点速查

鉴权：设置 `WEBUI_API_TOKEN` 后，以下端点需 `Authorization: Bearer <token>`（或 SSE `?token=`）；GitHub OAuth 登录会签发等价会话令牌。标注「管理员」的端点要求当前 OAuth 用户为管理员（首个登录用户自动是），Bearer 令牌视为管理员。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health/live` `/health/ready` | 存活 / 就绪（DB+Redis） |
| POST | `/github/webhook` | GitHub 事件入口（验签 + 幂等入库） |
| GET | `/tasks` `/tasks/:id` | 任务列表（cursor/offset 分页）/ 详情（时间线 + attempts） |
| GET | `/summary` `/results?type=issue\|pr` `/results/:type/:number` | 概览 KPI / 结果列表 / 单主体各版本结果 |
| GET | `/providers` `/repositories` `/logs` `/vector` | 模型策略 / 仓库 / 日志总览 / 向量索引统计 |
| GET | `/events` | SSE 任务事件流（`?since=` 断线回放） |
| GET | `/index/status` `/index/related` | 索引轮次状态 / 只读相关 Issue 召回 |
| POST | `/index/run` `/index/rebuild` | 触发索引 / 重建索引 |
| GET·PUT | `/settings` | 运行时配置读取（密钥脱敏）/ 热更新 |
| GET·POST | `/backup` `/backup/import` | 配置导出 / 导入（导入需管理员） |
| GET·PUT·DELETE | `/label-rules` | 标签规则管理 |
| GET·PUT | `/auth/me` | 当前账号（登录名 / 显示名 / 是否管理员） |
| GET·PUT | `/users` `/users/:login` | 用户列表 / 管理员切换（需管理员） |
| GET | `/audit` | 操作审计日志（需管理员） |
| GET·DELETE·POST | `/memory` `/memory/:id` `/memory/consolidate` | 仓库记忆列表 / 删除（管理员）/ 触发合并（管理员） |
| GET·PUT | `/capabilities` | Agent 技能 + 专家团队目录 / 专家团队开关（PUT 需管理员） |
| GET·POST·DELETE | `/star-aid` 等 | 仓库互助账户/目标管理 + 立即点星（需管理员） |
| GET·POST | `/setup/status` `/setup/init` | 安装向导检测 / 一键初始化（init 需管理员） |