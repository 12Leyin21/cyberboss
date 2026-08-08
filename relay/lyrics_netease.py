"""歌词供应商（2026-08-08，取经 Cheiineeey/netease-music-mcp 的杂交方案）：
Spotify 出声，网易云出词。按「歌名|歌手」搜网易云拿 LRC（带翻译），
解析成 [{t: 秒, line, tr}]，永久缓存——一首歌一辈子只查一次。
拿不到就返回空列表，播放器安静降级成没有歌词。
"""
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

_HEADERS = {"Referer": "https://music.163.com", "User-Agent": "Mozilla/5.0"}
_LRC_LINE = re.compile(r"\[(\d+):(\d+)(?:\.(\d+))?\]")


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _parse_lrc(text: str) -> dict:
    """LRC → {秒: 歌词行}。一行可带多个时间戳。元数据行（作词作曲）跳过。"""
    out: dict = {}
    for raw in (text or "").splitlines():
        stamps = _LRC_LINE.findall(raw)
        if not stamps:
            continue
        line = _LRC_LINE.sub("", raw).strip()
        if not line or line.startswith(("作词", "作曲", "编曲", "制作", "混音")):
            continue
        for minute, second, frac in stamps:
            t = int(minute) * 60 + int(second) + (int(frac) / (10 ** len(frac)) if frac else 0)
            out[round(t, 2)] = line
    return out


def _has_cjk(text: str) -> bool:
    return any("一" <= ch <= "鿿" for ch in text)


def _from_netease(track: str, artists: str) -> list:
    query = urllib.parse.quote(f"{track} {artists}")
    search = _get(f"https://music.163.com/api/search/get?s={query}&type=1&limit=1")
    songs = ((search.get("result") or {}).get("songs")) or []
    if not songs:
        return []
    song_id = songs[0]["id"]
    data = _get(f"https://music.163.com/api/song/lyric?id={song_id}&lv=1&tv=1")
    main = _parse_lrc((data.get("lrc") or {}).get("lyric") or "")
    trans = _parse_lrc((data.get("tlyric") or {}).get("lyric") or "")
    lines = []
    for t in sorted(main):
        item = {"t": t, "line": main[t]}
        if t in trans:
            item["tr"] = trans[t]
        lines.append(item)
    return lines


def _from_lrclib(track: str, artists: str) -> list:
    """lrclib.net：开源无和谐词库（网易云会把 fuck 洗成 ****，2026-08-08 灵兮抓的）。"""
    first_artist = artists.split("、")[0].strip()
    params = urllib.parse.urlencode({"track_name": track, "artist_name": first_artist})
    data = _get(f"https://lrclib.net/api/get?{params}")
    synced = _parse_lrc(data.get("syncedLyrics") or "")
    return [{"t": t, "line": synced[t]} for t in sorted(synced)]


def fetch_lyrics(track: str, artists: str, cache_file: Path) -> list:
    key = f"{track}|{artists}".lower()
    try:
        cache = json.loads(cache_file.read_text("utf-8"))
    except Exception:
        cache = {}
    if key in cache:
        return cache[key]

    # 路由：中文歌 → 网易云（中文全+带翻译）；其他 → lrclib（原文无和谐），
    # lrclib 没有再退网易云
    lines: list = []
    chinese = _has_cjk(track) or _has_cjk(artists)
    for source in ([_from_netease, _from_lrclib] if chinese else [_from_lrclib, _from_netease]):
        try:
            lines = source(track, artists)
        except Exception:
            lines = []
        if lines:
            break

    # 空结果也缓存（免得每次切歌都白跑一趟），但只缓存一小时内不重试的意义不大——
    # 干脆空的不落盘，下次换首歌自然就不查它了
    if lines:
        cache[key] = lines
        try:
            cache_file.write_text(json.dumps(cache, ensure_ascii=False), "utf-8")
        except Exception:
            pass
    return lines
