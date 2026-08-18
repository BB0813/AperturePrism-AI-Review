# AperturePrism-AI-Review

独立开发的 GitHub Issue 分析与 Pull Request 审查平台。

- 总体设计：`docs/APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md`
- 模块化开发计划：`docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md`

> 参考项目 Sakura-AI 仅用作本地只读参考资料（`archive/`），不随仓库提交。

## 开发阶段

| 阶段 | 主要内容 | 状态 |
| --- | --- | --- |
| M0 | Monorepo 与工程基线 | ✅ 已完成 |
| M1 | 数据库、配置与可观测性 | ✅ 已完成 |
| M2 | GitHub App 与事件入口（Webhook） | ✅ 已完成 |
| M3 | 持久任务引擎（状态机/租约/幂等），NAS 实测通过 | ✅ 已完成 |
| M4 | 多模型路由器（统一 deadline/故障转移），NAS 实测通过 | ✅ 已完成 |
| M5 | Issue 分析 MVP（上下文预算/提示词/受限修复/幂等评论发布），NAS 实测通过 | ✅ 已完成 |
| M10 | QQ 机器人（支持 NTQQ 第三方 Bot 协议：OneBot 11 / Satori / Milky） | 🚧 开发中 |
| M6 | 重复 Issue 检测 | ⏳ 待开发 |
| M7 | PR Review MVP | ⏳ 待开发 |
| M8 | WebUI 与增量事件 | ⏳ 待开发 |
| M9 | 索引与 RAG | ⏳ 待开发 |
| M11 | 生产加固与发布 | ⏳ 待开发 |

> 阶段编号沿用模块化开发计划；实际实现顺序以仓库为准。

## 本地命令

```bash
npm install
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run build
```

## 说明

- Telegram Bot 不属于本项目范围。
- QQ 机器人通过独立渠道适配器接入，支持对接 NTQQ 的第三方 Bot 协议：OneBot 11、Satori、Milky。
  - OneBot 11：<https://github.com/botuniverse/onebot-11>
  - Satori：<https://satori.chat/zh-CN/protocol/>
  - Milky：<https://milky.ntqqrev.org/>