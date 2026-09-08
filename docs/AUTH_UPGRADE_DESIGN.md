# AperturePrism 认证 / 账号 / 登录链路升级设计文档

> 版本：v1.1（草案，待审核）
> 日期：2026-09-08
> 范围：账号体系、本地登录、会话生命周期、登录安全、token 存储、审计、SSO、**仓库可见性授权** 共 7 大方向
> 状态：待用户审核后进入实现。已确认：方向四选 A（HttpOnly cookie）、方向六暂缓。

---

## 目录

- [0. 现状盘点（必须读）](#0-现状盘点必须读)
- [1. 方向一：原生账号密码登录 + 统一身份](#1-方向一原生账号密码登录--统一身份)
- [2. 方向二：令牌生命周期（access + refresh / 会话管控）](#2-方向二令牌生命周期access--refresh--会话管控)
- [3. 方向三：登录安全加固](#3-方向三登录安全加固)
- [4. 方向四：token 存储方式](#4-方向四token-存储方式)
- [5. 方向五：审计报表 / 合规](#5-方向五审计报表--合规)
- [6. 方向六：SSO / 统一身份扩展（暂缓）](#6-方向六sso--统一身份扩展暂缓)
- [7. 方向七：仓库可见性授权（新增）](#7-方向七仓库可见性授权新增)
- [8. 落地顺序与依赖关系](#8-落地顺序与依赖关系)
- [9. 风险与兼容性](#9-风险与兼容性)

---

## 0. 现状盘点（必须读）

项目**已经具备**以下基建，升级**不要重复实现**：

| 已有 | 形态 | 位置 |
|---|---|---|
| 用户模型 | `users` 表：`login` / `displayName` / `isAdmin` / `isReadOnly` | `packages/database/src/schema.ts` |
| 第三方登录 | GitHub OAuth，会话用 `createSessionSigner` 签发（HMAC，7 天 TTL） | `apps/api/src/main.ts` (`SESSION_TTL_MS = 7d`, `signSession`/`parseSessionToken`) |
| 角色权限 | `isAdminRequest` / `isReadOnlyRequest` 已接入写操作拦截 | `main.ts` L4108/L4119 |
| 审计 | `audit()` 全写操作留痕（actor/action/target/ip），`GET /audit` admin 页 | `main.ts` L4130 |
| 账号管理 | `GET /users`、`PUT /users/:login`（改角色）、`GET/PUT /account`（本人） | `main.ts` L4030/L4170 |
| 只读操作员 | `isReadOnlyRequest`：OAuth 只读用户可看不可写 | `main.ts` L4119 |

**当前双轨身份来源**（`isAuthorized`，`main.ts` L500-L519）：

```
1. Bearer token（共享明文）: 比对 webuiToken()（DB 运行时设置 > 环境变量 > 空=开放）
2. GitHub OAuth session: parseSessionToken(Bearer) 非空且 oauthConfigured()
```

**真正的缺口（升级点集中在这里）：**

1. **无原生账号登录**：只有"WebUI 单 token（bearer，共享、匿名管理员）"和"GitHub OAuth"两条路；无法输入用户名/密码登录。
2. **bearer token 无生命周期**：静态明文；换 token 即全体下线；无法过期/刷新/单会话撤销。
3. **无会话管理 UI**：无法查看或主动下线具体会话。
4. **token 存 `localStorage`**：XSS 可读；SSE 需 `?token=` 兜底。
5. **无多因子**、无登录限流/锁定、无登录失败审计。
6. **身份未统一**：bearer 记为 `actor="bearer"`（匿名），与 OAuth 用户互斥。

---

## 1. 方向一：原生账号密码登录 + 统一身份

> **定位：地基。** 让 WebUI 支持本地用户名/密码登录，与 GitHub OAuth 会话统一为一套 session 机制；bearer 从"共享明文"升级为"签发给具体用户 + 落库可撤销"的令牌。改造集中、风险低。

### 1.1 Schema 变更（正式 Drizzle 迁移）

```ts
// packages/database/src/schema.ts

// 复用现有 users 表，追加本地区分字段
users 增加列：
  password_hash  text          -- nullable，argon2id(ASCII64)，仅本地账号非空
  totp_secret    text          -- nullable，预留方向三 2FA
  totp_enabled   boolean 默认 false
  created_at     timestamp     -- 便于运维统计
  last_login_at  timestamp nullable

// 新增统一会话表（同时承载 password 与 github 两种来源）
user_sessions:
  id             uuid pk defaultRandom()
  user_login     text  not null references users(login) onDelete cascade
  token_hash     text  not null unique      -- sha256(token) 落库，不存明文
  auth_method    text  not null             -- 'password' | 'github'
  issued_at      timestamp not null defaultNow()
  expires_at     timestamp not null
  last_seen_at   timestamp not null defaultNow()
  revoked_at     timestamp nullable
  user_agent     text
  ip             text

// 索引：
//   (user_login, revoked_at)      —— 本人会话列表
//   token_hash                    —— 由 unique 约束覆盖
```

> 硬性约定：**新增 schema 必须走正式 migration**（项目约定"不得隐式 DDL"）。迁移会为现有 `users` 表补列、建 `user_sessions`，不含破坏性操作；旧数据由「引导用户」逻辑兜底。

### 1.2 密码哈希

- 采用 **argon2id**（`argon2` npm 包或 `node:crypto` 派生方案；优先 argon2，成本参数 `memoryCost=64MiB, timeCost=3`）。
- 统一封装 `hashPassword(pw) -> string` / `verifyPassword(pw, hash) -> boolean`，放 `packages/database/src/auth.ts`，供 api 与测试复用。
- **绝不**明文存储、绝不上屏。

### 1.3 新增 API

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/auth/login` | 本地用户名/密码登录 → 校验 → 建 session → 返回 `{token, user}` | 公开 |
| POST | `/auth/logout` | 吊销当前会话 token | token |
| POST | `/auth/register` | 注册引导（仅当无 admin 用户时开放，一次性） | 引导 |
| POST | `/auth/me/change-password` | 改密（校验旧密，重设，吊销本人其它会话） | token |
| GET | `/auth/me` | 现有 `/auth/me` 改造：返回统一 user 对象 | token |

**`POST /auth/login` 请求/响应：**

```jsonc
// 请求
{ "username": "admin", "password": "xxx" }
// 成功 200
{ "status": "ok", "token": "<session-token>", "user": { "login": "admin", "displayName": "Admin", "isAdmin": true, "isReadOnly": false, "authMethod": "password" } }
// 失败 401（统一模糊文案，不泄漏账号是否存在）
{ "status": "error", "reason": "invalid_credentials" }
```

**登录流程（防止时序/枚举）：**

```
parse body → 查 user（按 login）→
  user 不存在 或 password_hash 为空 或 verify 失败 → 统一 invalid_credentials（+ audit 失败计数）
  成功 → 记录 last_login_at → 调 signSession("password"，user) 签发 token →
  写 user_sessions(token_hash) → audit("auth.login", username, { ok, ip, ua })
```

### 1.4 统一会话校验（`isAuthorized` / `sessionLogin` 改造）

把现状 [main.ts L500](file:///z:/Sakura项目分析/apps/api/src/main.ts#L500-L519) 的"比对 webuiToken + OAuth session"改为：

```
isAuthorized(request):
  token = extractBearerOrQuery(request)
  if (!token) → false 或 开放模式（webuiToken 为空时仍开放，兼容开发）
  parsedLogin = parseSessionToken(token)          // HMAC 签名解出 login（保留现 signer）
  sessionRow  = lookup user_sessions by token_hash → 校验 issuedAt≤now≤expiresAt 且 revokedAt 为空
  若签名有效 && 会话有效 → true
  否则 → false
```

> **兼容保留**：
> - `webui_api_token`（环境变量/DB 运行时设置）仍作为**紧急救援通道**：当且仅当签名会话体系无法登录时，可作为高权限临时入口（前端标记 deprecated，引导改密）。
> - 若 `webuiToken()` 为空（未配置 token 的开发/内网模式），`isAuthorized` 保持放行。

`sessionLogin(request)` 由"仅 OAuth"扩为：签名 token → 会话行 → 返回 `user.login`（password 与 github 统一）。

### 1.5 引导初始化

- **引导用户**：检测到 `users` 无任何 `password_hash` 非空且 `isAdmin=true` 的用户时，`POST /auth/register` 开放（限 1 次），创建首个 admin + 本地密码。
- 现有 `webui_api_token`（环境变量）在引导时可作为**种子 admin 的初始凭据来源**：将 `webui_api_token` 值映射到首个 admin 的 password（可选，用户决定）。
- 前端在 `GET /auth/me` 返回 `needsBootstrap=true` 时，进入"创建管理员"向导页（替代当前 token 输入）。

### 1.6 前端改动

| 文件 | 改动 |
|---|---|
| `apps/web/src/pages/Login.tsx` | 改为用户名+密码表单；保留"高级：token 直连"折叠项（deprecated） |
| `apps/web/src/lib/api.ts` | 新增 `login(username,password)`、`logout()`、`changePassword()`、`needsBootstrap()` |
| `apps/web/src/App.tsx` | `onAuthenticated` 回调用返回的 token；`needsBootstrap` 分支进向导 |
| `apps/web/src/lib/auth.ts` | token 语义升级为会话 token；存储方式依方向四决定 |

### 1.7 测试

- `apps/api`：`auth.login.test.ts`（成功/失败/锁定文案统一/防枚举）、`session` 落库与吊销、`register` 一次性
- 存量：确认 `isAdminRequest`/`isReadOnlyRequest`/`audit` 对 password 会话正确归类
- `apps/web`：登录表单、token 直连降级、401 登出回归

---

## 2. 方向二：令牌生命周期（access + refresh / 会话管控）

> **依赖方向一**（会话表已建）。在 `user_sessions` 之上加短期 access + 长期 refresh 双令牌与主动下线。

### 2.1 令牌模型

| 令牌 | 用途 | TTL | 存储 |
|---|---|---|---|
| access | 每次 API 鉴权，签名携带 `{login, role}` | 30min | cookie / 内存 |
| refresh | 换新 access，**单次使用轮换** | 7~30d | `user_sessions.token_hash` |

> 保留方向一引入的 signer；access 与 refresh 用不同 `purpose` 区分签名（防混淆）。

### 2.2 新增 API

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/auth/refresh` | 校验 refresh → 作废旧 refresh → 签新 access+refresh | refresh |
| DELETE | `/auth/sessions/:id` | 吊销指定会话（本人或 admin） | access |
| GET | `/auth/sessions` | 列出本人会话（设备/IP/最后活跃） | access |
| GET | `/auth/sessions/all` | admin：全部会话 | admin |

`refresh` 流程：

```
解析 refresh → 查 user_sessions(token_hash) → 校验有效未撤销 → 置旧行 revoked_at →
新建新会话行（轮换）→ 返回 { accessToken, refreshToken, user }
```

**并发控制**：`max_sessions_per_user`（配置，默认 10）超限时踢最旧未撤销会话。

### 2.3 会话管理 UI

- 前端新增「账号 → 会话管理」区：列出设备/IP/最后活跃，支持"下线"按钮。
- admin 视角列出全部用户会话，可强制下线。

### 2.4 安全细节

- refresh token 与 access 分开存（方向四 cookie 方案：不同 HttpOnly cookie；若用 localStorage 方案：access 内存、refresh 拆 HttpOnly cookie）。
- 每次 refresh 后旧 refresh 立即失效（防重放）。
- `audit` 记录 refresh/吊销含 IP + UA。

---

## 3. 方向三：登录安全加固

> 依赖方向一。含限流/锁定、2FA、登录审计。

### 3.1 登录限流 + 账号锁定

- 依赖现有 **Redis**（`apps/api` 已有 Redis 客户端）做滑动窗口计数。
- 键：`login:fail:{username}`、`login:fail:ip:{ip}`。
- 规则：
  - 同账号连续失败 ≥5 次（窗口 15min）→ 冷却 15min；
  - 同 IP 全局失败 ≥20 次/10min → 冷却到窗口结束。
- 返回仍为统一 `invalid_credentials`，不泄露冷却状态；前端根据 `retry_after_remaining` 可选禁用按钮。

### 3.2 TOTP 2FA（可选，P2）

- `users.totp_secret` / `totp_enabled`（方向一 schema 已留）。
- 流程：`POST /auth/login` 返回成功但携带 `needs2fa` → 前端收集 6 位码 → `POST /auth/2fa-verify`（用限时 challenge，未签发 access）→ 通过才完成登录建 session。
- 提供 `POST /auth/me/totp/setup` 生成 secret+二维码、`confirm` 绑定、`disable` 关闭；含备份码（10 个一次性）。
- 用标准 `otplib`/`speakeasy` 或纯 `node:crypto`（HMAC-SHA1 TOTP）。

### 3.3 登录审计

- 在方向一基础上覆盖：登录成功/失败、角色变更、token 吊销、2FA 开关、改密。
- 复用 `audit(request, action, target, { ip, ok })`（已带 ip，见 [main.ts L4130](file:///z:/Sakura项目分析/apps/api/src/main.ts#L4130-L4149)）。
- 对接方向五报表与方向三告警。

---

## 4. 方向四：token 存储方式

> 独立于方向一可先行，但依赖有 token 语义的改造。目标：解决 `localStorage` XSS 可读 + SSE 鉴权。

### 4.1 方案 A（推荐）：HttpOnly Cookie

- 本项目的 SSE（`/events`）依赖 `EventSource` 无法带 `Authorization` 头（现用 `?token=` 兜底）。**Cookie 方案天然解决**——浏览器自动携带，且全站同源用 `credentials:'include'`。
- 实施：
  - access token → HttpOnly cookie
    `__ap_access`：`Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`
  - refresh token → 独立 HttpOnly cookie `__ap_refresh`（方向二），Path 限定 `/auth`
  - `apps/web/src/lib/auth.ts` 不再用 `authHeaders()` 附加 bearer；请求内置 `credentials:'include'`
  - `eventsUrl()` 去掉 `?token=`，SSE 直接同源自动携带
- **CSRF**：`SameSite=Strict` + 仅 JSON 写接口 + 写请求带 `X-Requested-With: fetch`；仍保留 token 直连模式并存。
- **登录页**：`/auth/login` 返回后由 Set-Cookie 写入，前端仅拿 user 元信息（token 不进 JS）。

### 4.2 方案 B（降级，不动 cookie 架构）

- token 由 `localStorage` 改 `sessionStorage`（关标签页销毁）+ CSP `script-src 'self'` 收紧 + 敏感写接口二次确认。
- SSE 仍用 `?token=`（sessionStorage 可读），XSS 缓解有限，仅当 A 因部署限制实施不了时选用。

### 4.3 影响面

| 项 | A（cookie） | B（sessionStorage） |
|---|---|---|
| XSS 读取 | 防护强 | 弱 |
| SSE | 原生支持 | 需 `?token=` |
| 多标签会话 | 共享 | 各标签独立（参考现有 localStorage 会更一致） |
| CSRF 面 | 需 `SameSite`+校验 | 无新增 |
| 迁移成本 | 中（前端请求层改造） | 低 |

---

## 5. 方向五：审计报表 / 合规

> 复用现有 `audit` 表 + `GET /audit`。升级为可用的审计报表。

### 5.1 扩展审计动作类型

标准 action 枚举（已在用 + 新增）：
- `auth.login` / `auth.login_failed` / `auth.logout` / `auth.refresh` / `auth.session_revoke`
- `users.create` / `users.update_role`（已有）/ `users.change_password` / `users.delete`

### 5.2 查询/筛选/导出

- 扩展现有 `GET /audit?limit=&offset=`：
  - 参数：`actor`、`action`、`target`、`from`/`to`、`ip`
  - 响应含分页元信息
- 新增 `GET /audit/export`：CSV / JSON 流式导出（admin）。
- admin 审计页：筛选 + 分页 + 导出按钮。

### 5.3 异常登录告警

- 对接现有 `/metrics` + `/alerts`：
  - 指标：`auth.login.failures`（rate）、`auth.login.success`，带 `username`/`ip` 标签
  - 告警规则示例：同一 ip 15min 内失败 ≥20 次 → 告警事件
- 审计 + 指标共用现有 `observability`/`metrics` 基建。

---

## 6. 方向六：SSO / 统一身份扩展（暂缓）

> **暂缓**。已完成方案设计（见下），本轮不实现。

### 6.1 抽象 SSO provider

- 配置区新增 `sso`（`sso.enabled`、`sso.type`：`github` | `oidc`、`issuer`、`client_id`、`client_secret`、`scopes`）。
- 现有 GitHub 流程（`/auth/callback`、`createSessionSigner`）抽成 adapter：`OidcProvider`（github 作为特例，保留现有 clientId/secret 兼容）。

### 6.2 绑定与身份映射

- `user_external_identities` 表：`user_login` + `provider` + `sub`（外部主体 id），唯一 `(provider, sub)`。
- 首次 SSO 登录：无对应 `user` 时自动创建（默认 `isReadOnly=true`，admin 后续核准角色）或跳转绑定已登录本地账号。
- 多 provider 可并指同一本地用户。

### 6.3 前端

- 登录页保留「GitHub 登录」按钮（走现有 SSO adapater）；密码登录并列。
- 账号页显示"已连接的外部身份"，可解绑。

---

## 7. 方向七：仓库可见性授权（新增）

> **定位**：在方向一（统一账号 + 角色）之上，把「仓库级」的可见性与权限分配到用户，实现"不同用户只能看/管自己分配的仓库"。这是把当前全局的仓库管理能力（列仓库、仓库日志/结果、仓库级功能设置）细化为按仓库的 ACL。

### 7.1 目标与原则

- **仓库可见性**：每个用户可见一套"被授权"的仓库子集；不在授权内的仓库不出现、不可访问。
- **两级粒度**：
  - `view`：仅查看该仓库的 Issue/PR 审核结果、任务、日志、设置（只读）。
  - `manage`：可修改该仓库的分析设置、触发重分析、应用标签/规则等写操作（非全局 admin 也能管被授权的仓库）。
- **管理层约定**：
  - `isAdmin`（全局）用户：始终可见/可管**全部**仓库（兜底语义，不因授权缺失被限制）。
  - `isReadOnly`（全局只读）用户：保持全局只读；若被授予某仓库 `manage`，仍不许越界触碰其它仓库（仓库授权是同一模型的细化，二者叠加取更严）。
- **不做**（本轮）：不做仓库内的文件级 ACL、不改 GitHub App 权限本身。

### 7.2 Schema 变更（同方向一迁移批次，正式 migration）

```ts
// 新增：用户 - 仓库授权
repository_grants:
  user_login    text not null references users(login) onDelete cascade
  repository_id uuid not null references repositories(id) onDelete cascade
  access       text not null default 'view'      -- 'view' | 'manage'
  created_at    timestamp default now()
  primary key (user_login, repository_id)

// 索引：repository_grants (repository_id) —— admin 反查某仓库所有授权
```

> `access` 用 enum-able 文本保存（与现有 `category`/`severity` 等枚举风格一致），不做 DB-level enum，便于迁移。

### 7.3 授权管理 API（admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/grants?user=&repository=` | 列授权（可按用户/仓库筛选） |
| PUT | `/grants/:user/:repository` | 设/改授权（body：`{access:'view'\|'manage'}`） |
| DELETE | `/grants/:user/:repository` | 移除授权 |
| GET | `/repositories` | 现有接口改造：按当前用户过滤可见仓库（见 7.4） |

- 全部要求 `isAdminRequest`（全局管理员）才能管理授权表。
- 写授权 `audit(request, "grants.set", "<user>@<repo>", { access })`。
- **级联**：删除用户 → `onDelete cascade` 清授权；删除仓库 → 清授权。

### 7.4 运行时可见性与校验（核心）

新增两个 helper（放 `apps/api/src/main.ts`，复用现有 DB/`sessionLogin`）：

```ts
// 当前登录 user 的可读仓库 id 集合。admin → null 表示"全部"。
async function visibleRepositoryIds(req): Promise<Set<string> | null>

// 校验当前用户对某 repo 是否可访问 / 可管理。
// admin → 全放行；否则查 repository_grants。
async function canAccessRepo(req, repoId, need: 'view'|'manage'): Promise<boolean>
```

**拦截点（挂到现有 handler/路由）：**

| 接口 | 现状 | 改造 |
|---|---|---|
| `GET /repositories`（[main.ts L6067](file:///z:/Sakura项目分析/apps/api/src/main.ts#L6067)） | 列全部 | 非 admin 过滤为 `visibleRepositoryIds` 子集 |
| `/results` & `/results/:type/:number`（[main.ts L6125](file:///z:/Sakura项目分析/apps/api/src/main.ts)） | 列结果 | 结果行带 repositoryId，非 admin 仅返回授权仓库的结果 |
| `/tasks` | 列任务 | 非 admin 仅返回其授权仓库相关任务 |
| `GET/PUT /repositories/:id/settings`（[main.ts L6001](file:///z:/Sakura项目分析/apps/api/src/main.ts)） | 仓库级设置 | GET=需 `view`；PUT=需 `manage` |
| `/repo-rules` | 审核规则文件 | 需 `manage` 才可写；读按可见性 |
| `/scans`、`/vector`、`/backup`（仓库维度） | 全局 | 非 admin 仅放行授权仓库维度，或整体仍 admin-only（本轮按"仅 admin 可触发全量扫描"简化） |
| `/logs` | 日志 | 非 admin 过滤该仓库相关日志 |

> **实现要点**：这些 handler 大多按 `repositoryFullName` 或 `repositoryId` 过滤。抽取 `scopeRepoFilter(user)` 统一生成 SQL 条件，避免各 handler 各自拼权限逻辑。所有写操作仍保留方向一的 `isReadOnlyRequest` 顶格拦截（先查全局只读，再查仓库 manage）。

### 7.5 前端改动

| 文件 | 改动 |
|---|---|
| `apps/web/src/pages/RepositoriesPage.tsx`（或对应仓库列表页） | 仅展示可见仓库；对 manage 仓库显示「设置/触发重分析」按钮，view 仓库只读 |
| 仓库设置抽屉 / 页 | 无 `manage` 时按钮置灰并提示"仅可查看" |
| 结果页 / 任务页 | 列表自动被服务端过滤（前端无需改逻辑，仅空态文案提示"无权查看"） |
| 新增「授权管理」页（admin） | 用户 × 仓库矩阵，勾选 view/manage、移除授权 |

### 7.6 测试

- `apps/api`：`grants.test.ts`（设/改/删授权；admin 全放行；view 只读、manage 可写；非授权 404/403）
- 回归：`isAdminRequest` / `isReadOnlyRequest` 仍优先于仓库 ACL；admin 迁移后默认可见全部
- `apps/web`：授权管理页、仓库列表过滤、manage/view 按钮态

---

## 8. 落地顺序与依赖关系

| 优先级 | 方向 | 依赖 | 收益 | 备注 |
|---|---|---|---|---|
| **P0** | 方向一 原生账号+统一身份 | 现有 users/OAuth/audit | 消除"无账号体系"核心缺口 | 地基，先行 |
| **P0** | 方向四 A cookie 存储 | 方向一 | 顺带解决 SSE + XSS | 与方向一合并实施 |
| **P0** | 方向七 仓库可见性授权 | 方向一 | 按仓库隔离用户可见/可管 | 复用账号体系，热门需求 |
| **P1** | 方向二 生命周期+会话管控 | 方向一 | 会话可撤销/刷新 | 依赖会话表 |
| **P1** | 方向三 限流/锁定/登录审计 | 方向一、Redis | 防爆破 | |
| **P2** | 方向四 2FA | 方向一 | 增强安全 | schema 已预留 |
| **P2** | 方向五 审计报表 | 现有 audit | 合规/可追溯 | 可独立做 |
| **P2** | 方向六 通用 SSO | 方向一 | 扩展外部身份 | 本轮暂缓 |

**建议执行顺序**：方向一（+方向四 A 合并）→ **方向七（仓库授权）** → 方向二 → 方向三 → 方向五（方向六暂缓）。

---

## 9. 风险与兼容性

### 9.1 兼容性

- **旧 token 用户**：迁移后 `webui_api_token` 仍可作为紧急通道，前端标记 deprecated；引导建 admin 后可改密并弃用。
- **开发/内网开放模式**：`webuiToken()` 为空时保持 `isAuthorized` 放行，不破坏本地开发。
- **SSE**：方向四 A 用 cookie 后 `eventsUrl()` 不再需要 token，`?token=` 兼容保留一段时间。
- **方向七对现有单管理员的影响**：迁移前 admin 无授权记录 → `visibleRepositoryIds` 返回 `null`（全部可见），行为与现状一致，不因新增表而误伤；只有为非 admin 用户配置授权后才启用过滤。

### 9.2 已知变更点

- `isAuthorized` / `sessionLogin` / `isAdminRequest` / `isReadOnlyRequest` / `audit` actor 归类（[main.ts L500/L4023/L4108/L4130](file:///z:/Sakura项目分析/apps/api/src/main.ts#L4108-L4149)）。
- `protectedPaths` 增加 `/auth/sessions`、`/auth/refresh`、`/grants` 等。
- 新增 `user_sessions` / `user_external_identities` / `repository_grants` migration + 复用 `users` 表补列。
- 方向七需给 `handleResults`/`handleTasks`/`handleRepositories`/`handleRepositorySettings`/`handleRepoRules` 挂可见性/权限过滤（统一走 `scopeRepoFilter`）。

### 9.3 运维回滚

- 每个方向按 migration 拆分提交，可用既有「在线更新 + keep-list」流程回滚到上一版本（保持 `AP_VERIFY` / `OAUTH_REDIRECT_URI` 等 keep-list）。
- `user_sessions` / `repository_grants` 为纯新增表，删除即回退到旧鉴权，不破坏旧 token 直连与既有单管理员全可见行为。

---

*本文档为设计草案，待用户审核。确认方向后可按 P0 → P2 顺序逐一转为实现计划（含迁移/接口/前端/测试的具体改动文件清单）。*