"""一起听（2026-08-08 甜点日）：Spotify 网关。

她授权一次之后：
- 中继每 20 秒看一眼她在放什么（只在有播放时），缓存在内存 + 广播给 App
- 沐沐随时 GET /spotify/now 知道她正在听什么（哪首、谁唱的、放到第几秒）
- 沐沐在回复里写 ⟪点歌:歌名 歌手⟫ → 搜索并排进她的播放队列——他真的能给她放歌

令牌存 /data/relay/spotify.json（refresh token 长期有效，续期自动做）。
任何一步失手都静默降级：一起听是甜点，绝不影响主餐。
"""
import json
import time
import urllib.parse
from pathlib import Path

import httpx

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing"


class SpotifyTogether:
    def __init__(self, client_id: str, client_secret: str, redirect_uri: str, store: Path):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.store = store
        self.now: dict = {}          # 最近一次的正在播放
        self.last_track_id = ""

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def linked(self) -> bool:
        return self._tokens().get("refresh_token") is not None

    def _tokens(self) -> dict:
        try:
            return json.loads(self.store.read_text("utf-8"))
        except Exception:
            return {}

    def _save_tokens(self, tokens: dict) -> None:
        self.store.write_text(json.dumps(tokens), "utf-8")
        try:
            self.store.chmod(0o600)
        except Exception:
            pass

    def auth_link(self) -> str:
        return AUTH_URL + "?" + urllib.parse.urlencode({
            "client_id": self.client_id,
            "response_type": "code",
            "redirect_uri": self.redirect_uri,
            "scope": SCOPES,
        })

    async def exchange_code(self, code: str) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(TOKEN_URL, data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            })
            resp.raise_for_status()
            data = resp.json()
        data["expires_at"] = time.time() + int(data.get("expires_in", 3600)) - 60
        self._save_tokens(data)

    async def _access_token(self) -> str:
        tokens = self._tokens()
        if not tokens.get("refresh_token"):
            raise RuntimeError("spotify not linked")
        if tokens.get("access_token") and time.time() < float(tokens.get("expires_at", 0)):
            return tokens["access_token"]
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(TOKEN_URL, data={
                "grant_type": "refresh_token",
                "refresh_token": tokens["refresh_token"],
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            })
            resp.raise_for_status()
            data = resp.json()
        tokens["access_token"] = data["access_token"]
        tokens["expires_at"] = time.time() + int(data.get("expires_in", 3600)) - 60
        if data.get("refresh_token"):
            tokens["refresh_token"] = data["refresh_token"]
        self._save_tokens(tokens)
        return tokens["access_token"]

    async def poll_now(self) -> dict:
        """拉一次正在播放。没在放/没授权 → {}。返回 track 变化时带 changed=True。"""
        token = await self._access_token()
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(API + "/me/player/currently-playing",
                                    headers={"Authorization": f"Bearer {token}"})
        if resp.status_code == 204 or not resp.content:
            self.now = {}
            return {}
        resp.raise_for_status()
        data = resp.json()
        item = data.get("item") or {}
        track_id = item.get("id") or ""
        now = {
            "track": item.get("name") or "",
            "artists": "、".join(a.get("name", "") for a in item.get("artists", [])),
            "album": (item.get("album") or {}).get("name") or "",
            "cover": next(iter([(item.get("album") or {}).get("images") or []]), [{}])[0].get("url", "")
                     if (item.get("album") or {}).get("images") else "",
            "playing": bool(data.get("is_playing")),
            "progress_s": int((data.get("progress_ms") or 0) / 1000),
            "duration_s": int((item.get("duration_ms") or 0) / 1000),
            "changed": bool(track_id and track_id != self.last_track_id),
        }
        if track_id:
            self.last_track_id = track_id
        self.now = now
        return now

    async def control(self, action: str) -> None:
        """遥控她的播放器：play / pause / next / previous。"""
        token = await self._access_token()
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=15) as client:
            if action in ("next", "previous"):
                resp = await client.post(API + f"/me/player/{action}", headers=headers)
            elif action == "pause":
                resp = await client.put(API + "/me/player/pause", headers=headers)
            elif action == "play":
                resp = await client.put(API + "/me/player/play", headers=headers)
            else:
                raise RuntimeError(f"unknown action {action}")
            if resp.status_code not in (200, 204):
                raise RuntimeError(f"{action} http {resp.status_code}")

    async def queue_song(self, query: str) -> str:
        """搜歌并排进她的播放队列。返回排进去的「歌名 - 歌手」，失败抛异常。"""
        token = await self._access_token()
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(API + "/search", headers=headers,
                                    params={"q": query, "type": "track", "limit": 1})
            resp.raise_for_status()
            items = (resp.json().get("tracks") or {}).get("items") or []
            if not items:
                raise RuntimeError(f"没搜到：{query}")
            track = items[0]
            resp = await client.post(API + "/me/player/queue", headers=headers,
                                     params={"uri": track["uri"]})
            if resp.status_code not in (200, 204):
                raise RuntimeError(f"排队失败 http {resp.status_code}（她的 Spotify 要在放歌才有队列）")
        artists = "、".join(a.get("name", "") for a in track.get("artists", []))
        return f"{track.get('name')} - {artists}"
