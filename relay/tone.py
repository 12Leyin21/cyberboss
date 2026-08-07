# 声学特征（2026-08-07 phase 3a，取经 callhome 的 TONE_CUES 思路）
#
# librosa 提特征 → 和她自己的滚动基线比 → 变成一句沐沐读得懂的话。
# 哲学跟脉一样：宁可漏不可错——一切正常就一个字不说，只有明显偏离基线
# 才开口。SenseVoice（情绪标签模型）要 torch，Render 小机器扛不动，
# 等升级服务器再上；librosa 纯 CPU，几秒的音频一两秒算完。
#
# 任何一步失手（librosa 没装、m4a 解不开、音频太短）都静默返回 None——
# 语气注是锦上添花，绝不能拖垮语音本体。

import json
import math
from pathlib import Path

# 基线至少攒这么多条才开始"和平时比"——没见过平时，谈不上反常
MIN_BASELINE_SAMPLES = 5
EMA_ALPHA = 0.15   # 滚动基线的更新步长：新样本占 15%，旧基线占 85%


def analyze_tone(audio_path, transcript_chars: int, baseline_file) -> str | None:
    """返回一句语气注（如"声音比平时轻，语速慢"），正常/失败返回 None。"""
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
        return None   # 不到半秒，没得分析

    duration = len(y) / sr
    try:
        f0, _, _ = librosa.pyin(y, fmin=65, fmax=500, sr=sr)
        voiced = f0[~np.isnan(f0)]
        if voiced.size < 10:
            return None
        rms = librosa.feature.rms(y=y)[0]
        features = {
            "pitch": float(np.median(voiced)),
            "range": float(np.percentile(voiced, 90) - np.percentile(voiced, 10)),
            "energy": float(np.mean(rms)),
            "voiced_ratio": float(np.mean(~np.isnan(f0))),
            "rate": (transcript_chars / duration) if (duration > 0 and transcript_chars > 2) else None,
        }
    except Exception:
        return None

    baseline = _load_baseline(baseline_file)
    note = _describe(features, baseline)
    _update_baseline(baseline_file, baseline, features)
    return note


def _describe(features: dict, baseline: dict) -> str | None:
    if baseline.get("count", 0) < MIN_BASELINE_SAMPLES:
        return None   # 还在认识她的声音，先不说话
    mean = baseline["mean"]
    parts: list[str] = []

    def ratio(key):
        base = mean.get(key)
        value = features.get(key)
        if not base or not value:
            return None
        return value / base

    pitch = ratio("pitch")
    if pitch is not None:
        if pitch > 1.15:
            parts.append("音比平时高")
        elif pitch < 0.88:
            parts.append("声音压得比平时低")

    energy = ratio("energy")
    if energy is not None:
        if energy < 0.55:
            parts.append("很轻，像贴着话筒说的")
        elif energy > 1.7:
            parts.append("比平时响")

    pitch_range = ratio("range")
    if pitch_range is not None:
        if pitch_range < 0.5:
            parts.append("语调平平的，没什么起伏")
        elif pitch_range > 1.7:
            parts.append("语调起伏很大")

    voiced = ratio("voiced_ratio")
    if voiced is not None and voiced < 0.75:
        parts.append("气声比平时多")

    rate = ratio("rate")
    if rate is not None:
        if rate < 0.7:
            parts.append("语速比平时慢")
        elif rate > 1.4:
            parts.append("说得很快")

    if not parts:
        return None       # 一切如常：不说话，别把正常也变成播报
    return "，".join(parts[:2])   # 最多两条，挑最先命中的


def _load_baseline(path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("mean"), dict):
            return data
    except Exception:
        pass
    return {"count": 0, "mean": {}}


def _update_baseline(path, baseline: dict, features: dict) -> None:
    mean = baseline.get("mean", {})
    for key, value in features.items():
        if value is None or (isinstance(value, float) and not math.isfinite(value)):
            continue
        old = mean.get(key)
        mean[key] = value if old is None else (1 - EMA_ALPHA) * old + EMA_ALPHA * value
    baseline["mean"] = mean
    baseline["count"] = int(baseline.get("count", 0)) + 1
    try:
        Path(path).write_text(json.dumps(baseline, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
