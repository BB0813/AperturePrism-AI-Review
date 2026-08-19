"""AperturePrism (Aprism) AstrBot plugin.

Bridges QQ messages (napcat / OneBot 11 and QQ official open platform, both
handled natively by AstrBot platform adapters) to the AperturePrism-AI-Review
HTTP API: trigger GitHub Issue analysis / PR review, then query task status and
persisted results.

Commands (all start with /ap):

  /ap analyze <number> [owner/repo]   触发 Issue 分析
  /ap review <number> [owner/repo]    触发 PR 审查
  /ap status <taskId>                 查询任务进度
  /ap result <issue|pr> <number>      查询最新分析结果
  /ap help                            显示帮助
"""

import json
from typing import Any

import aiohttp
from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

SUPPORTED_TYPES = ("issue", "pr")

COMMAND_USAGE = (
    "AperturePrism 命令：\n"
    "/ap analyze <编号> [owner/repo]  触发 Issue 分析\n"
    "/ap review <编号> [owner/repo]   触发 PR 审查\n"
    "/ap status <任务ID>              查询任务进度\n"
    "/ap result <issue|pr> <编号>     查询最新结果\n"
    "/ap help                         显示帮助\n"
    "未指定仓库时使用设置里的 default_repo。"
)


def _command_arg(event: AstrMessageEvent) -> str:
    """The raw text after the `/ap` command, with a version-robust fallback."""
    try:
        arg = event.get_command_arg()
        if arg is not None:
            return str(arg).strip()
    except AttributeError:
        pass
    message = getattr(event, "message_str", "") or ""
    return " ".join(message.split()[1:])


def extract_summary(result: Any) -> str | None:
    """Best-effort human summary from the persisted analysis result JSON."""
    if result is None:
        return None
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, TypeError):
            return None
    if not isinstance(result, dict):
        return None
    summary = result.get("summary")
    if isinstance(summary, str) and summary.strip():
        parts = [summary.strip()]
        severity = result.get("severity")
        priority = result.get("priority")
        if isinstance(severity, str) and severity:
            parts.append(f"[{severity}]")
        if isinstance(priority, str) and priority:
            parts.append(f"[{priority}]")
        return " ".join(parts)
    text = json.dumps(result, ensure_ascii=False)
    return text[:200] + ("…" if len(text) > 200 else "")


class Plugin(Star):
    """AstrBot entry: bridges QQ chat to the AperturePrism HTTP API."""

    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self._session: aiohttp.ClientSession | None = None

    # ---- config helpers ----
    def _api_base(self) -> str:
        return str(self.config.get("api_base_url") or "").rstrip("/")

    def _api_token(self) -> str:
        return str(self.config.get("api_token") or "")

    def _default_repo(self) -> str:
        return str(self.config.get("default_repo") or "").strip()

    def _timeout(self) -> int:
        value = self.config.get("timeout", 30)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
        return 30

    def _whitelist(self) -> list[str]:
        raw = self.config.get("whitelist") or []
        return [str(item).strip() for item in raw if str(item).strip()]

    def _authorized(self, event: AstrMessageEvent) -> bool:
        whitelist = self._whitelist()
        if not whitelist:
            return True
        return str(event.get_sender_id()) in whitelist

    async def _client(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self._timeout())
            )
        return self._session

    async def _api_request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any] | None, str | None]:
        """Calls the AperturePrism API. Returns (data, error)."""
        base = self._api_base()
        if not base:
            return None, "未配置 api_base_url（插件设置里填 AperturePrism API 地址）。"
        headers = {"Content-Type": "application/json"}
        token = self._api_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        url = f"{base}{path}"
        try:
            client = await self._client()
            async with client.request(method, url, headers=headers, json=body) as resp:
                try:
                    data = await resp.json(content_type=None)
                except (ValueError, TypeError):
                    data = None
                if resp.status >= 400:
                    reason = (
                        (data or {}).get("reason") if isinstance(data, dict) else None
                    )
                    return None, f"API {resp.status}: {reason or '请求失败'}"
                if isinstance(data, dict):
                    return data, None
                return None, f"API 返回异常（{resp.status}）"
        except aiohttp.ClientError as exc:
            return None, f"无法连接 API：{exc.__class__.__name__} {exc}"
        except Exception as exc:  # pragma: no cover - defensive
            logger.error(f"api request failed: {exc}", exc_info=True)
            return None, f"请求出错：{exc}"

    # ---- command handlers ----
    @filter.command("ap")
    async def ap(self, event: AstrMessageEvent):
        """AperturePrism：触发 Issue/PR 审查与结果查询。"""
        if not self._authorized(event):
            yield event.plain_result("你没有使用权限（不在白名单中）。")
            return
        parts = _command_arg(event).split()
        if not parts:
            yield event.plain_result(COMMAND_USAGE)
            return
        command = parts[0].lower()
        args = parts[1:]
        if command in ("help", "-h", "--help"):
            yield event.plain_result(COMMAND_USAGE)
            return
        if command == "analyze":
            yield event.plain_result(await self._trigger("issue", args))
            return
        if command == "review":
            yield event.plain_result(await self._trigger("pr", args))
            return
        if command == "status":
            yield event.plain_result(await self._status(args))
            return
        if command == "result":
            yield event.plain_result(await self._result(args))
            return
        yield event.plain_result(f"未知子命令：{command}\n{COMMAND_USAGE}")

    async def _trigger(self, kind: str, args: list[str]) -> str:
        if not args or not args[0].isdigit():
            return f"用法：/ap {kind} <编号> [owner/repo]"
        number = int(args[0])
        repo = args[1] if len(args) > 1 else self._default_repo()
        if "/" not in repo:
            return "未指定仓库且未配置 default_repo（格式 owner/repo）。"
        data, err = await self._api_request(
            "POST",
            "/tasks/manual",
            {
                "type": kind,
                "repositoryFullName": repo,
                "subjectNumber": number,
            },
        )
        if err:
            return f"触发失败：{err}"
        if data.get("status") == "ok":
            return (
                f"已触发 {kind} 分析（{repo}#{number}）\n"
                f"任务 ID：{data.get('taskId')}\n"
                f"结果：{data.get('outcome')}\n"
                "用 /ap status <任务ID> 查询进度。"
            )
        return f"触发失败：{data}"

    async def _status(self, args: list[str]) -> str:
        if not args:
            return "用法：/ap status <任务ID>"
        data, err = await self._api_request("GET", f"/tasks/{args[0]}")
        if err:
            return f"查询失败：{err}"
        lines = [
            f"任务：{data.get('id')}",
            f"类型：{data.get('taskType')}",
            f"状态：{data.get('status')}",
        ]
        if data.get("createdAt"):
            lines.append(f"创建：{data.get('createdAt')}")
        if data.get("finishedAt"):
            lines.append(f"完成：{data.get('finishedAt')}")
        if data.get("errorCategory"):
            lines.append(f"错误：{data.get('errorCategory')}")
        return "\n".join(lines)

    async def _result(self, args: list[str]) -> str:
        if len(args) < 2:
            return "用法：/ap result <issue|pr> <编号>"
        kind = args[0].lower()
        if kind not in SUPPORTED_TYPES:
            return "类型须为 issue 或 pr。"
        if not args[1].isdigit():
            return "编号须为数字。"
        data, err = await self._api_request("GET", f"/results/{kind}/{int(args[1])}")
        if err:
            return f"查询失败：{err}"
        items = data.get("items") or []
        if not items:
            return f"暂无 {kind} #{args[1]} 的分析结果。"
        item = items[0]  # newest first
        lines = [
            f"{item.get('repositoryFullName')} {kind}#{item.get('subjectNumber')}",
            f"版本：{item.get('revision')}",
            f"已发布评论：{'是' if item.get('published') else '否'}",
            f"时间：{item.get('createdAt')}",
        ]
        summary = extract_summary(item.get("result"))
        if summary:
            lines.append(f"概要：{summary}")
        return "\n".join(lines)

    async def terminate(self):
        """Close the aiohttp session on unload/disable."""
        if self._session is not None and not self._session.closed:
            await self._session.close()
            self._session = None
