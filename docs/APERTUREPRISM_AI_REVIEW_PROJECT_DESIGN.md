# AperturePrism-AI-Review 项目总体设计

## 1. 项目定位

`AperturePrism-AI-Review` 是独立开发的 AI 驱动 GitHub Pull Request 审查与 Issue 分析平台。

本项目不是 Sakura AI 的重构分支，不兼容或依赖 Sakura AI 的数据库、API、配置和运行时代码。Sakura AI 仅作为产品与工程参考，用于识别有价值的功能、已经验证的技术方向，以及新项目必须避免的架构问题。

项目目标是从零建立边界清晰、任务可靠、分析结果可解释、能够渐进扩展的新系统，而不是复制现有项目后修改名称。

## 2. 代码复用与许可证边界

Sakura AI 使用 AGPL-3.0。AperturePrism-AI-Review 默认采用独立实现方式，功能借鉴与源码复用必须严格区分。

### 2.1 可以独立实现的能力

- PR 自动审查与 Check Run 集成。
- Issue 分析、分类和信息完整性判断。
- 多模型路由、重试与故障转移。
- GitHub App、Webhook 和评论命令。
- 持久任务、幂等、租约和故障恢复。
- 重复 Issue 检测。
- 严重度与优先级判断。
- SSE 实时任务状态。
- 代码索引、RAG 和语义检索。
- 后续 QQ 官方机器人接入。

这些属于通用产品能力、架构模式或公开 API 的使用方式，可以依据独立规格重新实现。

### 2.2 不直接复制的内容

除非明确接受并履行 AGPL-3.0 义务，否则不复制或轻微改写：

- Sakura AI 的函数、类、模块和数据库模型。
- 提示词、结果协议和模板的具体表达。
- HTML、CSS、JavaScript 和页面布局。
- 配置结构、迁移脚本和测试样本。
- 文档中的原创文字和图表。

正式发布前应单独确定本项目许可证；涉及许可证兼容性的最终判断应由具备资质的法律人员复核。

## 3. 产品目标与边界

### 3.1 核心目标

- 自动分析 GitHub PR，给出有证据、可定位的问题。
- 自动分析 Issue，拆分严重度、优先级、信息质量和重复关系。
- 支持多个 Provider、账号和模型候选，故障时自动切换。
- 保证同一个 Issue 或 PR revision 不会被重复分析或重复发布。
- 提供简单、可发现的手动命令。
- 提供简洁、快速、面向任务的 WebUI。
- 所有长任务可恢复、可重试、可取消、可审计。
- 通过渠道适配层为后续 QQ 官方机器人预留接入能力。

### 3.2 首期非目标

- Telegram Bot。
- QQ 官方机器人首期实现。
- 支付、兑换码和复杂商业套餐。
- 通用自主编程 Agent Team。
- 自动合并 PR。
- 无人工确认的高风险仓库修改。
- 自研向量数据库或任务中间件。

QQ 官方机器人属于明确的后续计划，但必须在核心任务 API、权限模型和通知事件稳定后接入，不能成为业务核心的依赖。

## 4. 技术栈

### 4.1 运行时和工程

- Node.js 22 LTS。
- TypeScript，启用严格模式。
- pnpm workspace monorepo。
- Turborepo 负责构建缓存和任务编排。
- NestJS，使用 Fastify Adapter。
- Zod 负责系统边界和共享协议校验。
- Pino 负责结构化日志。

选择 NestJS 的原因是模块、依赖注入、生命周期和测试边界适合多应用 monorepo；Fastify Adapter 提供较低的 HTTP 开销。领域层不得依赖 NestJS decorator，以避免业务核心与框架绑定。

### 4.2 数据与基础设施

- PostgreSQL 16+ 作为主数据库。
- Drizzle ORM 和 drizzle-kit 管理 schema 与迁移。
- Redis 7+ 用于缓存、速率限制、SSE 跨实例广播和短期协调。
- pgvector 用于第一版向量检索。
- PostgreSQL 持久任务表与 `FOR UPDATE SKIP LOCKED` Worker。

PostgreSQL 是任务状态的事实来源。Redis 不承担不可恢复的业务任务存储，Redis 故障不得导致已入队任务丢失。

### 4.3 GitHub、AI 与 WebUI

- Octokit 负责 GitHub App、Webhook 和 REST/GraphQL API。
- 自建 TypeScript Model Adapter，支持 OpenAI、Anthropic、Gemini 和 OpenAI-compatible 协议。
- React + Vite 构建 WebUI。
- TanStack Query 管理服务端状态。
- React Router 管理页面路由。
- SSE 提供任务级增量事件。

### 4.4 测试与质量门禁

- Vitest：单元和模块测试。
- Testcontainers：PostgreSQL、Redis 集成测试。
- Playwright：WebUI 与关键用户流程。
- ESLint：静态规则。
- Prettier：格式化。
- TypeScript `tsc --noEmit`：类型检查。

## 5. 总体架构

```text
GitHub Webhook / WebUI / Future QQ Bot
                  |
                  v
         API and Event Gateway
                  |
                  v
         Persistent Task Engine
       dedupe / merge / lease / retry
                  |
       +----------+----------+
       |                     |
       v                     v
 Issue Analysis Worker   PR Review Worker
       |                     |
       +----------+----------+
                  |
                  v
             Model Router
      deadline / retry / fallback
                  |
                  v
       Result Contract Validator
                  |
       +----------+----------+
       |                     |
       v                     v
 Duplicate Engine       Review Policy
       |                     |
       +----------+----------+
                  |
                  v
           GitHub Publisher
        idempotent operations
                  |
                  v
       Timeline / SSE / Channels
```

### 5.1 部署应用

| 应用 | 职责 |
| --- | --- |
| `api` | Webhook、REST API、认证、WebUI 后端、任务创建 |
| `analysis-worker` | Issue 和 PR 分析编排 |
| `index-worker` | Issue、文档和代码 embedding |
| `scheduler` | 租约回收、周期维护和索引调度 |
| `web` | React WebUI |
| `qq-bot` | 后续 QQ 官方机器人适配器，首期不部署 |

服务可使用同一代码仓库和基础镜像，但采用不同启动入口。API 进程不执行 AI、索引、Git clone 等长任务。

## 6. Monorepo 结构

```text
apertureprism-ai-review/
├── apps/
│   ├── api/
│   ├── analysis-worker/
│   ├── index-worker/
│   ├── scheduler/
│   ├── web/
│   └── qq-bot/                 # 后续阶段启用
├── packages/
│   ├── domain/                 # 纯 TypeScript 领域模型和规则
│   ├── contracts/              # API、事件和 AI 结果 Zod schema
│   ├── database/               # Drizzle schema、迁移和 repositories
│   ├── task-engine/            # 幂等、租约、重试和状态机
│   ├── model-router/           # Provider adapters 与 fallback
│   ├── github-adapter/         # GitHub App 与发布操作
│   ├── issue-analysis/         # Issue 分析与评分
│   ├── duplicate-detection/    # 候选召回和证据裁决
│   ├── pr-review/              # PR 上下文与审查编排
│   ├── event-stream/           # timeline、outbox 和 SSE
│   ├── channel-adapters/       # 渠道无关命令和通知端口
│   ├── observability/          # 日志、指标和 tracing
│   └── test-support/
├── tooling/
├── docker/
├── docs/
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
└── LICENSE
```

### 6.1 模块依赖原则

- `domain` 不依赖 NestJS、Octokit、数据库或具体 AI SDK。
- `contracts` 只定义跨边界数据，不包含业务编排。
- 应用层依赖领域端口，基础设施包实现端口。
- `model-router` 不依赖 GitHub；`github-adapter` 不依赖模型协议。
- `channel-adapters` 只调用公开任务和查询接口，不直接调用分析器。
- `qq-bot` 只能依赖渠道端口和共享契约，不能访问 Worker 内部模块。
- 数据库变更只通过 drizzle migration 执行。

## 7. 持久任务引擎

### 7.1 核心数据

`analysis_tasks`：

| 字段 | 含义 |
| --- | --- |
| `id` | UUID/ULID 任务 ID |
| `task_type` | `issue_analysis`、`pr_review`、`repository_index` |
| `repository_id` | GitHub repository ID |
| `subject_number` | Issue/PR number |
| `subject_revision` | Issue 内容 revision 或 PR head SHA |
| `policy_version` | 分析策略版本 |
| `dedupe_key` | 唯一业务幂等键 |
| `status` | 状态 |
| `priority` | 领取优先级 |
| `payload` | 规范化输入 |
| `pending_payload` | 运行期间合并的新输入 |
| `lease_owner` | Worker ID |
| `lease_expires_at` | 租约过期时间 |
| `heartbeat_at` | 心跳时间 |
| `attempt_count` | 已执行次数 |
| `max_attempts` | 最大执行次数 |
| `next_attempt_at` | 下次执行时间 |
| `last_error_category` | 标准错误类型 |
| `created_at` / `updated_at` | 时间戳 |

关键约束：

```sql
UNIQUE (dedupe_key)
INDEX (status, next_attempt_at, priority, created_at)
INDEX (lease_expires_at)
```

### 7.2 幂等键

```text
issue-analysis:{repository_id}:{issue_number}:{content_revision}:{policy_version}
pr-review:{repository_id}:{pr_number}:{head_sha}:{policy_version}
```

GitHub delivery ID 只防止同一投递重复消费，不能替代业务幂等键。

### 7.3 状态机

```text
queued -> leased -> running -> publishing -> completed
                     |             |
                     v             v
                 retry_wait      failed
                     |
                     v
                   queued
```

- 相同 `dedupe_key` 返回已有任务。
- 同一对象运行期间 revision 改变时，只保存最新 pending revision。
- 当前任务结束后再创建最新 revision 任务。
- 同一对象和 revision 禁止并发执行。
- GitHub 发布操作拥有独立幂等键和外部对象 ID。

## 8. 多模型路由

### 8.1 角色配置

```yaml
modelRoles:
  issueAnalysis:
    totalTimeoutMs: 300000
    candidates:
      - provider: provider-a
        model: model-a
        requestTimeoutMs: 90000
        maxAttempts: 2
      - provider: provider-b
        model: model-b
        requestTimeoutMs: 120000
        maxAttempts: 1
```

模型角色至少包括：

- `issueAnalysis`
- `duplicateVerification`
- `prReview`
- `summary`
- `contractRepair`

### 8.2 统一 deadline

每次逻辑调用创建且只创建一个 deadline：

```ts
const deadline = performance.now() + totalTimeoutMs;
const remaining = deadline - performance.now();
const attemptTimeout = Math.min(candidateTimeoutMs, remaining);
```

候选切换、同模型重试、上下文压缩和协议修复都消耗同一预算。

### 8.3 错误策略

| 错误 | 同候选重试 | 切换候选 |
| --- | --- | --- |
| 连接失败 | 是 | 是 |
| 429 | 有条件 | 是 |
| 5xx | 是 | 是 |
| 单次请求超时 | 有条件 | 是 |
| 401/403 | 否 | 是 |
| 模型不存在 | 否 | 是 |
| 上下文超限 | 压缩一次 | 是 |
| 输出协议错误 | 修复一次 | 是 |
| 用户取消 | 否 | 否 |

某候选在当前任务成功后，后续调用优先使用该候选。该粘性只对当前任务生效。

## 9. Issue 分析与重复检测

### 9.1 分析维度

- 分类：bug、feature、question、security、performance 等。
- Severity：S0、S1、S2、S3、Unknown。
- Priority：P0、P1、P2、P3、Needs triage。
- Quality：complete、actionable、incomplete、invalid。
- Confidence：分别记录严重度、根因、重复和建议置信度。

S0/S1 或 P0/P1 必须引用复现步骤、日志、堆栈、数据损坏、安全路径或明确影响范围等证据。证据不足时必须输出 `Unknown` 或 `Needs triage`。

### 9.2 重复检测流程

1. 标准化标题、正文和模板字段。
2. 提取模块、版本、错误码、异常、堆栈和复现步骤。
3. 使用全文检索、pgvector 和结构化字段召回候选。
4. 比较根因、触发条件、错误表现、影响模块和环境。
5. 使用独立模型角色验证候选。
6. 由服务端契约和策略完成最终裁决。

结果只能是：

```text
duplicate
related
not_duplicate
insufficient_evidence
```

向量相似度只负责召回，不得直接判定重复。第一版不自动关闭 Issue。

## 10. PR 审查

主路径：

```text
领取任务
  -> 获取 PR 元数据与 diff
  -> 准备必要上下文
  -> 执行主模型审查
  -> 校验结果契约和代码位置
  -> 幂等发布 Review
  -> 完成任务
```

以下功能不得阻塞主审查：

- 仓库文档和代码向量索引。
- PR 摘要。
- 依赖图。
- 语义 Issue 关联。
- 历史趋势统计。

索引可用时使用；索引缺失时通过 diff、GitHub 文件 API 和按需搜索完成审查。

## 11. 命令与渠道适配

### 11.1 GitHub 评论命令

| 上下文 | 命令 | 行为 |
| --- | --- | --- |
| Issue | `/analyze` | 分析当前 Issue |
| PR | `/review` | 审查当前 PR |
| Issue 或 PR | `/retry` | 重试最近一次失败任务 |
| 任意评论 | `/prism help` | 显示当前上下文命令 |

命令必须位于评论首个非空行；忽略代码块和引用中的命令。Webhook 上下文决定仓库和对象，用户无需填写编号。

### 11.2 渠道抽象

渠道适配层定义统一端口：

```ts
interface CommandIngress {
  normalize(input: unknown): Promise<NormalizedCommand>;
}

interface NotificationChannel {
  send(notification: TaskNotification): Promise<ExternalMessageRef>;
  update(ref: ExternalMessageRef, notification: TaskNotification): Promise<void>;
}
```

GitHub 和未来 QQ 官方机器人都通过该端口创建任务、查询状态和发送通知。渠道不能直接执行模型调用。

### 11.3 QQ 官方机器人后续计划

接入范围：

- 在群聊或私聊中提交仓库与 Issue/PR 链接进行分析。
- 查询任务状态和最近结果。
- 接收失败、完成和需要人工确认的通知。
- 展示可用命令与权限错误。

接入前置条件：

- QQ 官方机器人平台账号和所需权限已具备。
- 核心任务 REST API 和事件协议已经版本化。
- GitHub 身份与 QQ 身份绑定流程已完成威胁建模。
- 仓库访问权限必须在服务端重新校验，不能信任聊天消息声明。
- QQ 平台回调需要签名验证、重放防护、限流和业务幂等。

QQ 机器人不接收或展示 Provider 密钥，不允许绕过 GitHub 仓库授权，也不直接执行自动合并或代码修改。

## 12. WebUI

普通用户导航：

- 概览。
- 任务。
- PR 审查。
- Issue 分析。
- 设置。

管理员导航：

- GitHub App。
- Provider 与模型路由。
- Worker 状态。
- 索引管理。
- 审计事件。
- 渠道集成。
- 系统设置。

概览页只展示运行中任务、失败或等待人工处理的任务、最近结果和 Provider 健康状态。趋势报表放在独立页面。

SSE 必须推送任务级增量事件：

```json
{
  "sequence": 101,
  "entity": "task",
  "entityId": "01J...",
  "event": "stageChanged",
  "payload": {"stage": "analyzing"}
}
```

前端只更新对应实体，不重新请求完整 Dashboard 或任务历史。历史列表使用 cursor 分页和必要的虚拟化渲染。

## 13. API 边界

核心接口：

```text
POST /api/v1/tasks
GET  /api/v1/tasks/:taskId
GET  /api/v1/tasks/:taskId/events?after=100
POST /api/v1/tasks/:taskId/retry
POST /api/v1/tasks/:taskId/cancel
POST /api/v1/issues/:issueId/duplicate-feedback
```

所有外部响应由共享 Zod schema 定义并版本化。内部 Worker 不通过 HTTP 回调修改任务状态，而是通过 task-engine 和数据库事务更新。

## 14. 可观测性

任务阶段指标：

- Queue wait。
- Fetch duration。
- Model attempt duration。
- Fallback count。
- Validation duration。
- Publish duration。
- Total duration。

系统指标：

- 各状态任务数量和最老排队任务年龄。
- Worker 并发、租约回收和事件积压。
- PostgreSQL pool wait time。
- Redis 连接和 SSE subscriber 数。
- GitHub API rate remaining。
- Provider 可用性和错误分类。

质量指标：

- 重复 Issue 误报率和人工推翻率。
- 严重度人工修改率。
- 模型 fallback 成功率。
- 相同 revision 重复任务率。
- 结果协议失败率。
- PR Review 问题人工接受率。

日志、指标和 trace 必须携带 `requestId`、`taskId`、`attemptId` 和 `repositoryId`，但不得包含密钥、installation token 或完整私有仓库源码。

## 15. 安全要求

- Provider 密钥加密存储，日志不得输出明文。
- GitHub installation token 不进入任务 payload 和错误日志。
- Issue、PR、仓库文件、网页与聊天消息均视为不可信输入。
- 模型输出必须通过 schema 和业务策略校验。
- AI 输出不能直接构造或执行未经审批的 Shell、SQL 和高风险 GitHub 操作。
- Webhook 与 QQ 回调必须验证签名、防重放并记录 delivery/event ID。
- 所有 GitHub 和渠道副作用都有幂等键。
- 取消信号必须传播到 AI HTTP 请求和发布阶段。
- 身份授权在每次敏感操作时根据当前服务端状态重新校验。

## 16. 开发顺序

1. Monorepo、工程质量门禁和本地基础设施。
2. GitHub App、Webhook 和规范化事件。
3. PostgreSQL 持久任务引擎与独立 Worker。
4. 多模型 Router 和共享 deadline。
5. Issue 分析、评分和 GitHub 发布。
6. 重复 Issue 检测与人工反馈评测。
7. PR Review 最短路径。
8. React WebUI 与 SSE 增量更新。
9. 索引与 RAG 增强。
10. QQ 官方机器人适配。

详细模块依赖、阶段交付物和验收门槛见模块化开发文档。

## 17. MVP 验收标准

### 17.1 可靠性

- 相同 revision 的重复有效分析率接近 0。
- Worker 重启不丢失已入队任务。
- 重试不创建重复 GitHub 评论或 Check Run。
- 模型 fallback 遵守统一总超时。

### 17.2 性能

- Webhook 入队响应 p95 小于 500 ms，不等待 AI。
- PR 主模型调用开始时间 p95 小于 10 秒，不含 GitHub 外部异常延迟。
- SSE 更新不触发页面全量重载。
- 数据库事务不跨 AI、embedding 或 Git clone 等外部长操作。

### 17.3 质量

- 高置信度 duplicate precision 达到项目约定目标，初始建议不低于 95%。
- 低置信度重复判断不自动关闭 Issue。
- S0/S1 和 P0/P1 全部包含明确证据。
- 输出协议失败时不执行自动标签、关闭或 Review 决策。

### 17.4 工程质量

- Domain 不依赖 NestJS 和基础设施实现。
- PR/Issue 编排器不包含 Provider 协议细节。
- GitHub Publisher 不包含提示词和评分逻辑。
- CI 通过 lint、format check、typecheck、unit test 和 integration test。

## 18. 结论

AperturePrism-AI-Review 应以 Node.js/TypeScript monorepo 独立实现。核心建设顺序是先解决任务可靠性和模型故障转移，再交付 Issue 分析与 PR Review，最后扩展索引、WebUI 和外部渠道。

Telegram Bot 不进入项目范围。QQ 官方机器人保留为后续正式模块，通过稳定的任务 API、事件协议和渠道端口接入，不侵入分析核心，也不削弱 GitHub 权限边界。
