# AperturePrism 运维手册（Runbook）

本手册覆盖 M11 生产加固的可操作部分：启动、迁移、备份/恢复、健康检查、常见故障与告警。

## 1. 组件与端口

| 组件 | 进程 | 说明 |
| --- | --- | --- |
| `api` | `node apps/api/dist/apps/api/src/main.js` | HTTP / webhook / SSE，端口 `API_PORT`（默认 3000） |
| `analysis-worker` | 同上（analysis-worker） | 领取并执行 Issue/PR 任务 |
| `index-worker` | 同上（index-worker） | 定时索引仓库 Issue（内容哈希去重） |
| `scheduler` | 同上（scheduler） | 每 10s 回收过期 lease、释放到期 retry |
| `postgres` | pgvector/pgvector:pg16 | 业务数据 + `issue_documents` 向量 |
| `redis` | redis:7-alpine | SSE 广播与任务事件分发 |

进程之间通过 `DATABASE_URL` / `REDIS_URL` 协作；AI 凭据由 worker 用 `CREDENTIAL_MASTER_KEY` 解密 `provider_accounts`。

## 2. 首次部署

```bash
# 1. 准备环境文件（密钥不入库）
cp .env.example .env.production
#    填好 DATABASE_URL / REDIS_URL / CREDENTIAL_MASTER_KEY / GITHUB_* / EMBEDDING_*

# 2. 应用迁移（先于应用启动）
DATABASE_URL=... node scripts/migrate.mjs

# 3. 启动
docker compose -f docker/docker-compose.prod.yml --env-file .env.production up -d

# 4. 健康检查
curl http://<host>:3000/health/live
curl http://<host>:3000/health/ready   # 200 才代表 DB+Redis 均就绪
```

## 3. 迁移发布流程

1. 新增 schema 变更后生成正式迁移：
   ```bash
   DATABASE_URL=... npx drizzle-kit generate --config packages/database/drizzle.config.ts
   ```
   （已提交的 `0007`、`0008` 为手工维护的增量 SQL，同样追加到 `migrations/meta/_journal.json`。）
2. 先在隔离测试库执行：`DATABASE_URL=<test> node scripts/migrate.mjs`。
3. 生产发布：停应用容器 → 执行 `node scripts/migrate.mjs` → 启动新镜像。
4. 迁移可重入（drizzle 记录已执行版本），失败后修复再跑即可。

## 4. 备份与恢复

```bash
# 备份（compose 方式，输出到 ./backups/<iso>.sql）
node scripts/backup.mjs

# 恢复（示例）
docker compose -f docker/docker-compose.prod.yml exec -T postgres \
  psql -U apertureprism -d apertureprism < backups/<iso>.sql
```

建议：每日备份 + 保留 N 份；`issue_documents` 可由 index-worker 重建，恢复后可选择重建而非依赖其备份。

## 5. 运维操作

- **手动触发索引**：`POST /index/run`（WebUI 向量页「开始索引」）。
- **重建索引**：`POST /index/rebuild`（清空 `issue_documents` 并触发全量重扫）。
- **查看索引健康**：`GET /index/status`（最近轮次 summary + 挂起触发）。
- **只读 RAG 召回**：`GET /index/related?title=...&body=...`。
- **运行时配置热更新**：`PUT /settings`（`webui_api_token` / `github_webhook_secret` / `github_webhook_enabled` / `log_level`，约 8s 生效）。

## 6. 告警清单

| 信号 | 建议动作 |
| --- | --- |
| `/health/ready` 非 200 | 检查 DB/Redis 容器健康与连接串 |
| index-worker 日志出现 `repo index failed` | 检查 GitHub installation token / 限流 |
| 任务持续 `retry_wait` 不恢复 | 确认 scheduler 存活（lease/retry 由它释放） |
| webhook 401 | 校验 `GITHUB_WEBHOOK_SECRET` 与签名 |
| worker `authentication_failed` | 校验 `CREDENTIAL_MASTER_KEY` 与 `provider_accounts` 密文 |
| SSE 无心跳 | 确认 redis 可达、`/events` 客户端仍在 |

## 7. 故障恢复

- **Worker 崩溃**：lease 在 `lease_duration_ms`（默认 60s）后过期，由 scheduler 回收回 `queued`，无需人工介入。
- **Redis 故障**：API 的 SSE 中继降级为只心跳，任务数据不丢失（PostgreSQL 为准）；恢复后自动重连。
- **GitHub 限流**：`github-adapter` 已对 `authentication_failed` 做一次性重试；429/5xx 由 worker 重试策略处理。
- **索引过旧**：分析评论中的相关 Issue 段落会因索引不可用自动跳过，主流程不阻塞。

## 8. 安全要点

- `CREDENTIAL_MASTER_KEY`、`GITHUB_APP_PRIVATE_KEY`、`EMBEDDING_API_KEY`、OAuth 凭据只放 `.env.production`，绝不入库/入日志。
- `provider_accounts.encrypted_credential` 为 AES-GCM 密文；轮换 = 更新该表 + 重启 worker。
- 私有仓库内容隔离在 `issue_documents.repository_id` 权限域内；`/index/related` 等只读接口需 WebUI token。
