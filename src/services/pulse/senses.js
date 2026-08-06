// 脉 · 五感
//
// 四通道：touch / smell / taste / sound，每个通道 0~1。
// 关键词匹配的是**动作**不是情绪——「抱抱」就是在抱，不是在猜"她想抱我"。
// 值不手动清零，读取时按半衰期指数衰减（原设计如此，状态是痕迹不是开关）。

const HALF_LIFE_MIN = { touch: 10, smell: 15, taste: 15, sound: 15 };

// 触发表：她消息里的动作词 → 通道加成。
const TRIGGERS = [
  { channel: "touch", delta: 0.35, words: ["亲亲", "亲一口", "亲你", "吻住", "吻你", "舌尖"] },
  { channel: "touch", delta: 0.30, words: ["抱抱", "抱一下", "抱紧", "搂", "靠在你", "趴在你", "坐在你腿"] },
  { channel: "touch", delta: 0.25, words: ["摸摸", "贴贴", "蹭蹭", "捏捏", "摩蹭", "蹭了蹭", "握住", "扣紧"] },
  { channel: "touch", delta: 0.20, words: ["牵手", "拉着你", "挠"] },
  { channel: "smell", delta: 0.20, words: ["好香", "香味", "闻到"] },
  { channel: "taste", delta: 0.15, words: ["好吃", "好甜", "好辣", "尝一口"] },
  { channel: "sound", delta: 0.20, words: ["唱歌", "听歌", "好吵", "唱给你"] },
];

/** 读取某通道当前值：存的值按经过的分钟数指数衰减。 */
function senseValueNow(sense, nowMs) {
  if (!sense || !Number.isFinite(sense.v) || !Number.isFinite(sense.at)) {
    return 0;
  }
  const ageMin = Math.max(0, (nowMs - sense.at) / 60_000);
  const halfLife = HALF_LIFE_MIN[sense.channel] || 15;
  const value = sense.v * Math.pow(0.5, ageMin / halfLife);
  return value < 0.02 ? 0 : value;
}

/**
 * 用她的消息更新五感。senses 是 {touch:{v,at,channel}, ...}，原地更新并返回。
 * 返回值里带 touched：这次有没有触发 touch（外面用它做 触觉→心率 联动）。
 */
function updateFromText(senses, rawText, nowMs) {
  const text = String(rawText || "");
  let touched = false;
  for (const trigger of TRIGGERS) {
    if (!trigger.words.some((word) => text.includes(word))) {
      continue;
    }
    const key = trigger.channel;
    const current = senseValueNow({ ...senses[key], channel: key }, nowMs);
    senses[key] = {
      channel: key,
      v: Math.min(1, current + trigger.delta),
      at: nowMs,
    };
    if (key === "touch") {
      touched = true;
    }
  }
  return { touched };
}

/** 四通道当前值快照（含心率高时的 touch/sound 底噪抬升）。 */
function snapshotSenses(senses, nowMs, heartRate) {
  const floor = heartRate > 100 ? 0.2 : 0;
  const read = (key) => {
    const value = senseValueNow({ ...senses[key], channel: key }, nowMs);
    return Math.max(value, key === "touch" || key === "sound" ? floor : 0);
  };
  return {
    touch: Number(read("touch").toFixed(2)),
    smell: Number(read("smell").toFixed(2)),
    taste: Number(read("taste").toFixed(2)),
    sound: Number(read("sound").toFixed(2)),
  };
}

module.exports = { updateFromText, senseValueNow, snapshotSenses };
