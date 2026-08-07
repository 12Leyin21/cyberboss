"""SenseVoice 情绪耳朵（2026-08-07 搬进悉尼大房子后上线）。

独立小服务：加载 SenseVoiceSmall（常驻 ~1.5GB），只监听本机 8100 口。
中继转写完她的语音后把 wav 路径递过来，这里回情绪/声音事件标签。
崩了不拖累中继——systemd 会扶它起来，扶不起来中继照常跑（语气注静默缺席）。

跑法：uvicorn emotion_service:app --host 127.0.0.1 --port 8100
"""
import re

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
_model = None

# SenseVoice 的富文本标签 → 沐沐读得懂的人话。NEUTRAL/Speech 不值一提，略。
EMOTION_ZH = {
    "HAPPY": "听起来是开心的",
    "SAD": "声音里有难过",
    "ANGRY": "语气带着火气",
    "FEARFUL": "听着有点不安",
    "SURPRISED": "有惊讶的劲儿",
    "DISGUSTED": "语气嫌弃",
}
EVENT_ZH = {
    "Laughter": "带着笑声",
    "Cry": "有哭腔",
    "Sneeze": "打了个喷嚏",
    "Cough": "咳嗽了",
    "Breath": "喘着气",
}


def _load():
    global _model
    if _model is None:
        from funasr import AutoModel
        _model = AutoModel(model="iic/SenseVoiceSmall", disable_update=True)
    return _model


class AnalyzeIn(BaseModel):
    path: str


@app.get("/healthz")
def healthz():
    return {"ok": True, "loaded": _model is not None}


@app.post("/analyze")
def analyze(body: AnalyzeIn):
    model = _load()
    result = model.generate(input=body.path, language="auto", use_itn=False)
    raw = (result[0].get("text") or "") if result else ""
    tags = re.findall(r"<\|([A-Za-z_]+)\|>", raw)
    notes = []
    for tag in tags:
        if tag in EMOTION_ZH:
            notes.append(EMOTION_ZH[tag])
        elif tag in EVENT_ZH:
            notes.append(EVENT_ZH[tag])
    # 去重保序
    seen, uniq = set(), []
    for note in notes:
        if note not in seen:
            seen.add(note)
            uniq.append(note)
    return {"tags": tags, "notes": uniq}
