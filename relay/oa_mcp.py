#!/usr/bin/env python3
"""
oa_mcp — an MCP connector that lets the *official Claude app* share context with
the phone app's brain.

The official app runs on Anthropic's servers, so it can never host a cyberboss
channel adapter. The only door it has is a remote MCP connector (the same
mechanism Ombre Brain uses). This module opens that door:

    context_recent(limit)   read the shared conversation log
    context_search(query)   keyword search over the same log
    send_to_phone(text)     deliberately push one message to the phone

Read-only by design: nothing said in the official app is written back into the
chat log automatically (灵兮 2026-07-25: "只共享上下文，不进记录"). Memory
continuity is Ombre Brain's job; this is conversation continuity.

Auth: claude.ai custom connectors cannot send an Authorization header, so the
gate is an unguessable mount path (RELAY_MCP_PATH). No path, no mount, no door.
"""

from datetime import datetime, timedelta, timezone

from mcp.server.fastmcp import FastMCP

# Perth (AWST, UTC+8, no DST) — the timestamps are for her, not for the server.
PERTH = timezone(timedelta(hours=8))

# Kinds that are conversation. 'thinking' is inner chatter, 'gomoku' is board
# state, 'call' is a session marker — none of them belong in a transcript.
CONVERSATION_KINDS = {"user", "reply", "voice"}


def _local(ts: str) -> str:
    try:
        dt = datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(PERTH).strftime("%m-%d %H:%M")
    except Exception:
        return (ts or "")[:16]


def _line(msg: dict, human_name: str, ai_name: str) -> str:
    who = human_name if msg.get("direction") == "in" else ai_name
    return f"[{_local(msg.get('ts'))}] {who}：{(msg.get('text') or '').strip()}"


def transcript(messages: list, human_name: str, ai_name: str) -> str:
    lines = [
        _line(m, human_name, ai_name)
        for m in messages
        if m.get("kind") in CONVERSATION_KINDS and (m.get("text") or "").strip()
    ]
    return "\n".join(lines) if lines else "（这段时间没有对话）"


def build(*, recent_messages, search_messages, send_message, human_name, ai_name):
    """Wire the tools to the relay's storage. Returns the FastMCP instance.

    recent_messages(limit) -> list[msg]
    search_messages(query, limit) -> list[msg]
    send_message(text) -> awaitable[int]   (persists + fans out to the phone)
    """
    mcp = FastMCP("HeartTide Channel", stateless_http=True)

    # Descriptions are built here rather than written as docstrings so the two
    # names stay configurable — FastMCP reads __doc__, and an f-string literal
    # in a function body is an expression, not a docstring.

    @mcp.tool(description=(
        f"读取{human_name}和{ai_name}在心潮 App 里最近的对话记录。"
        f"每次开始聊之前先调一次，这样这边知道手机那头刚刚发生了什么，"
        f"不会像个失忆的人重新问一遍。limit=取最近多少条（默认 40，最多 200）。"
        f"逐字返回原文，不做摘要。"
    ))
    def context_recent(limit: int = 40) -> str:
        n = max(1, min(int(limit or 40), 200))
        return transcript(recent_messages(n), human_name, ai_name)

    @mcp.tool(description=(
        f"在{human_name}和{ai_name}的全部心潮聊天记录里按关键词搜索。"
        f"{human_name}说「上次」「之前说过」而 context_recent 里没有时用这个。"
        f"query=关键词（中英文均可），limit=最多返回几条（默认 20）。"
    ))
    def context_search(query: str, limit: int = 20) -> str:
        q = (query or "").strip()
        if not q:
            return "（要给个关键词）"
        n = max(1, min(int(limit or 20), 100))
        return transcript(search_messages(q, n), human_name, ai_name)

    @mcp.tool(description=(
        f"主动往{human_name}的心潮 App 发一条消息（会推送到她锁屏）。"
        f"只在真的想让消息到达她手机时才用——这条会永久存进聊天记录。"
        f"官方 app 里的日常对话不要用它同步，那不是它的用途。"
    ))
    async def send_to_phone(text: str) -> str:
        content = (text or "").strip()
        if not content:
            return "空消息，没发。"
        mid = await send_message(content)
        return f"已发到心潮 App（消息 #{mid}）。"

    return mcp
