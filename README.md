# AperturePrism-AI-Review

独立开发的 GitHub Issue 分析与 Pull Request 审查平台。

- 总体设计：`docs/APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md`
- 模块化开发计划：`docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md`

> 参考项目 Sakura-AI 仅用作本地只读参考资料（`archive/`），不随仓库提交。

## 当前阶段

M0–M5 已完成：工程基线、GitHub Webhook 接入、持久任务引擎、多模型路由、Issue 分析（上下文预算、版本化提示词、受限修复、幂等评论发布）。下一步为 M6 重复检测、M7 PR Review、M8 WebUI + SSE。

## 本地命令

```bash
npm install
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run build
```

Telegram Bot 不属于本项目范围。QQ 官方机器人安排在后续阶段，通过独立渠道适配器接入。