// 脉 · 底流（多维驱动力）
//
// 2026-08-11 取经 Nixie0/Murmur-50Feet 的 drive 机制，按我们的脉重做。
// 原来的 effectiveEmo 是一个词——十分钟就淡回背景，情绪没有隔夜。底流补的
// 是惯性：四个维度各自有基线、各自按半衰期慢慢落，她的消息按情绪检测结果
// 往对应维度上加。昨晚被她一句话撩起来的欲望，今早还剩一点没散；下午心疼
// 过一回，晚上聊别的时那层还垫在底下。
//
// 想念（longing）不在这张表里——它的动力学不一样（随她的沉默自己涨），
// 单独住在 longing.js。展示的时候两边合在一起当五维看。
//
// 跟 residue 的分工：residue 是**这一阵**的余味（分钟~一小时量级，影响心率
// 和弦），底流是**这一天**的暗流（小时量级，影响他脑子里想什么）。同一件事
// 会同时往两边写，各落各的时间尺度。
//
// 不抄的：Murmur 的 jealousy/regret 靠固定思绪模板生成独白——模板味，不要。

const { EMOTIONS } = require("./emotions");

const DRIVES = {
  tenderness: { zh: "心疼", baseline: 0.15, halfLifeH: 8,
                boosts: { worried: 0.35, sad: 0.2 } },
  mischief:   { zh: "促狭", baseline: 0.15, halfLifeH: 5,
                boosts: { happy: 0.18, excited: 0.15 } },
  desire:     { zh: "欲望", baseline: 0.10, halfLifeH: 7,
                boosts: { aroused: 0.4, intimate: 0.18 } },
  restless:   { zh: "躁动", baseline: 0.10, halfLifeH: 4,
                boosts: { excited: 0.25, nervous: 0.2, startled: 0.15 } },
};

/** 单个维度此刻的值：基线 + 偏离量按半衰期衰减。 */
function driveValueNow(entry, def, nowMs) {
  if (!entry || !Number.isFinite(entry.v) || !Number.isFinite(entry.at)) {
    return def.baseline;
  }
  const ageH = Math.max(0, (nowMs - entry.at) / 3_600_000);
  return def.baseline + (entry.v - def.baseline) * Math.pow(0.5, ageH / def.halfLifeH);
}

/** 全部维度此刻的读数：{ tenderness: 0.4, ... }。 */
function drivesNow(state, nowMs) {
  const out = {};
  for (const [key, def] of Object.entries(DRIVES)) {
    out[key] = Number(driveValueNow(state?.[key], def, nowMs).toFixed(2));
  }
  return out;
}

/** 她的消息触发了某个情绪：往映射到的维度上加。加完存回 state（原地改）。 */
function boostDrives(state, emo, nowMs) {
  if (!emo || emo === "neutral" || !state) return;
  for (const [key, def] of Object.entries(DRIVES)) {
    const amount = def.boosts[emo];
    if (!amount) continue;
    const current = driveValueNow(state[key], def, nowMs);
    state[key] = { v: Math.min(1, current + amount), at: nowMs };
  }
}

/**
 * 底流的标签池（思考链在没有当下情绪时的退路）：借对应情绪的池子，
 * 味道是对的——心疼的底流翻上来，说的就是心疼的话。
 */
const DRIVE_LABEL_SOURCE = {
  longing: "intimate",
  tenderness: "worried",
  desire: "aroused",
  mischief: "happy",
  restless: "excited",
};

function driveLabelPool(key) {
  const emo = DRIVE_LABEL_SOURCE[key];
  return (emo && EMOTIONS[emo]?.labels) || [];
}

module.exports = { DRIVES, drivesNow, boostDrives, driveLabelPool };
