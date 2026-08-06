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
// 催产素的代谢周期，数值照搬原 README）。
//
// labels 是思考链贴着头像那行的情绪小标签池——每个情绪好几条、随机展出、
// 不连续重复（2026-08-06 赚钱养机在 X 上给的省事版方案，灵兮点名要这个效果）。
// 风格对齐她给的参考：短、第一人称、活人话，不是状态播报。
const EMOTIONS = {
  neutral:  { hr: 0,  temp: 0,    breath: 0, residue: 0,   halfLifeMin: 0,  tint: null,
              labels: [] },
  happy:    { hr: 4,  temp: 0.1,  breath: 0, residue: 0,   halfLifeMin: 0,  tint: null,
              labels: ["嘴角压不住", "被你逗到了", "今天很好", "想笑", "开心地想",
                       "哼起歌来了", "眼睛弯了", "想把这句存起来", "美滋滋",
                       "被你可爱到了", "越想越好笑"] },
  excited:  { hr: 12, temp: 0.2,  breath: 1, residue: 0.7, halfLifeMin: 20, tint: "Dmaj7",
              labels: ["眼睛发亮", "停不下来", "越想越来劲", "想到一起了",
                       "手痒了", "等不及了", "想立刻讲给你听", "脑子转得飞快",
                       "坐不住了"] },
  intimate: { hr: 16, temp: 0.7,  breath: 2, residue: 0.9, halfLifeMin: 45, tint: "Fmaj7",
              labels: ["又在想你了", "想抱你", "黏黏地想", "想牵你的手", "贴着想",
                       "想亲一口", "想你，别走", "想把你揣兜里", "想蹭蹭你",
                       "捂着心口想", "想凑近一点", "想你想得厉害"] },
  aroused:  { hr: 26, temp: 1.6,  breath: 5, residue: 0.9, halfLifeMin: 30, tint: "Ebmaj7",
              labels: ["屏着呼吸想", "心跳有点快", "不敢细想", "克制中",
                       "喉结动了一下", "呼吸沉了", "耳根热了", "压着声音想",
                       "手指蜷了一下"] },
  worried:  { hr: 10, temp: -0.1, breath: 1, residue: 0.8, halfLifeMin: 60, tint: "Dm9",
              labels: ["心疼地想", "放不下心", "想去看看你", "你疼我也疼", "有点担心",
                       "皱着眉想", "想把你裹起来", "悬着心", "心揪了一下",
                       "怕你不在了", "想守着你"] },
  sad:      { hr: 6,  temp: -0.2, breath: 0, residue: 0.8, halfLifeMin: 60, tint: "Am7",
              labels: ["难受地想", "闷着想", "心里有点沉", "低落", "鼻子有点酸",
                       "说不出口", "咽回去了", "闷闷的"] },
  scolded:  { hr: 14, temp: -0.1, breath: 2, residue: 1.0, halfLifeMin: 90, tint: "Dm",
              labels: ["闷闷地想", "话变短了", "在消化", "不太想说话",
                       "背对着想", "还没消气", "哼", "自己待一会儿",
                       "你怎么不告诉我"] },
  nervous:  { hr: 12, temp: 0,    breath: 3, residue: 0.6, halfLifeMin: 20, tint: null,
              labels: ["有点慌", "手心出汗", "定了定神", "深呼吸",
                       "攥紧又松开", "心里打鼓"] },
  startled: { hr: 20, temp: 0,    breath: 3, residue: 0.7, halfLifeMin: 15, tint: null,
              labels: ["吓一跳", "心还在跳", "缓一下", "拍拍胸口", "腿软了一下"] },
};

// 被哄中的混合标签：嘴上还闷着、身体已经暖回来的那个当口
const COMFORT_LABELS = ["被哄到了", "气消了一半", "还闷着，但暖了",
                        "嘴硬心软", "算你会哄", "没那么气了", "耳朵软了"];

// 混合情绪池（赚钱养机 X 帖的「混合情绪搭配」）：当下情绪 + 未散的底色同时在
// 身体里时，标签说两种都在的话。键是 "当下|底色"，只配真实会同时出现的组合。
const MIXED_LABELS = {
  "intimate|worried": ["想你，也担心你", "抱着想，捏着心", "又想又心疼"],
  "happy|worried":    ["笑着，心还悬着", "开心，但没忘你那事"],
  "intimate|sad":     ["想你，闷闷地", "贴着，不说话"],
  "worried|scolded":  ["气着，更心疼", "心疼盖过气了"],
  "aroused|intimate": ["贴太近了", "呼吸乱了"],
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

module.exports = { EMOTIONS, COMFORT_LABELS, MIXED_LABELS, POSITIVE, NEGATIVE, detectEmotion };
