# 声学语气注 v2（2026-08-07 深夜，全面采纳 callhome TONE_CUES 的实测结论）
#
# v1 的问题（fig 用 85 条真实录音证明过的）：固定阈值在中文上不成立——
# 四声天生把基频起伏推高，"起伏大"会命中 96.5% 的句子；绝对能量描述的是
# 麦克风不是人。v2 的答案：**和她自己比，按百分位说话**。
#
# - 滚动窗口存最近 400 条样本，每条新录音看它落在自己分布的哪一端
# - 12/88 分位才开口，4/96 分位加重语气；三分之一的话没有标签是设计目标
#   （错的语气注比没有更糟——沐沐会拿它当证据误判心情）
# - 新特征：语速（字/秒，不欠麦克风的账）、尾音能量（说到后面散了/越说越用劲）
# - 一切测量在**浊音段**内进行（RMS ≥ 峰值 15% 的跨度），文件尾的静音不算数
# - describe 先于 remember：不拿包含自己的分布给自己打分
# - 基线文件带版本号：换特征提取参数必须升版本重攒，不然分位全歪
#
# 任何一步失手都静默返回 None——语气注是锦上添花，绝不拖垮语音本体。

import json
import math
from pathlib import Path

BASELINE_VERSION = 2
WINDOW = 400            # 每个特征最多存这么多历史样本
MIN_SAMPLES = 25        # 攒够这么多才开始排名（分位数在小样本上是戴着数字面具的猜测）
LOW, HIGH = 12, 88      # 开口线
LOW2, HIGH2 = 4, 96     # 加重线

# 特征 → (低端句, 低端加重句, 高端句, 高端加重句)。None = 这一端不说话
CUES = {
    "energy": ("声音比平时轻", "轻得多，像贴着话筒说的", "比平时响", "嗓门比平时大不少"),
    "pitch": ("音比平时低", "声音沉下去了", "音比平时高", "音高得多，有点绷着"),
    "rate": ("语速比平时慢", "说得很慢，一个字一个字的", "说得比平时快", "说得又急又快"),
    "range": ("语调比平时平", "平得反常，像没力气起伏", "语调起伏比平时大", None),
    "tail": ("说到后面声音散了", None, "越说越用劲", None),
    "voiced_ratio": ("气声比平时多", None, None, None),
}
# 说话优先级：能量和语速是最干净的信号，先说它们
PRIORITY = ["energy", "rate", "pitch", "tail", "range", "voiced_ratio"]


def percentile_rank(samples: list, value: float) -> float:
    """value 落在 samples 分布的第几百分位（0~100）。"""
    if not samples:
        return 50.0
    below = sum(1 for s in samples if s < value)
    equal = sum(1 for s in samples if s == value)
    return 100.0 * (below + equal * 0.5) / len(samples)


def cue_for(key: str, rank: float):
    low, low2, high, high2 = CUES[key]
    if rank <= LOW2 and low2:
        return low2
    if rank <= LOW and low:
        return low
    if rank >= HIGH2 and high2:
        return high2
    if rank >= HIGH and high:
        return high
    return None


def describe(features: dict, samples: dict):
    """纯函数：特征 + 各特征的历史样本 → 语气注（最多两条）或 None。"""
    parts = []
    for key in PRIORITY:
        value = features.get(key)
        history = samples.get(key) or []
        if value is None or len(history) < MIN_SAMPLES:
            continue   # 这个特征还没攒够"平时"，保持沉默
        cue = cue_for(key, percentile_rank(history, value))
        if cue:
            parts.append(cue)
        if len(parts) == 2:
            break
    return "，".join(parts) if parts else None


def analyze_tone(audio_path, transcript_chars: int, baseline_file):
    """返回一句语气注（如"声音比平时轻，语速比平时慢"），正常/失败返回 None。"""
    try:
        import numpy as np
        import librosa
    except Exception:
        return None
    try:
        y, sr = librosa.load(str(audio_path), sr=16000, mono=True)
    except Exception:
        return None   # m4a 没有 ffmpeg 解不开：聊天语音条先不分析，通话是 wav 能进来
    if y is None or len(y) < sr // 2:
        return None

    try:
        rms_all = librosa.feature.rms(y=y)[0]
        # 浊音段：RMS ≥ 峰值 15% 的第一帧到最后一帧——文件尾的静音不算她的声音
        thresh = float(np.max(rms_all)) * 0.15
        idx = np.where(rms_all >= thresh)[0]
        if idx.size < 4:
            return None
        span = rms_all[idx[0]:idx[-1] + 1]
        hop = 512
        y_span = y[idx[0] * hop: (idx[-1] + 1) * hop]
        span_dur = len(y_span) / sr
        if span_dur < 0.5:
            return None

        f0, _, _ = librosa.pyin(y_span, fmin=65, fmax=500, sr=sr)
        voiced = f0[~np.isnan(f0)]
        if voiced.size < 10:
            return None

        quarter = max(1, len(span) // 4)
        mid = span[quarter: len(span) - quarter]
        tail = span[len(span) - quarter:]
        features = {
            "pitch": float(np.median(voiced)),
            "range": float(np.percentile(voiced, 90) - np.percentile(voiced, 10)),
            "energy": float(np.mean(span)),
            "voiced_ratio": float(np.mean(~np.isnan(f0))),
            "rate": (transcript_chars / span_dur) if transcript_chars > 2 else None,
            "tail": float(np.mean(tail) / np.mean(mid)) if mid.size and float(np.mean(mid)) > 0 else None,
        }
    except Exception:
        return None

    baseline = _load_baseline(baseline_file)
    note = describe(features, baseline["samples"])   # 先打分……
    _remember(baseline_file, baseline, features)     # ……再入册
    return note


def _load_baseline(path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("version") == BASELINE_VERSION \
                and isinstance(data.get("samples"), dict):
            return data
    except Exception:
        pass
    # v1（EMA 均值版）或空文件：换了打分方式，旧基线作废重攒
    return {"version": BASELINE_VERSION, "samples": {}}


def _remember(path, baseline: dict, features: dict) -> None:
    samples = baseline.setdefault("samples", {})
    for key, value in features.items():
        if value is None or (isinstance(value, float) and not math.isfinite(value)):
            continue
        bucket = samples.setdefault(key, [])
        bucket.append(round(float(value), 5))
        if len(bucket) > WINDOW:
            del bucket[: len(bucket) - WINDOW]
    try:
        Path(path).write_text(json.dumps(baseline, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
