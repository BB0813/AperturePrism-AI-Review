# AperturePrism-AI-Review 模块化阶段开发计划

## 1. 文档目的

本文档把总体设计拆分为可以依次实现、单独测试和独立验收的开发阶段。每个阶段必须形成可运行的纵向切片，禁止在前置能力不稳定时同时铺开 Issue、PR、索引、WebUI 和 QQ 机器人。

开发原则：

- 先建立可靠基础，再增加 AI 功能。
- 每阶段只引入完成该阶段所需的最小模块。
- 每个模块通过公开契约协作，不读取其他模块内部表或私有实现。
- 阶段验收未通过，不进入依赖它的下一阶段。
- 首期保持模块化单体和多进程部署，不提前拆分微服务。

## 2. 阶段总览

| 阶段 | 主要交付 | 依赖 | 建议里程碑 |
| --- | --- | --- | --- |
| M0 | Monorepo 与工程基线 | 无 | 工程可构建 |
| M1 | 数据库、配置和可观测性 | M0 | 基础设施可运行 |
| M2 | GitHub App 与事件入口 | M1 | Webhook 可安全入库 |
| M3 | 持久任务引擎 | M2 | 任务可恢复且不重复 |
| M4 | 多模型路由器 | M1、M3 | Provider 可故障转移 |
| M5 | Issue 分析 MVP | M2、M3、M4 | Issue 可完整分析和发布 |
| M6 | 重复 Issue 检测 | M5 | 重复判断可评测 |
| M7 | PR Review MVP | M2、M3、M4 | PR 可完成结构化审查 |
| M8 | WebUI 与增量事件 | M3、M5、M7 | 用户可管理任务和结果 |
| M9 | 索引与 RAG | M5、M7 | 增强上下文但不阻塞主流程 |
| M10 | QQ 官方机器人 | M3、M5、M7、M8 | QQ 渠道可安全使用核心能力 |
| M11 | 生产加固 | 所有上线模块 | 满足发布门槛 |

M5 和 M7 在 M4 完成后可以由不同开发者并行；M8 可以先覆盖已经稳定的 Issue 流程，再接入 PR。M10 不属于首期 MVP。

## 3. 模块清单与职责

### 3.1 `packages/domain`

职责：

- 任务、Issue、PR、模型调用和通知的领域类型。
- 状态机规则、严重度和优先级规则。
- 与框架无关的端口接口。

禁止依赖：

- NestJS。
- Drizzle、Octokit、Redis 客户端。
- Provider SDK。
- React。

完成标准：核心规则可在纯 Vitest 环境运行。

### 3.2 `packages/contracts`

职责：

- REST 请求和响应 Zod schema。
- Worker 事件、SSE 事件和 AI 结果协议。
- 契约版本和兼容性测试。

约束：

- 不包含数据库实体。
- 不把 Provider 原始响应作为公共契约。
- 新增破坏性字段变更必须提升契约版本。

### 3.3 `packages/database`

职责：

- Drizzle schema 和 migrations。
- repository 实现。
- 事务边界和数据库健康检查。

约束：

- 业务模块不得直接导入 Drizzle 表对象。
- migration 不在应用启动时自动生成或隐式修改 schema。
- 所有时间以 UTC 存储。

### 3.4 `packages/task-engine`

职责：

- 任务创建和业务幂等。
- `SKIP LOCKED` 领取、lease、heartbeat 和回收。
- retry、cancel、pending revision 合并。
- attempt 和阶段事件记录。

不负责：

- Issue/PR 业务分析。
- Provider 调用。
- GitHub 评论内容。

### 3.5 `packages/model-router`

职责：

- Provider adapter。
- 角色到候选模型的解析。
- 统一 deadline、重试、fallback 和任务内粘性。
- token、成本、耗时和错误分类。

不负责：

- 构造 Issue/PR 领域提示词。
- 决定严重度或重复关系。
- 直接写 GitHub。

### 3.6 `packages/github-adapter`

职责：

- GitHub App installation token。
- Webhook 验签和事件规范化。
- PR、Issue、文件、diff 和评论读取。
- Check Run、Review、评论和标签的幂等发布。

约束：

- installation token 只短期存在内存。
- 所有写操作保存 idempotency key 和 GitHub external ID。
- GitHub 限流作为标准错误暴露给上层。

### 3.7 `packages/issue-analysis`

职责：

- Issue 上下文构建。
- 分类、摘要、严重度、优先级和信息质量。
- 提示词与结构化结果验证后的领域映射。

不负责候选重复 Issue 检索；该能力由 `duplicate-detection` 提供。

### 3.8 `packages/duplicate-detection`

职责：

- Issue 标准化和特征提取。
- 全文、向量和结构化候选召回。
- 证据比较和模型验证。
- `duplicate`、`related`、`not_duplicate`、`insufficient_evidence` 裁决。
- 人工反馈与评测数据导出。

### 3.9 `packages/pr-review`

职责：

- PR 规模分类和上下文预算。
- diff、必要文件和按需工具上下文。
- 结构化 finding 验证。
- 行位置映射、去重和发布策略。

索引不可用时必须能够完成审查。

### 3.10 `packages/event-stream`

职责：

- Transactional outbox。
- Task timeline 投影。
- Redis 跨实例广播。
- SSE replay、sequence 和断线恢复。

PostgreSQL 保存可恢复事件；Redis 只用于低延迟分发。

### 3.11 `packages/channel-adapters`

职责：

- 规范化外部渠道命令。
- 将任务状态转换为渠道无关通知。
- 定义消息创建和更新端口。

GitHub 评论命令和 QQ 官方机器人共享这些端口，但各自的签名、权限和消息格式留在具体 adapter。

### 3.12 应用层

`apps/api`：组装 HTTP、Webhook、认证和模块依赖。

`apps/analysis-worker`：领取 Issue/PR 任务并调用对应 use case。

`apps/index-worker`：异步执行 embedding 和索引维护。

`apps/scheduler`：回收 lease、调度维护任务和处理 outbox。

`apps/web`：React WebUI。

`apps/qq-bot`：后续 QQ 官方机器人回调和通知，不进入首期部署。

## 4. M0：Monorepo 与工程基线

### 4.1 交付内容

- pnpm workspace 和 Turborepo。
- Node.js 22 版本约束。
- TypeScript strict 基础配置。
- apps/packages 目录骨架。
- ESLint、Prettier、Vitest。
- CI：install、lint、format check、typecheck、test、build。
- Docker 开发基础和 `.env.example`。
- secret 扫描与依赖漏洞检查。

### 4.2 关键决策

- ESM 或 CommonJS 必须在本阶段固定，推荐 ESM。
- 包导出统一使用 `exports`，禁止跨包深层导入。
- 每个 package 明确 public API。
- 环境变量只能由配置模块读取。

### 4.3 测试

- 所有 package 可以独立 typecheck。
- apps 可以在无业务实现时完成 build。
- CI 在干净环境中可重复运行。

### 4.4 验收门槛

```text
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

全部通过，无需本地隐藏配置。

## 5. M1：数据库、配置与可观测性

### 5.1 交付内容

- PostgreSQL 和 Redis 开发 Compose。
- Drizzle 配置、首个 migration 和 migration 执行命令。
- 配置 schema、环境分层和启动校验。
- Pino JSON 日志。
- request/task/attempt correlation ID。
- `/health/live` 与 `/health/ready`。
- OpenTelemetry 接口和基础指标出口。

### 5.2 初始数据表

- `repositories`
- `github_installations`
- `webhook_deliveries`
- `analysis_tasks`
- `task_attempts`
- `task_events`
- `outbox_events`
- `provider_accounts`
- `model_role_policies`
- `external_publications`

### 5.3 安全要求

- Provider credential 使用应用主密钥封装加密。
- readiness 检查数据库与必要 migration 版本。
- 日志 redaction 覆盖 Authorization、cookie、token 和 credential 字段。

### 5.4 验收门槛

- 新数据库可以只通过 migration 初始化。
- migration 可在 Testcontainers 中完成 up 测试。
- 配置缺失时 fail fast，并且错误不泄露密钥。
- Redis 不可用时 readiness 反映降级状态，但数据库任务数据保持完整。

## 6. M2：GitHub App 与事件入口

### 6.1 交付内容

- GitHub App 配置和 installation 管理。
- Webhook 原始 body 验签。
- delivery ID 持久去重。
- 支持的事件规范化：
  - issues opened/edited/reopened。
  - pull_request opened/reopened/synchronize。
  - issue_comment created。
- Octokit installation client factory。
- `/analyze`、`/review`、`/retry`、`/prism help` 解析。

### 6.2 权限

最小 GitHub App 权限应依据实际发布动作确定并记录。命令执行前校验：

- installation 是否仍有效。
- 仓库是否启用 AperturePrism。
- 触发用户是否满足仓库策略。
- Issue/PR 状态是否允许任务创建。

### 6.3 测试

- 有效签名、错误签名和重放 delivery。
- 事件 JSON 缺失可选字段。
- 命令位于引用或代码块时不触发。
- 相同评论事件只产生一次规范化命令。
- installation token 不进入日志和数据库 payload。

### 6.4 验收门槛

Webhook p95 在本地基准环境小于 500 ms，并且只完成验证、规范化和持久化，不调用 AI。

## 7. M3：持久任务引擎

### 7.1 交付内容

- 稳定 dedupe key builder。
- 原子 create-or-get。
- `FOR UPDATE SKIP LOCKED` 任务领取。
- lease、heartbeat、graceful shutdown。
- 过期 lease 回收。
- retry policy 和指数退避。
- cancel 请求和协作式取消。
- pending revision 合并。
- attempt 与 task event。

### 7.2 状态转换

只有 task-engine 可以修改任务状态。每次转换必须：

1. 校验当前状态。
2. 在事务内写新状态。
3. 写入 task event。
4. 必要时写 outbox event。

禁止 Worker 直接执行任意 `UPDATE analysis_tasks`。

### 7.3 并发测试

- 多 Worker 同时领取同一批任务，无重复领取。
- Worker 在 running 阶段崩溃后可恢复。
- lease 过期前不会被其他 Worker 抢占。
- 相同 dedupe key 并发创建只保留一条任务。
- revision 快速变化只保留当前运行和最新 pending revision。
- cancel 在模型调用、重试等待和发布前均能停止后续步骤。

### 7.4 验收门槛

- 进程强制终止后任务最终恢复。
- 重复 webhook 不创建重复有效任务。
- 所有状态转换可从 task event 审计。

## 8. M4：多模型路由器

### 8.1 交付内容

- Provider adapter port。
- OpenAI、Anthropic、Gemini、OpenAI-compatible adapter。
- 角色候选策略和加密 credential 读取。
- 统一 logical deadline。
- AbortSignal 取消传播。
- 标准错误分类。
- retry、fallback 和任务内候选粘性。
- 结构化输出解析和一次受限 contract repair。
- attempt token、成本和延迟记录。

### 8.2 Provider adapter 契约

Adapter 只负责：

- 将统一消息转换为 Provider 请求。
- 将 Provider 响应转换为统一响应。
- 将 SDK/HTTP 错误映射为标准错误。
- 处理流式取消。

Adapter 不决定是否重试或切换候选。

### 8.3 故障注入测试

- 网络断开。
- 429 与 Retry-After。
- 500/503。
- 请求超时。
- 认证失败。
- 模型不存在。
- 上下文超限。
- 非法结构化输出。
- 用户取消。

### 8.4 验收门槛

- Provider A 故障后可切换 Provider B。
- 所有候选和重试总耗时不超过统一 deadline 加可接受的取消误差。
- 认证错误不在同一候选盲目重试。
- 日志与 attempt 中不包含 credential 和完整敏感 prompt。

## 9. M5：Issue 分析 MVP

### 9.1 交付内容

- Issue context builder。
- Issue 分析 prompt 与 version。
- 结构化结果 contract。
- 分类、Severity、Priority、Quality、Confidence。
- 缺失信息和建议动作。
- GitHub 评论模板。
- 幂等占位评论和原位更新。
- Check/status task events。

### 9.2 分析结果约束

- Severity 和 Priority 分开。
- 高等级必须包含证据。
- 未知信息不得由模型补造。
- contract repair 失败时保存失败状态，不发布自动决策。
- 第一版只建议标签，不自动关闭 Issue。

### 9.3 测试

- 完整 bug 报告。
- 缺少版本和日志的报告。
- 功能请求和问题咨询。
- 安全相关报告的保守处理。
- prompt injection 文本。
- Provider fallback 后仍保持同一任务结果协议。
- 发布重试不产生重复评论。

### 9.4 验收门槛

从 GitHub Issue webhook 到结构化分析、评论发布和任务完成形成完整纵向流程；同一 revision 多次投递只产生一份有效结果。

## 10. M6：重复 Issue 检测

### 10.1 交付内容

- Issue 文本标准化和模板清理。
- PostgreSQL 全文索引。
- pgvector embedding 表和索引。
- 错误码、堆栈、模块和版本特征。
- 混合候选召回和可配置 top-k。
- 证据比较 contract。
- duplicate decision policy。
- 人工反馈 API 和审计记录。
- 离线评测 runner。

### 10.2 分层策略

1. 召回层追求覆盖候选。
2. 证据层比较根因和触发条件。
3. 模型验证层输出结构化相同点和差异。
4. 策略层保守决定自动动作。

向量分数不得直接进入最终 `duplicate` 布尔判断。

### 10.3 数据集

至少建立：

- 明确重复。
- 同主题不同根因。
- 相同错误不同环境。
- 父子问题。
- 回归问题。
- 信息不足。
- 多语言描述。

### 10.4 验收门槛

- 高置信度 duplicate precision 初始目标不低于 95%。
- 评测报告同时展示 precision、recall、false duplicate rate 和人工推翻率。
- 低置信度结果只链接或请求人工确认，不自动关闭。

## 11. M7：PR Review MVP

### 11.1 交付内容

- PR metadata 和 diff 获取。
- 大小和文件类型分类。
- 上下文 token 预算。
- 按需文件读取和代码搜索工具。
- 结构化 finding contract。
- finding 去重和严重度策略。
- diff position/line mapping。
- Check Run 和 PR Review 幂等发布。
- 新 head SHA 任务创建。

### 11.2 主流程约束

- 索引不可用不阻塞审查。
- 大 PR 必须有明确降级策略和提示。
- 无法可靠映射行位置的问题进入总体评论，不强行发布行内评论。
- 每个 finding 包含证据、影响、置信度和建议。
- 低置信度风格意见默认不发布。

### 11.3 测试

- 新增、修改、删除和重命名文件。
- 二进制和生成文件。
- force-push 或 head SHA 更新。
- 大 diff 与截断响应。
- GitHub rate limit。
- Review 发布部分失败和重试。
- 无问题 PR。

### 11.4 验收门槛

- PR 主模型调用开始时间 p95 小于 10 秒，不包含 GitHub 外部异常。
- 同一 head SHA 不重复发布 Review。
- 索引服务关闭时核心审查仍能完成。

## 12. M8：WebUI 与事件流

### 12.1 交付内容

- React/Vite 应用基础。
- 认证和路由保护。
- 概览、任务、Issue、PR、Provider 设置页面。
- Transactional outbox dispatcher。
- task timeline API。
- SSE sequence、replay 和 reconnect。
- cursor 分页。
- 局部缓存更新和必要的列表虚拟化。

### 12.2 UI 原则

- 首屏展示任务和异常，不堆叠大型统计图。
- Provider、索引和渠道配置进入管理区域。
- SSE 事件只更新对应实体。
- 网络断开后使用 sequence 补拉缺失事件。
- loading、empty、error、permission denied 状态完整。

### 12.3 浏览器验收

使用 Playwright 覆盖：

- 创建手动分析任务。
- 观察阶段实时变化。
- 查看 Issue 和 PR 结果。
- 失败任务重试和取消。
- SSE 断线恢复。
- 无权限访问管理员页面。
- 桌面和移动端关键布局。

### 12.4 性能门槛

- 10 万 task event 仍由服务端 cursor 分页，不全量返回。
- 连续 SSE 更新不触发完整页面请求。
- 100 个并发 SSE 连接下 API 延迟无明显退化。

## 13. M9：索引与 RAG 增强

### 13.1 交付内容

- 独立 index-worker。
- 仓库和 Issue 增量索引任务。
- 批量 embedding。
- commit SHA 和内容 hash 去重。
- 索引版本、状态和重建操作。
- PR/Issue 分析只读索引接口。

### 13.2 约束

- 索引任务不持有跨网络调用的长数据库事务。
- 文件读取、embedding 和数据库写入分批处理。
- 索引失败不使 PR/Issue 核心任务失败。
- 私有仓库内容隔离到 repository/installation 权限域。

### 13.3 验收门槛

- 相同 commit 重复索引不重复写入向量。
- 单个仓库失败不阻塞其他仓库。
- 分析主流程可识别索引 unavailable/stale，并正常降级。

## 14. M10：QQ 官方机器人

本阶段是后续扩展，不进入首期 MVP。

### 14.1 前置条件

- QQ 官方机器人平台能力、审核要求和 SDK/API 已完成独立调研。
- 核心任务 API、事件 contract 和 channel adapter 已稳定版本化。
- WebUI 已支持 GitHub 身份与外部渠道身份绑定管理。
- 权限模型和威胁模型通过评审。

### 14.2 模块交付

- `apps/qq-bot` 回调入口。
- QQ 回调签名验证、时间窗口和重放防护。
- QQ 用户/群与平台用户的绑定。
- 仓库授权查询。
- 命令解析和帮助。
- Issue/PR 链接分析。
- 任务状态查询。
- 完成、失败、需要人工确认通知。
- 消息更新或去重策略。
- 渠道级限流与审计。

### 14.3 建议命令语义

具体语法应在确认 QQ 官方平台交互能力后确定，领域命令保持：

- 分析 Issue。
- 审查 PR。
- 查询任务。
- 重试失败任务。
- 获取帮助。

不要让业务层依赖 QQ 特有命令文本或消息结构。

### 14.4 安全测试

- 伪造回调和重放。
- 群成员越权访问私有仓库。
- 未绑定身份执行任务。
- 恶意 GitHub 链接和跨仓库混淆。
- 消息频率滥用。
- 机器人被移出群或权限撤销后的行为。

### 14.5 验收门槛

- QQ 渠道创建的任务与 GitHub/WebUI 创建的任务使用同一幂等和权限逻辑。
- 未授权用户不能通过 QQ 获取私有仓库状态或结果。
- QQ API 故障只影响通知渠道，不影响分析任务最终状态。

## 15. M11：生产加固与发布

### 15.1 可靠性

- 多实例 API 和 Worker 测试。
- Worker graceful shutdown。
- 数据库备份与恢复演练。
- Redis 故障降级。
- Provider 和 GitHub 外部故障演练。
- outbox 积压恢复。

### 15.2 安全

- GitHub App 权限复核。
- credential 轮换。
- 依赖和容器扫描。
- API rate limit。
- 审计日志完整性。
- 私有仓库数据保留和删除策略。
- prompt injection 与工具权限专项测试。

### 15.3 运维

- 生产 Compose 或 Kubernetes manifests。
- migration 发布流程。
- dashboard 和告警。
- runbook。
- SLO 和错误预算。
- 版本与回滚策略。

### 15.4 发布门槛

- 所有 MVP 验收标准通过。
- 无 P0/P1 安全问题。
- 恢复演练通过。
- 关键告警可触发并包含定位信息。
- 生产配置不依赖本地文件或未记录的手工步骤。

## 16. 跨阶段测试矩阵

| 能力 | 单元 | 集成 | E2E | 性能/故障 |
| --- | --- | --- | --- | --- |
| Task Engine | 状态机、幂等键 | PostgreSQL 并发 | API 到 Worker | 崩溃和 lease 回收 |
| Model Router | 错误分类、deadline | Mock Provider server | Issue/PR fallback | 超时、429、5xx |
| GitHub Adapter | 事件规范化 | Webhook/Octokit mock | GitHub sandbox 仓库 | 限流和重试 |
| Issue Analysis | 评分规则 | Router + DB | Issue 到评论 | 并发和重复投递 |
| Duplicate Detection | 特征和策略 | pgvector | 反馈闭环 | 离线评测 |
| PR Review | finding 校验 | diff/position | PR 到 Review | 大 PR、API 限流 |
| WebUI/SSE | reducer/query | API + Redis | Playwright | 100 SSE 连接 |
| QQ Bot | 命令规范化 | 回调与身份绑定 | QQ sandbox | 重放、限流、渠道故障 |

## 17. 开发任务拆分规则

每个实现任务应满足：

- 目标只覆盖一个模块或一个清晰的纵向切片。
- 写明输入契约和输出契约。
- 写明数据库变更与 migration。
- 写明失败分类和重试责任归属。
- 包含自动化测试和可观察信号。
- 不把后续阶段的占位实现合入主分支。

建议 PR 尺寸：

- 基础模块：一个 package 骨架和公开端口。
- 数据变更：migration、repository 和集成测试一起提交。
- 纵向功能：入口、任务、Worker、发布与测试形成最小闭环。
- UI：一个完整用户流程，而不是只提交静态页面。

## 18. 明确禁止的实现方式

- 在 API handler 中直接调用 AI 或执行索引。
- 使用进程内 Promise/定时器作为可靠任务队列。
- Redis 中的临时状态作为唯一任务事实来源。
- 每个 fallback candidate 重置逻辑总超时。
- 使用 embedding 相似度直接关闭重复 Issue。
- 将 Severity、Priority 和 Quality 合并成一个总等级。
- 在 AI 或 GitHub 网络调用期间保持数据库事务。
- SSE 事件触发 Dashboard 全量刷新。
- QQ Bot 直接访问模型、数据库表或 GitHub installation token。
- 在应用启动阶段隐式修改数据库 schema。
- 为未来可能需要的微服务提前复制领域逻辑。

## 19. 推荐首个可交付版本

首个可对外试用版本应完成 M0-M5，并包含：

- GitHub App 安装。
- Issue webhook 和 `/analyze`。
- 持久任务、幂等、Worker 恢复。
- 多模型 fallback 和统一 deadline。
- 多维 Issue 分析。
- 幂等 GitHub 评论。
- 基础任务查询 API。

M6 重复检测和 M7 PR Review 紧随其后。WebUI 可在 M5 后启动开发，但首个内部验证阶段可先通过 GitHub 评论和任务 API 完成。

QQ 官方机器人在核心流程、权限模型和 WebUI 身份管理稳定后实施，避免渠道开发反向决定业务架构。
