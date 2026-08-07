"""tone.py v2 纯逻辑单测（不需要 librosa）。跑法：python3 relay/tests/test_tone.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tone import percentile_rank, cue_for, describe, MIN_SAMPLES  # noqa: E402

PASS = 0


def check(name, condition):
    global PASS
    assert condition, f"FAIL: {name}"
    PASS += 1


# ── percentile_rank ─────────────────────────────────────────────
check("中位数在50", abs(percentile_rank([1, 2, 3, 4, 5], 3) - 50) < 11)
check("最小值在低端", percentile_rank(list(range(100)), 0) < 1)
check("最大值在高端", percentile_rank(list(range(100)), 99) > 99)
check("空样本回中位", percentile_rank([], 42) == 50.0)

# ── cue_for ─────────────────────────────────────────────────────
check("正常段不说话", cue_for("energy", 50) is None)
check("12分位开口", cue_for("energy", 11) == "声音比平时轻")
check("4分位加重", cue_for("energy", 3) == "轻得多，像贴着话筒说的")
check("88分位开口", cue_for("energy", 89) == "比平时响")
check("没配加重句就用普通句", cue_for("tail", 2) == "说到后面声音散了")
check("单侧特征另一端沉默", cue_for("voiced_ratio", 97) is None)

# ── describe ────────────────────────────────────────────────────
normal = {k: 1.0 for k in ("energy", "rate", "pitch", "tail", "range", "voiced_ratio")}
history = {k: [0.5 + i / 100 for i in range(MIN_SAMPLES + 20)] for k in normal}
# 1.0 恰好落在这个 0.5~0.94 分布的高端 → 会说话；先验证攒不够样本时闭嘴
check("样本不够先闭嘴", describe(normal, {k: [1.0] * (MIN_SAMPLES - 1) for k in normal}) is None)
mid_history = {k: [0.8 + (i % 40) / 100 for i in range(60)] for k in normal}
check("一切如常不说话", describe({k: 1.0 for k in normal}, mid_history) is None)
loud = dict(normal, energy=99.0, rate=99.0, pitch=99.0)
note = describe(loud, mid_history)
check("最多两条", note is not None and note.count("，") <= 1)
check("能量优先", note.startswith("嗓门") or note.startswith("比平时响"))

print(f"OK — {PASS} checks passed")
