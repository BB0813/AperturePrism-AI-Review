# astrbot_plugin_apertureprism

AperturePrism-AI-Review 的 AstrBot 桥接插件：在 QQ 里触发 **GitHub Issue 分析 / PR 审查** 并查询结果。

- 插件只做桥接：napcat（OneBot 11）与 QQ 官方开放平台的协议由 AstrBot 原生适配器处理。
- 所有能力都通过 AperturePrism HTTP API 提供（`/tasks/manual`、`/tasks/:id`、`/results/:type/:number`）。

## 安装

1. 将本目录（`astrbot_plugin_apertureprism`）放入 `AstrBot/data/plugins/`。
2. 在 AstrBot WebUI 重载/启用插件，填写配置。

> 需要先部署好 AperturePrism 平台（API 等），并让需要分析的仓库在平台「已安装仓库」中。

## 配置（_conf_schema.json）

| 字段 | 说明 |
| --- | --- |
| `api_base_url` | AperturePrism API 地址（不含末尾斜杠），如 `http://127.0.0.1:3300` |
| `api_token` | API Bearer 令牌（平台 `WEBUI_API_TOKEN`）；留空表示 API 未开启鉴权 |
| `default_repo` | 默认仓库 `owner/repo`，命令不带仓库时使用 |
| `whitelist` | 允许使用的 QQ 用户 ID 白名单；留空表示允许所有人 |
| `timeout` | HTTP 超时（秒），默认 30 |

## 命令

```
/ap analyze <编号> [owner/repo]   触发 Issue 分析
/ap review <编号> [owner/repo]    触发 PR 审查
/ap status <任务ID>               查询任务进度
/ap result <issue|pr> <编号>      查询最新分析结果
/ap help                          显示帮助
```

示例：

```
/ap analyze 12 BB0813/HelixOS
/ap review 34
/ap status 0193ab8e-…
/ap result issue 12
```

## 支持平台

- `aiocqhttp`：napcat / OneBot 11（NTQQ 第三方）
- `qq_official`：QQ 官方开放平台

## 与独立 QQ 机器人（apps/qq-bot）的关系

平台自带 `apps/qq-bot` 可以独立部署（直接连 OneBot 11 / Satori / Milky 或官方 api-v2）。
本插件面向「已经在用 AstrBot」的用户，两种形态可并存、不冲突；本插件把 QQ 交互做成 AstrBot
插件，省去单独部署 qq-bot 进程。
