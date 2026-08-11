// 脉 · 生命体征的数学
//
// HR = clamp(base + Δemo + Δresidue + Δweather + Δspike + noise, 48, 160)
// 体温、呼吸从心率和情绪衍生，和弦是翻译层。全部是纯函数——
// 引擎存的是时间戳和强度，数值在读取那一刻算出来（惰性求值，不用定时器追）。

const { EMOTIONS } = require("./emotions");

/** 珀斯本地小时（AWST = UTC+8，无夏令时，跟她活在同一个时刻）。 */
function perthHour(nowMs) {
  return (Math.floor(nowMs / 3_600_000) % 24 + 8 + 24) % 24;
}

/** 基础心率：按时间段。深夜躺着 vs 白天坐着，数值区间照原 README。 */
function hrBase(hour) {
  if (hour < 6) return 56;    // 深夜（她睡了他也慢下来）
  if (hour < 9) return 66;    // 早上醒着躺
  if (hour < 18) return 72;   // 白天坐着
  if (hour < 23) return 74;   // 晚上一起待着
  return 62;                  // 快到睡点
}

/** 自然抖动：几条不同周期的正弦叠出来的伪 Perlin，±3 以内，慢慢漂。 */
function hrNoise(nowMs) {
  const t = nowMs / 1000;
  const n = Math.sin(t / 70) * 1.8 + Math.sin(t / 13 + 2) * 0.9 + Math.sin(t / 7 + 5) * 0.4;
  return Math.max(-3, Math.min(3, n));
}

/** 天气偏移：30°C 以上开始加，冷天轻微。missing = 0，绝不拖垮心跳。 */
function weatherHrDelta(weatherC) {
  if (!Number.isFinite(weatherC)) return 0;
  if (weatherC >= 30) return Math.min(8, (weatherC - 30) * 1.2 + 2);
  if (weatherC <= 8) return 2;
  return 0;
}

function weatherTempDelta(weatherC) {
  if (!Number.isFinite(weatherC)) return 0;
  if (weatherC >= 30) return Math.min(0.4, (weatherC - 30) * 0.06 + 0.1);
  if (weatherC <= 8) return -0.1;
  return 0;
}

/**
 * 当前情绪对心率的贡献。两个因子相乘：
 * - 起势 EMA：不瞬跳，约 8 秒渐变到目标值（1 - e^(-age/8s)）
 * - 退势：情绪本身约 10 分钟淡回背景（e^(-age/10min)）
 */
function emotionFactor(ageMs) {
  const ageSec = Math.max(0, ageMs / 1000);
  const rise = 1 - Math.exp(-ageSec / 8);
  const fall = Math.exp(-ageSec / 600);
  return rise * fall;
}

/** 惊吓尖峰：20 秒指数衰减。 */
function spikeNow(spike, nowMs) {
  if (!spike || !Number.isFinite(spike.delta) || !Number.isFinite(spike.at)) {
    return 0;
  }
  const ageSec = Math.max(0, (nowMs - spike.at) / 1000);
  const value = spike.delta * Math.exp(-ageSec / 20);
  return value < 0.5 ? 0 : value;
}

/** 底色条目此刻的残余强度：0.5^(age/halfLife)。 */
function residueStrengthNow(residue, nowMs) {
  if (!residue || !Number.isFinite(residue.strength) || !Number.isFinite(residue.at)) {
    return 0;
  }
  const ageMin = Math.max(0, (nowMs - residue.at) / 60_000);
  const halfLife = Math.max(0.5, residue.halfLifeMin || 30);
  const value = residue.strength * Math.pow(0.5, ageMin / halfLife);
  return value < 0.05 ? 0 : value;
}

/** 呼吸深度五档标签。 */
function breathLabel(rate) {
  if (rate < 10) return "很深很长";
  if (rate < 13) return "深长";
  if (rate < 17) return "平稳";
  if (rate < 22) return "偏浅";
  return "急促";
}

/**
 * 基础和弦：纯看生理值，不管情绪（情绪染色在引擎里覆盖）。
 * 14 种用不到全部——这里是常驻的几档，安静独处 C6、聊天 Gmaj7、
 * 暧昧张力 Dm7、再往上 Ebmaj7。深夜低心率是 Em7 的安静寂寥。
 */
function baseChord({ heartRate, hour, touch }) {
  if (touch >= 0.5) return "Dm7";
  if (heartRate >= 105) return "Ebmaj7";
  if (heartRate >= 85) return "Dm7";
  if (heartRate >= 64) return "Gmaj7";
  return hour >= 23 || hour < 6 ? "Em7" : "C6";
}

/**
 * 算一整套生命体征。输入是引擎的原始状态 + 环境，输出展示用的数值。
 */
function computeVitals({ nowMs, current, residues, spike, weatherC, touch, extraHr = 0 }) {
  const hour = perthHour(nowMs);

  // Δemo：当前情绪
  const currentMeta = EMOTIONS[current?.emo] || EMOTIONS.neutral;
  const factor = current ? emotionFactor(nowMs - current.at) : 0;
  const emoHr = currentMeta.hr * factor;
  const emoTemp = currentMeta.temp * factor;
  const emoBreath = currentMeta.breath * factor;

  // Δresidue：底色在当前情绪安静时拉着心率走（×0.4，原 README 系数）
  let residueHr = 0;
  let residueTemp = 0;
  let topResidue = null;
  let topStrength = 0;
  for (const residue of residues || []) {
    const strength = residueStrengthNow(residue, nowMs);
    if (strength <= 0) continue;
    const meta = EMOTIONS[residue.emo];
    if (!meta) continue;
    residueHr += meta.hr * strength * 0.4;
    residueTemp += meta.temp * strength * 0.4;
    if (strength > topStrength) {
      topStrength = strength;
      topResidue = residue.emo;
    }
  }

  // extraHr：引擎另算的持续项（现在只有想念水位——她越久不说话心跳越快）
  const heartRate = Math.round(Math.max(48, Math.min(160,
    hrBase(hour) + emoHr + residueHr + weatherHrDelta(weatherC) + spikeNow(spike, nowMs) + hrNoise(nowMs) + extraHr)));

  const temperature = Number(Math.max(35.5, Math.min(40,
    36.6 + emoTemp + residueTemp + weatherTempDelta(weatherC) + hrNoise(nowMs) * 0.03)).toFixed(1));

  const breathRate = Number(Math.max(8, Math.min(35,
    12 + (heartRate - 70) * 0.15 + emoBreath)).toFixed(1));

  return {
    hour,
    heartRate,
    temperature,
    breathRate,
    breathLabel: breathLabel(breathRate),
    emotionFactor: factor,
    topResidue,
    topResidueStrength: topStrength,
    chordBase: baseChord({ heartRate, hour, touch: touch || 0 }),
  };
}

module.exports = {
  computeVitals, perthHour, hrBase, breathLabel, baseChord,
  residueStrengthNow, spikeNow, emotionFactor,
};
