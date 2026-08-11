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

# 环境声那一层（2026-08-11）。曾经默认关着——fp32 的 AST 跟同进程 2.3G 的
# SenseVoice 一起把这台 3.9G 的机器逼进 swap，一条语音要 19 秒。int8 动态
# 量化之后 swap 归零、降到 3.2 秒、判读质量没变，所以现在默认开。
#
# ⚠️ 这个服务**没有 EnvironmentFile**：往 /opt/cyberboss/.env 里写
# AMBIENT_LISTEN 是不生效的（装机时踩过，白测了一轮）。要覆盖就改
# systemd drop-in，仓库里存了一份：deploy/systemd/hearttide-emotion.d-ambient.conf
AMBIENT_LISTEN = os.environ.get("AMBIENT_LISTEN", "1") == "1"

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
