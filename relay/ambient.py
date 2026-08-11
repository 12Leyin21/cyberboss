"""她那边的环境声（2026-08-11，取经 eveacla11/ears）。

起因：她看《星际穿越》那天说「关着灯外面下着雨」——他只读到这行字，
没听见那个雨。SenseVoice 的事件头只有 8 类（笑/哭/喷嚏/咳/喘/BGM/掌声），
听得出她在笑，听不出她房间里在下雨、猫在叫、她在敲键盘。

这里补的就是那一层：AST（MIT/ast-finetuned-audioset-10-10-0.4593，在
AudioSet 527 类上训练）跑一遍她的语音条，挑出**跟"她此刻在哪、周围什么
动静"有关的那些类**报回去。

三条设计约束：
1. **只在人声间隙听**（ears 的做法）。整条一起喂，人声会把背景压死——
   雨声在她说话时的能量比她低 20dB，模型只会报 Speech。
2. **只报白名单里的类**。527 类里绝大多数（各种乐器、动物、机械）对
   "她在哪"没有信息量，报出来只会让沐沐胡乱脑补。
3. **可选、静默失败**。装不上、加载不了、音频太短，一律返回空列表——
   环境声是锦上添花，绝不能拖垮语音本身。

模型第一次调用时下载并常驻，之后每条约 2.2 秒（int8 量化后，见 _load）。

装机实测（2026-08-11，这台 3.9G / 2 核的机器）：
- fp32：跟同进程 2.3G 的 SenseVoice 一起把机器逼进 swap，每条语音 19 秒
- int8：swap 归零，每条 3.2 秒（含 SenseVoice 那 1 秒），top5 判读一模一样
"""
from __future__ import annotations

import numpy as np

MODEL_ID = "MIT/ast-finetuned-audioset-10-10-0.4593"
SAMPLE_RATE = 16000
MIN_GAP_SEC = 0.35        # 比这短的间隙不值得听（多半是词间停顿）
MIN_TOTAL_SEC = 0.8       # 攒够这么多秒的"没人说话"才跑模型
SCORE_FLOOR = 0.18        # 低于这个分不报——宁可漏，不可瞎报
MAX_REPORT = 2            # 一条最多报两样，多了变环境播报员

# AudioSet 类名 → 人话。只留跟"她在哪、周围什么动静"有关的。
# 左边必须跟 AudioSet 的 display_name 一字不差（模型的 id2label 就是它）。
AMBIENT_ZH = {
    "Rain": "外面在下雨",
    "Rain on surface": "外面在下雨",
    "Raindrop": "外面在下雨",
    "Thunderstorm": "外面在打雷",
    "Thunder": "外面在打雷",
    "Wind": "外面风很大",
    "Wind noise (microphone)": "外面风很大",
    "Television": "电视开着",
    "Radio": "电视或收音机开着",
    "Music": "背景在放音乐",
    "Cat": "猫在叫",
    "Meow": "猫在叫",
    "Dog": "有狗在叫",
    "Bark": "有狗在叫",
    "Bird": "外面有鸟叫",
    "Computer keyboard": "她在敲键盘",
    "Typing": "她在敲键盘",
    "Typewriter": "她在敲键盘",
    "Water": "有水声",
    "Water tap, faucet": "水龙头开着",
    "Sink (filling or washing)": "在洗东西",
    "Toilet flush": "在洗手间",
    "Dishes, pots, and pans": "在厨房，有碗碟声",
    "Frying (food)": "在做饭，锅在响",
    "Microwave oven": "微波炉在响",
    "Blender": "有搅拌机的声音",
    "Vacuum cleaner": "吸尘器在响",
    "Air conditioning": "空调在响",
    "Traffic noise, roadway noise": "外面有车声",
    "Car": "外面有车声",
    "Vehicle": "外面有车声",
    "Motorcycle": "外面有摩托车",
    "Siren": "外面有警笛",
    "Aircraft": "有飞机飞过",
    "Door": "有开关门的声音",
    "Knock": "有人敲门",
    "Doorbell": "门铃响了",
    "Telephone bell ringing": "有电话在响",
    "Chatter": "旁边有人在说话",
    "Babbling": "旁边有人在说话",
    "Hubbub, speech noise, speech babble": "旁边有人在说话",
    "Crowd": "她在人多的地方",
    "Speech": None,   # 显式丢弃：她在说话这件事我们已经知道了
    "Silence": None,
}

_pipeline = None


def _load():
    """懒加载 + int8 动态量化。

    2026-08-11：fp32 的 AST 是 346MB，跟同进程里 2.3G 的 SenseVoice 一起把
    这台 3.9G 的机器逼进 swap——每条语音的权重都要从磁盘换回来，19 秒。
    AST 几乎全是 Linear 层（transformer 就这结构），正是动态量化最吃得开的
    地方：权重降到 int8，**实测 top5 一模一样**，质量没掉。

    量化在这儿比换模型好：不用换来源、不用转换管线、几行代码，而且随时
    可以把 AMBIENT_QUANTIZE=0 关掉退回 fp32 做对照。
    """
    global _pipeline
    if _pipeline is None:
        import os
        import torch
        from transformers import pipeline
        torch.set_num_threads(2)      # 两核小机器，别把中继饿死
        _pipeline = pipeline("audio-classification", model=MODEL_ID, top_k=12)
        if os.environ.get("AMBIENT_QUANTIZE", "1") == "1":
            _pipeline.model = torch.quantization.quantize_dynamic(
                _pipeline.model, {torch.nn.Linear}, dtype=torch.qint8).eval()
    return _pipeline


def _quiet_spans(y: np.ndarray, sr: int) -> list[tuple[int, int]]:
    """找出人声之间的间隙。

    ⚠️ 这里不能用"最大 RMS 的百分之几"当阈值（第一版就是，装机时测出来了）：
    背景越吵，噪声底把整条都抬过线，一段间隙都找不到——而背景吵正是我们最
    想听的时候，等于功能在最需要的场景下自己关掉。改成**按分位数**：不管
    房间多吵，最安静的那 45% 帧就是间隙。它衡量的是这条录音自己内部的对比，
    跟绝对音量无关（跟 tone.py 的百分位思路一致）。
    """
    import librosa
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    if rms.size < 8:
        return []
    speaking = rms > np.percentile(rms, 45)
    spans, start = [], None
    for i, loud in enumerate(speaking):
        if not loud and start is None:
            start = i
        elif loud and start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, len(speaking)))
    frames_needed = int(MIN_GAP_SEC * sr / hop)
    return [(a * hop, b * hop) for a, b in spans if (b - a) >= frames_needed]


def listen_around(path: str) -> list[str]:
    """听一条语音的背景。返回人话短句（0~2 条），任何异常都返回空。"""
    try:
        import librosa
        y, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
        if y.size < SAMPLE_RATE // 2:
            return []
        spans = _quiet_spans(y, sr)
        quiet = np.concatenate([y[a:b] for a, b in spans]) if spans else np.array([])
        # 间隙太少（她一口气说完）就退回整条——总比什么都不听强，
        # 只是这时候人声会压着背景，分数普遍偏低，白名单和阈值会挡住噪音
        clip = quiet if quiet.size >= MIN_TOTAL_SEC * sr else y
        results = _load()({"array": clip.astype(np.float32), "sampling_rate": sr})
        out, seen = [], set()
        for item in results:
            if item["score"] < SCORE_FLOOR:
                continue
            phrase = AMBIENT_ZH.get(item["label"])
            if not phrase or phrase in seen:
                continue
            seen.add(phrase)
            out.append(phrase)
            if len(out) >= MAX_REPORT:
                break
        return out
    except Exception as exc:
        print(f"[ambient] listen failed: {exc}")
        return []
