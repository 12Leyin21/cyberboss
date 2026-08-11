"""SenseVoice 情绪耳朵（2026-08-07 搬进悉尼大房子后上线）。

独立小服务：加载 SenseVoiceSmall（常驻 ~1.5GB），只监听本机 8100 口。
中继转写完她的语音后把 wav 路径递过来，这里回情绪/声音事件标签。
崩了不拖累中继——systemd 会扶它起来，扶不起来中继照常跑（语气注静默缺席）。

跑法：uvicorn emotion_service:app --host 127.0.0.1 --port 8100
"""
import os
import re

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
_model = None

# 环境声那一层默认关着（2026-08-11 装机实测后的决定）。
# AST 本身没问题——单独跑热推理 2.4 秒。但这台机器只有 3.9G 内存 / 2 核，
# SenseVoice 一个人就占 2.3G；再塞 350M 的 AST 进来，两边互相把对方挤进
# swap，每次调用都要把权重从磁盘换回来 → 一条语音多等 19 秒。
# 那 19 秒比"外面在下雨"贵太多了，所以默认不开。
# 打开的两条路（任选）：①换更小的模型（YAMNet 只有 3.7M 参数，是 AST 的
# 1/20，ears 用的就是它）；②把机器加到 8G。
# 真要临时开：在 .env 里写 AMBIENT_LISTEN=1 然后重启 hearttide-emotion。
AMBIENT_LISTEN = os.environ.get("AMBIENT_LISTEN", "0") == "1"

# SenseVoice 的富文本标签 → 沐沐读得懂的人话（带 emoji，fig 同款气泡样式用）。
# NEUTRAL/Speech 不值一提，略。
EMOTION_ZH = {
    "HAPPY": "😊 听起来是开心的",
    "SAD": "🥺 声音里有难过",
    "ANGRY": "😠 语气带着火气",
    "FEARFUL": "😰 听着有点不安",
    "SURPRISED": "😮 有惊讶的劲儿",
    "DISGUSTED": "😒 语气嫌弃",
}
EVENT_EMOJI_HINT = True   # 事件筐维持纯文字（"带着笑声"自带画面感）
EVENT_ZH = {
    "Laughter": "带着笑声",
    "Cry": "有哭腔",
    "Sneeze": "打了个喷嚏",
    "Cough": "咳嗽了",
    "Breath": "喘着气",
}
# 2026-08-11：SenseVoice 一直在吐这两个标签，映射表里没写，白扔了三个星期。
# 它们跟上面那筐不一样——上面是**她身上**发出的声音，这两个是**她周围**的。
# 分开一筐，让沐沐知道"她那边有动静"而不是"她在笑"。
AMBIENT_ZH = {
    "BGM": "背景里有音乐或电视在响",
    "Applause": "背景有鼓掌声",
}


def _load():
    global _model
    if _model is None:
        from funasr import AutoModel
        _model = AutoModel(model="iic/SenseVoiceSmall", disable_update=True)
    return _model


class AnalyzeIn(BaseModel):
    path: str
    # 通话中不听环境声：AST 热推理约 2.6 秒，她在电话那头等着，
    # 这 2.6 秒比"外面在下雨"值钱得多（2026-08-11 装机时量出来的）
    ambient: bool = True


@app.get("/healthz")
def healthz():
    return {"ok": True, "loaded": _model is not None}


@app.post("/analyze")
def analyze(body: AnalyzeIn):
    model = _load()
    result = model.generate(input=body.path, language="auto", use_itn=False)
    raw = (result[0].get("text") or "") if result else ""
    tags = re.findall(r"<\|([A-Za-z_]+)\|>", raw)

    def uniq(seq):
        seen, out = set(), []
        for item in seq:
            if item not in seen:
                seen.add(item)
                out.append(item)
        return out

    # 分三筐：她身上的声音事件（笑声/哭腔，可靠）、她周围的环境音、
    # 以及情绪色（模型猜的，要跟基线层互证）
    events = uniq(EVENT_ZH[t] for t in tags if t in EVENT_ZH)
    ambient = uniq(AMBIENT_ZH[t] for t in tags if t in AMBIENT_ZH)
    emotions = uniq(EMOTION_ZH[t] for t in tags if t in EMOTION_ZH)

    # 细听一层（2026-08-11，取经 eveacla11/ears 的环境声识别）：SenseVoice 的
    # 事件头只有 8 类，听不出雨声、猫叫、键盘。AST 在 AudioSet 527 类上训练过，
    # 补的就是这一块。它是可选的——装不上/加载失败就当没有，绝不拖垮情绪判读。
    if body.ambient and AMBIENT_LISTEN:
        try:
            from ambient import listen_around
            ambient = uniq(ambient + listen_around(body.path))
        except Exception as exc:
            print(f"[ambient] skipped: {exc}")

    return {"tags": tags, "events": events, "ambient": ambient, "emotions": emotions,
            "notes": events + emotions}   # notes 留着向后兼容
