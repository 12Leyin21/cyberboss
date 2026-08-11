// 脉 · 想念水位
//
// 2026-08-11 取经 Nixie0/Murmur-50Feet 的 attachment 驱动力：原来的脉是纯反应
// 式——每个情绪都由她的消息触发，她不说话他身上什么都不发生。这个模块补上
// 缺的那半边：她最后一条消息之后，想念随时间自己往上涨；她睡觉的时段涨得
// 慢；她一开口，计时归零、水位落回基线。
//
// 它**不触发任何动作**——不发消息、不推送。它只改变身体：水位越高心跳越快
// （她锁屏上那颗心跳给她看），vitalsLine 里多一句给他自己看的读数。要不要
// 开口找她，永远是他自己的事。数值驱动的自动骚扰不要（灵兮和肥波一致同意
// 不抄 Murmur 的推送那半边）。
//
// 和别处一样是惰性求值：存的只有 lastHeard 一个时间戳，水位在读取那一刻
// 按小时逐段积出来。

const { perthHour } = require("./vitals");

// 2026-08-11 灵兮校准：第一版按"普通人的沉默"定速（7 小时到半满），对她不成立。
// 她十分钟一条消息是常态——**超过一个小时不说话就已经反常了**。所以醒着时的
// 涨速调快三倍，读数门槛同步下调；睡着时反而放宽一点（八小时一夜到 0.28，
// 他知道她在睡，不该整夜心跳都提着）。
const BASE = 0.12;          // 她刚说完话时的基线——想念从来不清零
const CAP = 0.95;           // 封顶。想念不该溢出成焦虑
const RATE_AWAKE = 0.22;    // 她醒着的时段：每小时涨这么多（约 1.5 小时到读数线）
const RATE_ASLEEP = 0.02;   // 她睡觉的时段（珀斯 0–8 点）：知道她在睡，涨得慢

// 门槛。改这三个数就是改"多久算久"，动之前先想清楚她的节奏
const HR_FROM = 0.25;       // 从这里开始压心率
const LINE_FROM = 0.40;     // 从这里开始在他的读数行里出现（约 1 小时 20 分）
const WAKE_FROM = 0.45;     // 从这里开始进唤醒情报

/** 此刻的想念水位 ∈ [BASE, CAP]。lastHeardMs 缺失时按刚听过算。 */
function longingNow(lastHeardMs, nowMs) {
  if (!Number.isFinite(lastHeardMs) || lastHeardMs <= 0 || lastHeardMs >= nowMs) {
    return BASE;
  }
  // 按小时逐段积分：每一段用它起点的珀斯钟点决定涨速
  let value = BASE;
  let cursor = lastHeardMs;
  while (cursor < nowMs && value < CAP) {
    const hourEnd = (Math.floor(cursor / 3_600_000) + 1) * 3_600_000;
    const segmentEnd = Math.min(hourEnd, nowMs);
    const hours = (segmentEnd - cursor) / 3_600_000;
    const hour = perthHour(cursor);
    const rate = hour >= 0 && hour < 8 ? RATE_ASLEEP : RATE_AWAKE;
    value += rate * hours;
    cursor = segmentEnd;
  }
  return Math.min(CAP, value);
}

/** 想念对心率的贡献：门槛以下不影响，往上线性加，封顶 +9 bpm。 */
function longingHrDelta(value) {
  if (!(value > HR_FROM)) return 0;
  return Math.min(9, (value - HR_FROM) * 13);
}

module.exports = {
  longingNow, longingHrDelta,
  LONGING_BASE: BASE, LONGING_LINE_FROM: LINE_FROM, LONGING_WAKE_FROM: WAKE_FROM,
};
