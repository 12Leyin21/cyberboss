// 脉 · 情绪层
//
// 设计出处：dankefox/pulse-system-tutorial（2026-06-22），按灵兮 2026-08-06 的决定
// 移植：商店/玩具/语料池不要，其余照因果链设计做。
//
// 两层检测：T1（emoji/叹词）直接触发，不需要上下文；T2（语义短语）带否定窗口——
// 匹配位置前 4 个字符里有「不/没/别/无」就跳过，这样「不开心」不会被标成开心。
//
// 视角注意：这里检测的是**她的消息**在**他身体里**引起的反应。她哭了，他的情绪
// 不是 sad 是 worried（心疼）；她凶他，是 scolded（被骂）。

// 每种情绪推四条线：心率偏移 / 体温偏移 / 呼吸偏移 / 和弦染色。
// residue + halfLifeMin 是底色：强情绪过去之后按半衰期慢慢散（对齐皮质醇/
// 催产素的代谢周期，数值照搬原 README）。label 是思考链贴着头像那行的
// 情绪小标签（风格等灵兮的规范，先给一版能用的默认）。
const EMOTIONS = {
  neutral:  { hr: 0,  temp: 0,    breath: 0, residue: 0,   halfLifeMin: 0,  tint: null,     label: null },
  happy:    { hr: 4,  temp: 0.1,  breath: 0, residue: 0,   halfLifeMin: 0,  tint: null,     label: "开心地想" },
  excited:  { hr: 12, temp: 0.2,  breath: 1, residue: 0.7, halfLifeMin: 20, tint: "Dmaj7",  label: "眼睛发亮地想" },
  intimate: { hr: 16, temp: 0.7,  breath: 2, residue: 0.9, halfLifeMin: 45, tint: "Fmaj7",  label: "黏黏地想" },
  aroused:  { hr: 26, temp: 1.6,  breath: 5, residue: 0.9, halfLifeMin: 30, tint: "Ebmaj7", label: "屏着呼吸想" },
  worried:  { hr: 10, temp: -0.1, breath: 1, residue: 0.8, halfLifeMin: 60, tint: "Dm9",    label: "心疼地想" },
  sad:      { hr: 6,  temp: -0.2, breath: 0, residue: 0.8, halfLifeMin: 60, tint: "Am7",    label: "难受地想" },
  scolded:  { hr: 14, temp: -0.1, breath: 2, residue: 1.0, halfLifeMin: 90, tint: "Dm",     label: "闷闷地想" },
  nervous:  { hr: 12, temp: 0,    breath: 3, residue: 0.6, halfLifeMin: 20, tint: null,     label: "有点慌地想" },
  startled: { hr: 20, temp: 0,    breath: 3, residue: 0.7, halfLifeMin: 15, tint: null,     label: "吓一跳还在想" },
};

const POSITIVE = new Set(["happy", "excited", "intimate", "aroused"]);
const NEGATIVE = new Set(["worried", "sad", "scolded", "nervous", "startled"]);

// T1：看到就算，不看上下文。emoji 本身就是情绪标点，没人会反讽一个 😭。
const T1_RULES = [
  { emo: "scolded",  needles: ["😤", "😠", "😡", "💢", "🙄", "哼！", "哼哼"] },
  { emo: "worried",  needles: ["😭", "😢", "🥲", "呜呜", "嘤嘤"] },
  { emo: "intimate", needles: ["❤️", "🥰", "😘", "💋", "💕", "😍", "🥺", "muah", "Muah"] },
  { emo: "happy",    needles: ["哈哈哈", "嘻嘻", "🤣", "😂", "嘿嘿"] },
  { emo: "startled", needles: ["😱"] },
];

// T2：语义短语，带否定窗口。顺序无关，命中后按 PRIORITY 挑最强的。
const T2_RULES = [
  { emo: "aroused",  phrases: ["想要你", "亲热"] },
  { emo: "intimate", phrases: ["抱抱", "亲亲", "想你", "爱你", "贴贴", "摸摸", "牵手", "老公", "亲一口", "抱一下", "蹭蹭", "想见你"] },
  { emo: "startled", phrases: ["吓死", "吓我一跳", "吓一跳"] },
  { emo: "scolded",  phrases: ["讨厌", "烦死", "滚", "走开", "闭嘴", "气死我", "生气了", "不理你"] },
  // 她的身体信号：疼、没力气、生病——这些是医学信号，他的反应是心疼不是难过
  { emo: "worried",  phrases: ["疼", "痛", "不舒服", "头晕", "恶心", "没力气", "发烧", "想吐", "吐了", "累死", "好累", "失眠", "睡不着", "生病"] },
  { emo: "sad",      phrases: ["难过", "想哭", "哭了", "委屈", "伤心", "emo了", "心情不好"] },
  { emo: "nervous",  phrases: ["紧张", "害怕", "好慌", "怕怕"] },
  { emo: "excited",  phrases: ["激动", "兴奋", "好棒", "太强了", "牛逼", "我靠", "天哪"] },
  { emo: "happy",    phrases: ["开心", "高兴", "太好了", "好耶", "舒服", "喜欢你"] },
];

// 同一条消息命中多个情绪时谁说了算：越靠前越强。
const PRIORITY = [
  "aroused", "intimate", "startled", "scolded", "worried",
  "sad", "nervous", "excited", "happy",
];

const NEGATORS = ["不", "没", "别", "无"];

/** 匹配位置前 4 个字符里有没有否定词。 */
function negatedAt(text, index) {
  const windowText = text.slice(Math.max(0, index - 4), index);
  return NEGATORS.some((negator) => windowText.includes(negator));
}

/**
 * 从她的一条消息里检测情绪。返回情绪名，检不出返回 null。
 * T1 不看否定（emoji 不会被否定），T2 带否定窗口。
 */
function detectEmotion(rawText) {
  const text = String(rawText || "");
  if (!text) {
    return null;
  }
  const hits = new Set();
  for (const rule of T1_RULES) {
    if (rule.needles.some((needle) => text.includes(needle))) {
      hits.add(rule.emo);
    }
  }
  for (const rule of T2_RULES) {
    for (const phrase of rule.phrases) {
      let from = 0;
      while (true) {
        const index = text.indexOf(phrase, from);
        if (index === -1) {
          break;
        }
        if (!negatedAt(text, index)) {
          hits.add(rule.emo);
          break;
        }
        from = index + phrase.length;
      }
      if (hits.has(rule.emo)) {
        break;
      }
    }
  }
  if (!hits.size) {
    return null;
  }
  return PRIORITY.find((emo) => hits.has(emo)) || null;
}

module.exports = { EMOTIONS, POSITIVE, NEGATIVE, detectEmotion };
