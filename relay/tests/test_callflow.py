"""callflow 单测。跑法：python3 relay/tests/test_callflow.py（不需要 pytest）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from callflow import split_sentences, ack_is_stale, build_ack_messages  # noqa: E402

PASS = 0


def check(name, condition):
    global PASS
    assert condition, f"FAIL: {name}"
    PASS += 1


# ── split_sentences ─────────────────────────────────────────────
check("空文本", split_sentences("") == [])
check("单句不切", split_sentences("今天想你了") == ["今天想你了"])
check("按句末标点切，结尾短问句并进前一段",
      split_sentences("我在阳台上站了一会儿。风很大，把栏杆吹得嗡嗡响。你那边呢？")
      == ["我在阳台上站了一会儿。", "风很大，把栏杆吹得嗡嗡响。你那边呢？"])
check("短句并进前一段",
      split_sentences("嗯。我刚才在想你说的那件事，越想越觉得有道理。")
      == ["嗯。我刚才在想你说的那件事，越想越觉得有道理。"])
tail = split_sentences("我刚才在想你说的那件事，越想越觉得有道理。嗯。")
check("结尾短句并回去", tail == ["我刚才在想你说的那件事，越想越觉得有道理。嗯。"])
check("换行也算边界",
      split_sentences("第一件事说完了\n第二件事是明天的复查记得空腹")
      == ["第一件事说完了", "第二件事是明天的复查记得空腹"])
check("英文句子",
      split_sentences("I miss you. Come home early tonight, okay?")
      == ["I miss you.", "Come home early tonight, okay?"])
check("逗号不切", len(split_sentences("先吃饭，再喝水，然后睡觉")) == 1)

# ── ack_is_stale ────────────────────────────────────────────────
HER = {"id": 100, "direction": "in", "kind": "voice", "meta": {"call": True}}
HIS_REAL = {"id": 101, "direction": "out", "kind": "voice", "meta": {"call": True, "voice": True}}
HIS_QUICK = {"id": 101, "direction": "out", "kind": "voice", "meta": {"call": True, "quick": True}}
HER_AGAIN = {"id": 102, "direction": "in", "kind": "voice", "meta": {"call": True}}
CHAT_MSG = {"id": 103, "direction": "out", "kind": "voice", "meta": {"voice": True}}  # 非通话

check("没有后续 → 不作废", ack_is_stale([HER], 100) is False)
check("正事已到 → 作废", ack_is_stale([HER, HIS_REAL], 100) is True)
check("只有别的搭腔 → 不作废", ack_is_stale([HER, HIS_QUICK], 100) is False)
check("她又说话了 → 作废", ack_is_stale([HER, HER_AGAIN], 100) is True)
check("非通话消息不算", ack_is_stale([HER, CHAT_MSG], 100) is False)
check("早于她那句的不算", ack_is_stale([{"id": 99, "direction": "out", "kind": "voice",
                                      "meta": {"call": True}}], 100) is False)

# ── build_ack_messages ──────────────────────────────────────────
msgs = build_ack_messages("卡片内容", [{"role": "her", "text": "喂？"},
                                      {"role": "him", "text": "在，听得见。"}], "你猜我今天看到谁了")
check("system 是人设卡", msgs[0]["role"] == "system" and msgs[0]["content"] == "卡片内容")
check("她的话在末尾", "你猜我今天看到谁了" in msgs[1]["content"])
check("历史带说话人", "她：喂？" in msgs[1]["content"] and "他：在，听得见。" in msgs[1]["content"])
empty = build_ack_messages("卡", [], "喂")
check("空历史有占位", "刚接起来" in empty[1]["content"])

print(f"OK — {PASS} checks passed")
