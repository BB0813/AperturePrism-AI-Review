# AperturePrism 全项目功能 Review

> 审查日期：2026-08-26 ｜ 基线版本：v1.0.44
> 范围：`apps/web`（前端）、`apps/api`（后端）、`apps/*-worker` + `apps/qq-bot`（worker）、`packages/*`（领域包）、`docker`（部署）、`docs`（文档）
> 结论：核心业务链路（Webhook → 任务引擎 → 模型路由 → Issue/PR 分析 → 发布 → SSE）完整可用；存在 **2 项高优先级**（告警无通知、凭据安全）、若干中/低优先级缺口与文档过时问题。

---

## 一、高优先级（建议尽快处理）

### 1. 告警只展示、无主动通知（webhook / 消息推送缺失）
- **位置**：`apps/api/src/alerts.ts`（文件头注释明言"未来可接 webhook 通知"）
- **现状**：三条告警规则（`queue_backlog` / `failed_tasks` / `stale_tasks`）评估后仅存内存 Map，只通过运维页 `GET /alerts` 展示。没有任何主动推送（无 webhook 回调、无 QQ/邮件通知）。
- **影响**：任务失败 / 队列积压 / worker 卡死时，若无人打开运维页，根本不会发现异常。告警的"告警"价值未兑现。
- **建议**：接入 webhook 通知（复用 `github_webhook_secret` 体系或独立 `alert_webhook_url` 配置），在告警从 resolved→active 时触发一次推送；可复用现有 `outbox_events` / 事件流机制。

### 2. WebUI 访问令牌弱口令风险（延续问题）
- **位置**：`packages/config/src/settings-registry.ts`（`webui_api_token`）、NAS `system_settings` 表
- **现状**：当前 WebUI token 为 `Binbim0813`（弱口令，与 GitHub 密码同源）。8-25 曾发生公网 IP 直连 3300 修改 `oauth_client_secret` 的事件；虽已把 API 端口收紧为仅 loopback（`docker-compose.prod.yml`），但 token 本身仍弱。
- **建议**：轮换 `webui_api_token` 为随机强口令；如非必要不启用 GitHub OAuth 登录；考虑为敏感写操作（settings / 管理员操作）增加二次确认或审计告警。

---

## 二、中优先级（完善体验 / 可靠性）

### 3. 告警阈值硬编码，不可配置
- **位置**：`apps/api/src/alerts.ts` L43 / L50 / L57
- **现状**：`queueDepth >= 20`、`failed >= 1`、`stale >= 1` 写死，无法在 WebUI 调整。
- **建议**：把阈值改为 runtime setting（`alert_queue_backlog_threshold` 等），由配置注册表统一管理。

### 4. 告警与指标均为进程内状态，重启清零
- **位置**：`apps/api/src/main.ts`（`alertRecords` Map）、`packages/observability/src/metrics.ts`
- **现状**：容器重启后告警历史与全部指标归零，无法追溯"何时开始异常 / 累计 5xx 总量"。
- **建议**：短期可接受（运维页已注明）；中期将告警落库（`alert_events` 表），指标如需长期留存可接入 Prometheus。

### 5. /metrics 无 Prometheus 文本格式
- **位置**：`packages/observability/src/metrics.ts`（注释提到"只需把 snapshot() 渲染成文本格式"）
- **现状**：`GET /metrics` 仅返回 JSON（供运维页），不可直接被 Prometheus scrape。
- **建议**：若计划接入 Grafana/告警，增加 `format: text` 的 Prometheus exposition 输出（`content-type: text/plain; version=0.0.4`）。

### 6. 运维页（OpsPage）无自动轮询
- **位置**：`apps/web/src/pages/OpsPage.tsx`（仅 `useEffect(() => load(), [load])`，无 `setInterval`）
- **现状**：页面挂载后只加载一次，需手动点「刷新」；与 Overview（15s）、TaskDetail（5s）、BotPage（15s）不一致。
- **建议**：加 15s 轮询（或与 SSE 事件联动），让运维页的实时量规与告警持续刷新。

### 7. 文档 / 界面声明与实现不一致（AboutPage 范围说明过时）
- **位置**：`apps/web/src/pages/AboutPage.tsx`（`NOT_IN_SCOPE` 数组）
- **现状**：声明"多用户账号体系（当前为 Bearer 单令牌访问）"、"Agent 专家团队 / Agent Skills"、"Sakura 记忆管理"不在范围 —— **实际均已实现**（`/users` 用户管理、`/account` 个人设置、`AgentPage` 技能/专家开关、`MemoryPage` + `repo_memory` 合并）。过时声明会误导用户。
- **建议**：从 NOT_IN_SCOPE 移除已上线能力，只保留真正未做的（如 Telegram 渠道）。

### 8. 在线更新文档端口与实现不一致
- **位置**：`docs/ONLINE_UPDATE_PLAN.md`（`--api http://127.0.0.1:3300` 示例）
- **现状**：文档示例仍用旧 3300 端口，当前生产 API 容器内为 30001；`scripts/update.sh` 实际已用 `API_URL="http://127.0.0.1:30001"`。
- **建议**：同步文档中的端口 / token 说明，避免按文档排错失败。

---

## 三、低优先级（锦上添花 / 已规划）

### 9. 任务队列交互增强（README 已列为计划中第三批）
- **位置**：`README.md` Todo「计划中」
- **现状**：已有批量重跑、批量撤回；缺批量删除、批量导出、结果/任务列表列自定义。
- **建议**：按计划推进，非阻塞。

### 10. 告警阈值 / 通知的 WebUI 配置入口
- 随 #3 / #1 一并落地，纳入「系统配置」或「运维」页。

---

## 四、已核实为完整 / 无需处理的功能（排除项）

避免误报，以下功能经代码核对确认完整：

| 功能 | 核实结果 |
| --- | --- |
| Webhook 接入 + 验签（双密钥宽限期） | ✅ `apps/api/src/main.ts` 完整，含 24h 旧密钥兜底 |
| 任务引擎（租约/重试/死信/心跳） | ✅ `packages/task-engine/src/index.ts` 完整；`resetTaskToQueued` 已修（v1.0.42） |
| 模型路由（候选/故障转移/重试/用量） | ✅ `packages/model-router/src/index.ts` |
| Issue / PR 分析 + 发布 + 幂等 | ✅ `packages/issue-analysis` / `packages/pr-review` |
| 重复检测（召回+裁决，仅建议不自动关） | ✅ `packages/duplicate-detection`（按设计不自动关闭） |
| 向量索引 / 触发 / 重建 | ✅ `apps/index-worker` + 向量页 |
| 仓库扫描（定时/手动/跟踪 Issue/历史） | ✅ `apps/scan-worker` + 扫描页 |
| 记忆合并（反思→规则/知识→回灌） | ✅ `apps/scheduler/consolidation.ts` + 记忆页 |
| Agent 技能 + 专家团队 | ✅ `packages/agent-capabilities` + Agent 页 |
| 用户管理 / 管理员 / 只读角色 | ✅ `/users` + `users.integration.test` |
| 审计日志 / 速率限制 / 安全管理页 | ✅ `/audit` + SecurityPage |
| 标签规则（免前缀表单 + worker 自动打标） | ✅ LabelsPage + `label-rules` |
| 在线更新（备份/迁移/回滚/阶段进度） | ✅ `scripts/update.sh` + UpdatePanel（含 SSE 流中断容错） |
| 配置备份/导入（脱敏） | ✅ `/backup` + `backup-redact` |
| 密码验证登录（令牌校验 + 401 自动登出） | ✅ v1.0.41 完成 |
| qq-bot 启动/关闭按钮 + 状态轮询 | ✅ v1.0.44 完成（已修复按钮位置） |
| 日志总览（历史 + SSE 实时 + 断点续传） | ✅ LogOverviewPage |
| 任务详情 Check Run 实时轮询 | ✅ TaskDetailPage 5s 轮询 |
| 告警规则评估 + 单测 + 运维页展示 | ✅ v1.0.41 完成（缺通知，见 #1） |

---

## 五、建议的处理顺序

1. **立即**：轮换 WebUI token（安全）
2. **下一迭代**：告警 webhook 通知 + 阈值可配置（#1 / #3）
3. **随后**：OpsPage 轮询 + AboutPage 范围声明修正（#6 / #7）
4. **按需**：Prometheus 文本输出、告警/指标落库（#4 / #5）
