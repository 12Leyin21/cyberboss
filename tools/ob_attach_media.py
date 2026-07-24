#!/usr/bin/env python3
"""
ob_attach_media.py —— 把本机图片/文件挂到 Ombre Brain 记忆桶上（2026-07-24）

为什么存在：MCP 工具调用里的 data_base64 要经过模型上下文，一张照片就是
几百万字符，烧额度且容易超限失败。本脚本直接走 HTTP 调 OB 的 MCP 接口，
base64 只在脚本内存里过一遍，模型只需要跑一行 Bash。

用法：
    python3 tools/ob_attach_media.py <bucket_id> <文件路径> [标题]

环境变量 OMBRE_URL 可覆盖默认记忆库地址。
限制：OB 单次请求上限 4MB，原始文件请控制在 3MB 以内（超了会明确报错，
不会半途而废）。
"""
import base64
import json
import mimetypes
import os
import sys
import urllib.request

OB_URL = os.environ.get("OMBRE_URL", "https://ombre-brain-cotj.onrender.com").rstrip("/")
MAX_RAW_BYTES = 3 * 1024 * 1024  # base64 后 ~4MB，贴着 OB 请求上限


def post(path: str, payload: dict, session_id: str = "") -> tuple[dict, str]:
    req = urllib.request.Request(
        OB_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **({"mcp-session-id": session_id} if session_id else {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        sid = resp.headers.get("mcp-session-id", session_id)
        body = resp.read().decode("utf-8")
    # streamable-http 可能回 SSE 格式（data: 行），也可能回纯 JSON
    for line in body.splitlines():
        if line.startswith("data:"):
            body = line[5:].strip()
            break
    return (json.loads(body) if body.strip() else {}), sid


def main() -> int:
    if len(sys.argv) < 3:
        print("用法: ob_attach_media.py <bucket_id> <文件路径> [标题]")
        return 2
    bucket_id, file_path = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else ""

    if not os.path.isfile(file_path):
        print(f"❌ 文件不存在: {file_path}")
        return 1
    size = os.path.getsize(file_path)
    if size > MAX_RAW_BYTES:
        print(f"❌ 文件 {size/1024/1024:.1f}MB 超过 3MB 上限——先压缩再来（OB 单次请求上限 4MB）")
        return 1

    with open(file_path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("ascii")
    mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    media_item = {
        "data_base64": encoded,
        "filename": os.path.basename(file_path),
        "type": mime,
    }
    if title:
        media_item["title"] = title

    # MCP streamable-http 三步握手 + 调用
    init, sid = post("/mcp", {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "ob-attach-media", "version": "1.0"}},
    })
    if "error" in init:
        print(f"❌ 连接记忆库失败: {init['error']}")
        return 1
    post("/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    result, _ = post("/mcp", {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "trace",
                   "arguments": {"bucket_id": bucket_id, "media_append": [media_item]}},
    }, sid)

    if "error" in result:
        print(f"❌ 记忆库拒绝: {result['error'].get('message', result['error'])}")
        return 1
    content = result.get("result", {}).get("content", [])
    text = content[0].get("text", "") if content else str(result.get("result", ""))
    print(f"✅ {text[:300]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
