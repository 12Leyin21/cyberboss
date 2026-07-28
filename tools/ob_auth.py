#!/usr/bin/env python3
"""
ob_auth.py —— 给命令行工具拿一张 Ombre Brain 的门票（2026-07-28）

为什么存在：2026-07-27 我们给 ombre-brain-cotj 打开了 OAuth 强制鉴权（删掉了
OMBRE_MCP_REQUIRE_AUTH=false），把裸奔的门关上了。副作用是 ob_attach_media.py
这类直接 POST /mcp 的脚本全部 401——灵兮和沐沐都存不了图。

不能改用静态 token 模式：oauth/token/off 三选一互斥，切 token 会同时断掉
官方 app 和桌面版 Claude Code（claude.ai 的连接器发不了自定义 header）。
所以正解是让脚本自己走一遍 OAuth，把令牌存在本地。

Ombre Brain 的 OAuth 是标准 2.1 公开客户端流程：
  动态注册 → PKCE(S256) → 浏览器输 Dashboard 密码 → 换 code → 拿 token
access token 30 天、refresh token 365 天且每次用都滚动续期，所以授权一次
基本不用再管。

密码只在浏览器里输，本脚本不碰、不存、不读。

用法：
    python3 tools/ob_auth.py login     # 首次授权（会打开浏览器）
    python3 tools/ob_auth.py status    # 看看令牌还有多久过期
    python3 tools/ob_auth.py token     # 打印一个当前可用的 access token

环境变量：
    OMBRE_URL         记忆库地址，默认 https://ombre-brain-cotj.onrender.com
    OMBRE_TOKEN_FILE  令牌存放位置，默认 ~/.ombre-brain/token.json
    OMBRE_AUTH_PORT   本地回调端口，默认 8765
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

OB_URL = os.environ.get("OMBRE_URL", "https://ombre-brain-cotj.onrender.com").rstrip("/")
TOKEN_FILE = os.path.expanduser(
    os.environ.get("OMBRE_TOKEN_FILE", "~/.ombre-brain/token.json")
)
CALLBACK_PORT = int(os.environ.get("OMBRE_AUTH_PORT", "8765"))
REDIRECT_URI = f"http://127.0.0.1:{CALLBACK_PORT}/callback"
RESOURCE = f"{OB_URL}/mcp"
# 提前这么久就主动续期，别等真过期了才发现
REFRESH_MARGIN = 3 * 24 * 3600


# ── 小工具 ──────────────────────────────────────────────────────────

def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post_json(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post_form(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _load() -> dict:
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    tmp = TOKEN_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)  # 令牌等同密码，别让同机别的进程随便读
    os.replace(tmp, TOKEN_FILE)


# ── 授权流程 ────────────────────────────────────────────────────────

class _CallbackHandler(BaseHTTPRequestHandler):
    """只接一次回调，把 code 塞进 server.result 就收工。"""

    def do_GET(self):  # noqa: N802  (BaseHTTPRequestHandler 的命名规矩)
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = dict(urllib.parse.parse_qsl(parsed.query))
        self.server.result = params  # type: ignore[attr-defined]
        ok = "code" in params
        body = (
            "<h2>✅ 授权成功</h2><p>可以关掉这个页面回终端了。</p>"
            if ok else
            f"<h2>❌ 授权失败</h2><pre>{params.get('error', '未知错误')}</pre>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # 别把 HTTP 日志喷到终端上
        pass


def login() -> int:
    print(f"记忆库：{OB_URL}")

    meta = _get_json(f"{OB_URL}/.well-known/oauth-authorization-server")
    authorize_url = meta["authorization_endpoint"]
    token_url = meta["token_endpoint"]
    register_url = meta["registration_endpoint"]

    reg = _post_json(register_url, {
        "client_name": "ob-cli (灵兮的命令行工具)",
        "redirect_uris": [REDIRECT_URI],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": "mcp",
    })
    client_id = reg["client_id"]
    print(f"✅ 已注册客户端 {client_id}")

    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = secrets.token_urlsafe(16)

    url = authorize_url + "?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "scope": "mcp",
        "resource": RESOURCE,
    })

    server = HTTPServer(("127.0.0.1", CALLBACK_PORT), _CallbackHandler)
    server.result = None  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print("\n下面这个网址会自动打开，在页面里输入 Dashboard 密码即可：")
    print(f"  {url}\n")
    print("（密码只在浏览器里输，这个脚本不碰也不存。）")
    try:
        webbrowser.open(url)
    except Exception:
        print("浏览器没能自动打开，手动复制上面的网址。")

    print("等待授权…（5 分钟超时，Ctrl+C 可中断）")
    deadline = time.time() + 300
    while server.result is None and time.time() < deadline:  # type: ignore[attr-defined]
        time.sleep(0.4)
    server.shutdown()

    params = server.result  # type: ignore[attr-defined]
    if not params:
        print("❌ 超时，没等到授权回调。")
        return 1
    if "code" not in params:
        print(f"❌ 授权被拒绝：{params.get('error', '未知错误')}")
        return 1
    if params.get("state") != state:
        print("❌ state 不匹配，中止（可能有人在中间捣鬼）。")
        return 1

    tok = _post_form(token_url, {
        "grant_type": "authorization_code",
        "code": params["code"],
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "code_verifier": verifier,
        "resource": RESOURCE,
    })

    _save({
        "ob_url": OB_URL,
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "token_url": token_url,
        "access_token": tok["access_token"],
        "refresh_token": tok.get("refresh_token", ""),
        "expires_at": int(time.time()) + int(tok.get("expires_in", 0)),
        "obtained_at": int(time.time()),
    })
    print(f"\n✅ 搞定，令牌存在 {TOKEN_FILE}")
    _print_status(_load())
    return 0


def _refresh(data: dict) -> dict:
    if not data.get("refresh_token"):
        raise RuntimeError("没有 refresh token，需要重新 login")
    tok = _post_form(data.get("token_url") or f"{OB_URL}/oauth/token", {
        "grant_type": "refresh_token",
        "refresh_token": data["refresh_token"],
        "client_id": data.get("client_id", ""),
        "resource": RESOURCE,
    })
    data["access_token"] = tok["access_token"]
    # 服务端会滚动更换 refresh token，没给新的就沿用旧的
    data["refresh_token"] = tok.get("refresh_token") or data["refresh_token"]
    data["expires_at"] = int(time.time()) + int(tok.get("expires_in", 0))
    _save(data)
    return data


def get_access_token() -> str:
    """给别的脚本 import 用：返回一个当前可用的 access token，快过期时自动续。"""
    data = _load()
    if not data.get("access_token"):
        raise RuntimeError(
            f"还没授权过。先跑一次：python3 {os.path.relpath(__file__)} login"
        )
    if data.get("expires_at", 0) - time.time() < REFRESH_MARGIN:
        try:
            data = _refresh(data)
        except Exception as exc:  # 续期失败就先拿旧的碰运气，真过期了调用方会看到 401
            print(f"⚠️ 令牌续期失败（{exc}），先用现有的试试", file=sys.stderr)
    return data["access_token"]


def _print_status(data: dict) -> None:
    if not data.get("access_token"):
        print("状态：❌ 尚未授权")
        return
    left = data.get("expires_at", 0) - time.time()
    print(f"状态：✅ 已授权 {data.get('ob_url', OB_URL)}")
    print(f"  客户端 {data.get('client_id', '?')}")
    print(f"  access token 还有 {left / 86400:.1f} 天过期"
          f"（不足 {REFRESH_MARGIN // 86400} 天时自动续）")
    print(f"  refresh token {'有' if data.get('refresh_token') else '无'}"
          f"（有效期一年，每次用都会滚动续期）")


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if cmd == "login":
            return login()
        if cmd == "status":
            _print_status(_load())
            return 0
        if cmd == "token":
            print(get_access_token())
            return 0
    except urllib.error.HTTPError as exc:
        print(f"❌ HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:400]}")
        return 1
    except Exception as exc:
        print(f"❌ {exc}")
        return 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
