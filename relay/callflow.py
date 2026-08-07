"""实时通话 v2 的纯逻辑（2026-08-07）。

不碰数据库、不发网络请求——只有可以单测的函数。
app.py 负责把这些函数接到 FastAPI 和 sqlite 上。
"""
from __future__ import annotations

import re

# 句子边界：中英文句末标点 + 换行 + 省略号。逗号顿号不切——
# 电话里半句半句往外蹦比整句慢半拍更难受。
_SENT_RE = re.compile(r"[^。！？!?…\n]+[。！？!?…]*")


def split_sentences(text: str, min_chars: int = 6) -> list[str]:
    """把一段回复切成适合逐句合成的段。

    - 按句末标点/换行切
    - 太短的句子（"嗯。""好。"）并进前一段，免得一句话拆成三条语音
    - 空文本 → 空列表
    """
    # 英文句号只在后面跟空白（或收尾）时算句末——"3.5" 这种小数点不切
    text = re.sub(r"\.(\s+|$)", ".\n", text or "")
    parts: list[str] = []
    for line in text.split("\n"):
        parts.extend(p.strip() for p in _SENT_RE.findall(line) if p.strip())
    merged: list[str] = []
    for part in parts:
        if merged and len(merged[-1]) < min_chars:
            merged[-1] += part
        else:
            merged.append(part)
    if len(merged) >= 2 and len(merged[-1]) < min_chars:
        tail = merged.pop()
        merged[-1] += tail
    return merged


def ack_is_stale(rows: list[dict], her_msg_id: int) -> bool:
    """搭腔撞车门控：她那句话（her_msg_id）之后，通话里又发生了事吗？

    rows: [{"id", "direction", "kind", "meta"(dict)}]，只看 meta.call 的。
    - 沐沐的正式通话语音已落库（非 quick）→ 搭腔作废，正事优先
    - 她又说了一句 → 这条搭腔答的是上一句，作废
    """
    for row in rows:
        if int(row.get("id") or 0) <= her_msg_id:
            continue
        meta = row.get("meta") or {}
        if not meta.get("call"):
            continue
        if row.get("direction") == "out" and row.get("kind") == "voice" \
                and not meta.get("quick"):
            return True
        if row.get("direction") == "in" and row.get("kind") == "voice":
            return True
    return False


def build_ack_messages(persona_card: str, history: list[dict], transcript: str) -> list[dict]:
    """拼快脑的对话输入。history: [{"role": "her"|"him", "text": str}] 按时间序。"""
    lines = []
    for turn in history[-12:]:
        who = "她" if turn.get("role") == "her" else "他"
        lines.append(f"{who}：{turn.get('text', '')}")
    context = "\n".join(lines) if lines else "（这通电话刚接起来）"
    user = (
        f"通话进行中，最近的往来：\n{context}\n\n"
        f"她刚说：{transcript}\n\n"
        "给出他此刻脱口而出的那一声搭腔。只输出这句话本身。"
    )
    return [
        {"role": "system", "content": persona_card},
        {"role": "user", "content": user},
    ]
