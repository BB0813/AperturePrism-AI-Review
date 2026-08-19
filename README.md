# AperturePrism-AI-Review

独立开发的 **GitHub Issue 分析与 Pull Request 审查平台**：接入 GitHub 事件（Webhook/OAuth），由任务引擎 + 多模型路由器驱动分析 Worker，对 Issue 做结构化分级分析、对 PR 做多专家审查并发布评论/Review；附带 Web 控制台（深色玻璃 UI）、QQ 机器人渠道、重复检测（全文+信号+向量 RAG）、仓库记忆、Agent Skills / 专家团队、仓库互助点星与完整运维能力（审计、备份、速率限制、Docker 一键部署）。

仓库：[BB0813/AperturePrism-AI-Review](https://github.com/BB0813/AperturePrism-AI-Review)

---

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [系统架构](#系统架构)
- [文档索引](#文档索引)
- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [配置参考](#配置参考)
- [WebUI 功能对齐](#webui-功能对齐)
- [API 端点速查](#api-端点速查)
- [开发阶段](#开发阶段)
- [目录结构](#目录结构)
- [说明与边界](#说明与边界)

---

## 项目简介

AperturePrism 把「AI 代码审查」做成了一条可落地的产品链路，而不是单个模型调用：

1. **入口**：GitHub Webhook（验签 + 幂等入库）、WebUI 手动触发、QQ 机器人指令。
2. **调度**：持久化任务引擎（状态机 / 租约 / 重试 / 幂等），Scheduler 负责租约回收与到期重试。
3. **分析**：多模型路由器在统一 deadline 下按候选策略调用（主调用 + 受限 repair），Issue 输出结构化分级（category/severity/priority/quality），PR 输出行级 finding。
4. **增强**：重复 Issue 检测（标题/正文全文 + 信号 + pgvector 向量召回 → 模型裁决）、仓库记忆（反思沉淀 → 合并 Agent → 上下文回灌）、Agent Skills + 多专家并行审查。
5. **发布**：幂等发布 GitHub 评论 / Review（head SHA 绑定），支持标签规则自动打标。
6. **运营**：深色 Web 控制台（SSE 实时事件 + 断线回放）、GitHub OAuth 登录与管理员角色、操作审计、配置备份、速率限制、向量索引管理、Docker 全栈打包。

参考项目 Sakura-AI 仅作为本地只读参考资料（`archive/` 目录不随仓库提交），本项目为独立实现。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| 手动触发 | WebUI「已安装仓库」页按仓库 + 编号手动触发 Issue 分析 / PR 审查（`POST /tasks/manual`） |
| 广告识别 | 分析前自识别广告/垃圾 Issue，按 `spam_handling` 策略自动关闭或删除（默认 `close`，可 `none`/`delete`，全部记录审计） |
| Issue 分析 | Webhook 幂等 → 上下文预算化 → 结构化分级（S0-S3 / P0-P3 / 完整度）→ 幂等评论 + 自动打标 |
| PR 审查 | diff 解析与行映射、大小/预算降级、结构化 finding + 服务端严重度策略、幂等 Review 发布 |
| 重复检测 | 模板清洗标准化 + 信号抽取（错误码/路径/堆栈/语言）+ 全文 GIN + pgvector 召回 → 模型裁决 |
| 仓库记忆 | 每次分析/审查自动沉淀「反思」；Scheduler 定期用模型合并成规则/知识；再次分析时回灌上下文 |
| Agent Skills / 专家团队 | 6 个内置技能（triage/security/dependency/performance/docs/test）+ 多专家并行审查 + 主编合并（可选开关） |
| 仓库互助 | 注册 GitHub 账户（token AES-GCM 加密）→ 定时给目标展示仓库点星，互相引流 |
| Web 控制台 | 深色玻璃 UI：概览 / 日志 / Issue / PR / 队列 / 仓库 / 向量存储 / 记忆 / Agent / 互助 / 配置 / 安全 / 用户 |
| 认证与安全 | GitHub OAuth 登录 + Bearer 令牌；首个登录用户自动为管理员；敏感操作审计日志；速率限制 |
| 索引与 RAG | index-worker 定时索引仓库 Issue（内容哈希去重 + 批量 embedding + 重建）；只读召回接口 |
| QQ 机器人 | NTQQ 第三方协议（OneBot 11 / Satori / Milky）+ 官方开放平台 api-v2 |
| 运维 | 一键安装脚本、Docker 全栈打包、迁移/备份脚本、健康检查、SSE 实时事件 |

## 系统架构

```text
                        ┌────────────────────────────────────────────┐
 GitHub App/Webhook ────┤                                            │
 GitHub OAuth (登录) ────┤          apps/api  (:3000)                 │
 QQ 机器人 (NTQQ/官方) ──┤  Webhook/认证/任务/结果/SSE/配置/审计       │
 WebUI (React+nginx) ───┤                                            │
                        └───────────────┬────────────────────────────┘
                                        │ 任务入队 / 结果回写
                    ┌───────────────────▼───────────────────────┐
                    │  PostgreSQL (pgvector)    Redis            │
                    │  tasks/events/results/    SSE 广播/任务事件 │
                    │  issue_documents(向量)    租约/队列         │
                    │  memory/audit/users/star  │                │
                    └───────────────────┬───────────────────────┘
                                        │ 领取/心跳/完成
        ┌───────────────┬───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼               ▼
  analysis-worker  index-worker     scheduler        qq-bot        (migrate)
  Issue/PR 分析    索引+RAG        租约回收/重试     QQ 渠道        一次性迁移
  多模型路由+      embedding      记忆合并 Agent
  专家团队/记忆
```

- **多模型路由**：`MODEL_PROVIDER_BASE_URLS` 配置 OpenAI 兼容 Provider；模型密钥 AES-GCM 加密存 `provider_accounts`，Worker 用 `CREDENTIAL_MASTER_KEY` 解密。模型角色策略存 `model_role_policies`（issue_analysis / pr_review / duplicate_judgment / memory_consolidation / expert_review）。
- **Embedding 独立**：`EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL`（默认 `nvidia/nv-embed-v1`，4096 维）。

## 文档索引

| 文档 | 说明 |
| --- | --- |
| [总体设计](docs/APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md) | 系统设计、领域模型、模块边界 |
| [模块化开发计划](docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md) | M0–M11 阶段划分与验收 |
| [运维手册（Runbook）](docs/RUNBOOK.md) | 部署、迁移、备份/恢复、健康检查、故障处理 |
| [交接说明](docs/HANDOFF_PROMPT.txt) | 环境与历史实现要点（含 NAS 测试约定） |
| [环境变量模板](.env.example) | 全部可配置项与注释 |

## 快速开始

### 方式 A：本地开发（Node ≥ 22 + PostgreSQL/pgvector + Redis）

```bash
# 1. 一键安装（替代下方 2-5 步）：拉起 PG+Redis、生成 .env、装依赖、迁移
node scripts/install.mjs            # 或 ./scripts/install.sh / npm run setup

# 2. 普通安装
npm install
npm run build
# 3. 配置 .env（参考 .env.example）
# 4. 应用迁移
node scripts/migrate.mjs
# 5. 启动后端（各占一个终端）
npm run dev --workspace apps/api
npm run dev --workspace apps/analysis-worker
npm run dev --workspace apps/index-worker
npm run dev --workspace apps/scheduler
# 可选：QQ 机器人
npm run dev --workspace apps/qq-bot

# 6. 启动 Web（apps/web 独立 workspace）
cd apps/web && npm install && npm run dev
```

- API：[http://127.0.0.1:3000](http://127.0.0.1:3000)（健康检查 `/health/live`、`/health/ready`）
- Web：[http://localhost:5174](http://localhost:5174)（Vite 代理到 API :3000）

### 方式 B：GitHub 直跑（仓库公开，无需先 clone）

```bash
curl -fsSL https://raw.githubusercontent.com/BB0813/AperturePrism-AI-Review/main/scripts/bootstrap.sh | bash
# 传参示例（跳过容器）：
curl -fsSL .../scripts/bootstrap.sh | bash -s -- --skip-docker
```

默认把源码拉到 `~/.apertureprism/AperturePrism-AI-Review`（可用 `APERTUREPRISM_SRC_DIR` 覆盖），复用已拉取副本，再执行完整安装。

## Docker 部署

一键打包了全部组件：`api`、`analysis-worker`、`index-worker`、`scheduler`、`qq-bot`、`migrate`（一次性迁移）与 `web`（nginx 托管 SPA 并反代 API/SSE，同源无需 CORS）。

```bash
# 1. 准备环境文件（密钥不入库）
cp .env.example .env.production
#    填 DATABASE_URL / REDIS_URL / CREDENTIAL_MASTER_KEY / GITHUB_* / EMBEDDING_*

# 2. 应用迁移（一次性）
docker compose -f docker/docker-compose.prod.yml --env-file .env.production run --rm migrate

# 3. 启动全栈（Web 走 80 端口，可用 WEB_PORT 覆盖）
docker compose -f docker/docker-compose.prod.yml --env-file .env.production up -d --build

# 4. 含 QQ 机器人（可选 profile）
docker compose -f docker/docker-compose.prod.yml --env-file .env.production --profile qq up -d

# 5. 验证
curl http://<host>/health/live
curl http://<host>/health/ready    # 200 才代表 DB+Redis 均就绪
```

> 说明：`docker/Dockerfile` 为多阶段构建（deps → build → base → 各服务），`web` 目标独立构建 `apps/web` 静态产物后由 nginx 提供。详细运维见[运维手册](docs/RUNBOOK.md)。

## 配置参考

| 环境变量 | 说明 |
| --- | --- |
| `DATABASE_URL` / `REDIS_URL` | PostgreSQL（需 pgvector 扩展）/ Redis 连接串 |
| `HOST` / `PORT` / `LOG_LEVEL` | API 监听与日志级别 |
| `WEBUI_API_TOKEN` | 可选 Bearer 令牌，保护 WebUI API；不设则开放 |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` / `GITHUB_WEBHOOK_SECRET` | GitHub App（Webhook 验签、installation token、评论发布） |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | WebUI 登录；**回调必须指向本实例**（本地 `http://127.0.0.1:3000/auth/callback`，见下） |
| `MODEL_PROVIDER_BASE_URLS` | Provider → OpenAI 兼容 baseUrl 的 JSON 映射 |
| `CREDENTIAL_MASTER_KEY` | AES-GCM 主密钥：解密 provider 密钥 / star-aid token / 记忆与专家团队模型调用 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | 与 review 模型独立配置（默认 `nvidia/nv-embed-v1`，4096 维） |
| `QQ_BOT_PROTOCOLS` | NTQQ 网关 JSON（onebot11 / satori / milky） |
| `QQ_OFFICIAL_APP_ID` / `QQ_OFFICIAL_APP_SECRET` / `QQ_OFFICIAL_GATEWAY_URL` / `QQ_OFFICIAL_INTENTS` | 官方开放平台 api-v2 |
| `INDEX_INTERVAL_MS` | 索引 Worker 轮询间隔（默认 600000） |

> **OAuth 回调配置**：在 GitHub OAuth App 设置中把回调（Authorization callback URL）配成 `http://127.0.0.1:3000/auth/callback`（本地）或对应部署域名。若回调指向别的域名，本地授权后 code 会送回那个域名，`state` 校验失败（真机联调实测的配置错位）。

## WebUI 功能对齐

参考产品 Sakura-AI 的功能清单，AperturePrism 采用「能整合的整合、能写出的写出」。M8/M9/M11 及后续能力（一键安装、安全管理、记忆管理、Agent Skills + 专家团队、仓库互助）已全部上线：

| 参考功能 | 当前状态 | 落点 / 计划 |
| --- | --- | --- |
| 仪表盘 | ✅ 已上线 | 概览 KPI + 状态分布 + 依赖健康 + 实时事件流 |
| 实时监控 / 审查日志 / 操作日志 | ✅ 已整合 | 并入「日志总览」（历史 + 实时 + 断点续传 + 诊断包） |
| PR 审查 / Issue 分析 | ✅ 已上线 | 结果页（PR / Issue）+ 富结果卡 |
| 审查队列 | ✅ 已上线 | 任务队列（筛选 + 详情） |
| 已安装仓库 / 仓库扫描 | ✅ 已上线 | 仓库列表 + 统计；index-worker 定时扫描 + `/index/run`、`/index/rebuild`、`/index/status` |
| 向量存储 & 数据库 | ✅ 已上线 | 向量存储页（issue_documents 统计 + 索引触发/重建/轮次） |
| 审查策略 / AI 配置 | ✅ 已整合 | 「模型路由」页 + 系统设置热更新 |
| 全局配置 / 系统配置 | ✅ 已整合 | 「系统配置」页（含 Bot 设置 / 接入状态） |
| 标签配置 | ✅ 已上线 | `/label-rules` 分析字段→GitHub 标签；worker 分析完成后自动打标（幂等） |
| 安全管理 | ✅ 已上线 | 独立安全页（访问控制 + 速率限制 + 操作审计 `/audit`）+ 管理员门禁 |
| 安装向导 | ✅ 已上线 | `/setup` 环境检测 + 一键初始化 |
| Agent Skills / 专家团队 | ✅ 已上线 | 技能注册表（6 内置）+ 多专家并行审查（MVP）；`/capabilities` 开关，配置 `expert_review` 策略后启用 |
| 仓库互助 | ✅ 已上线 | star-aid：账户/token 加密 + 目标仓库 + 调度点星 + 互助页 |
| 用户管理 / 个人设置 | ✅ 已上线 | `/users` 管理员角色（首个 OAuth 用户自动为管理员）；`/account` 显示名设置 |
| 配置备份 | ✅ 已上线 | `/backup` 导出（密钥脱敏）+ `/backup/import` 导入 |
| Aprism 记忆管理 | ✅ 已上线 | `repo_memory` 反思沉淀 + 合并 Agent + 上下文回灌 + 记忆页 |
| 关于 | ✅ 已上线 | 官网 <https://www.aprism.top> + 模块/范围说明 |

## API 端点速查

鉴权：设置 `WEBUI_API_TOKEN` 后需 `Authorization: Bearer <token>`（或 SSE `?token=`）；GitHub OAuth 会话令牌等价。标注「管理员」的端点要求当前 OAuth 用户为管理员，Bearer 令牌视为管理员。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health/live` `/health/ready` | 存活 / 就绪（DB+Redis） |
| POST | `/github/webhook` | GitHub 事件入口（验签 + 幂等入库） |
| GET | `/tasks` `/tasks/:id` | 任务列表（分页）/ 详情（时间线 + attempts） |
| POST | `/tasks/manual` | 手动触发 Issue/PR 分析（按仓库 fullName + 编号） |
| GET | `/summary` `/results?type=issue\|pr` `/results/:type/:number` | 概览 KPI / 结果列表 / 单主体各版本结果 |
| GET | `/providers` `/repositories` `/logs` `/vector` | 模型策略 / 仓库 / 日志总览 / 向量索引统计 |
| GET | `/events` | SSE 任务事件流（`?since=` 断线回放） |
| GET / POST | `/index/status` `/index/related` `/index/run` `/index/rebuild` | 索引状态 / 只读召回 / 触发 / 重建 |
| GET·PUT | `/settings` | 运行时配置读取（密钥脱敏）/ 热更新 |
| GET·POST | `/backup` `/backup/import` | 配置导出 / 导入（导入需管理员） |
| GET·PUT·DELETE | `/label-rules` | 标签规则管理 |
| GET·PUT | `/auth/me` | 当前账号（登录名 / 显示名 / 是否管理员） |
| GET·PUT | `/users` `/users/:login` | 用户列表 / 管理员切换（需管理员） |
| GET | `/audit` | 操作审计日志（需管理员） |
| GET·POST·DELETE | `/memory` `/memory/consolidate` `/memory/:id` | 仓库记忆列表 / 触发合并（管理员）/ 删除（管理员） |
| GET·PUT | `/capabilities` | Agent 技能 + 专家团队目录 / 开关（PUT 需管理员） |
| GET·POST·DELETE | `/star-aid` | 仓库互助账户/目标管理 + 立即点星（需管理员） |
| GET·POST | `/setup/status` `/setup/init` | 安装向导检测 / 一键初始化（init 需管理员） |

## 开发阶段

| 阶段 | 主要内容 | 状态 |
| --- | --- | --- |
| M0 | Monorepo 与工程基线 | ✅ 已完成 |
| M1 | 数据库、配置与可观测性 | ✅ 已完成 |
| M2 | GitHub App 与事件入口（Webhook） | ✅ 已完成 |
| M3 | 持久任务引擎（状态机/租约/幂等） | ✅ 已完成 |
| M4 | 多模型路由器（统一 deadline/故障转移） | ✅ 已完成 |
| M5 | Issue 分析 MVP（上下文/提示词/受限修复/幂等评论） | ✅ 已完成 |
| M6 | 重复 Issue 检测（标准化/召回/裁决/评测） | ✅ 已完成 |
| M7 | PR Review MVP（diff/行映射/严重度/幂等发布） | ✅ 已完成 |
| M8 | WebUI 与增量事件（SSE，认证/路由保护/断线回放） | ✅ 已完成 |
| M9 | 索引与 RAG（index-worker/只读召回/分析接入） | ✅ 已完成 |
| M10 | QQ 机器人（NTQQ + 官方 api-v2） | ✅ 已完成 |
| M11 | 生产加固与发布（scheduler/速率限制/compose/迁移备份/runbook） | ✅ 已完成 |
| 后续 | 一键安装、安全管理、仓库记忆、Agent Skills/专家团队、仓库互助 | ✅ 已完成 |

> 阶段编号沿用[模块化开发计划](docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md)，实现顺序以仓库为准；WebUI（M8）按需求提前到 M7 之前。

## 目录结构

```text
apps/
  api/                HTTP 入口：webhook/认证/任务/结果/SSE/配置/审计/记忆/互助
  analysis-worker/    Issue/PR 分析执行者（多模型路由 + 专家团队 + 记忆沉淀）
  index-worker/       仓库 Issue 索引（哈希去重 + embedding + 重建）
  scheduler/          租约回收、重试释放、记忆合并 Agent、star-aid 点星
  qq-bot/             QQ 机器人（NTQQ / 官方开放平台）
  web/                Web 控制台（React + Vite，独立 workspace）
packages/
  database/           Drizzle schema + 迁移 + 领域数据访问
  config/             环境配置与 AES-GCM 凭据加密
  domain/             领域类型（任务/模型/结果契约）
  task-engine/        持久任务引擎（租约/心跳/幂等/事件）
  model-router/       多模型路由（deadline/重试/故障转移）
  issue-analysis/     Issue 分析（上下文/提示词/评论/发布）
  pr-review/          PR 审查（diff/行映射/finding/发布）
  duplicate-detection/ 重复检测（标准化/信号/召回/裁决/评测）
  repo-memory / database 记忆表  反思沉淀 + 合并 + 回灌
  agent-capabilities/ Agent Skills + 多专家编排
  star-aid/           仓库互助（token 加密/点星/调度）
  github-adapter/     GitHub App 客户端（JWT/installation/Issue/PR/标签）
  channel-adapters/   QQ 协议规范化（OneBot/Satori/Milky）
  event-stream/       SSE 序列化
  observability/      日志与关联 ID
scripts/
  install.mjs / install.sh / bootstrap.sh   一键安装 / GitHub 直跑
  migrate.mjs / backup.mjs                  迁移 / 备份
docker/
  Dockerfile / nginx.conf / docker-compose.{dev,prod}.yml
```

## 说明与边界

- **Telegram Bot 不属于本项目范围**。
- QQ 机器人通过独立渠道适配器接入：
  - NTQQ 第三方 Bot 协议：[OneBot 11](https://github.com/botuniverse/onebot-11)、[Satori](https://satori.chat/zh-CN/protocol/)、[Milky](https://milky.ntqqrev.org/)
  - 官方 QQ 开放平台机器人（api-v2）：[bot.q.qq.com](https://bot.q.qq.com/wiki/develop/api-v2/)
- **重复检测**：向量仅用于召回，最终裁决由服务端策略完成，第一版不自动关闭 Issue。
- **专家团队 / 记忆合并**：属于可选增强，需要配置对应模型角色策略（`expert_review` / `memory_consolidation`）后启用；未配置时自动降级为单模型审查。
- **Docker 全栈**：`web` 通过 nginx 与 API 同源反代，浏览器无 CORS；SSE 已关闭代理缓冲。
