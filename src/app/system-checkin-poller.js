const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";

// 心跳（2026-08-01）。原版 checkin 是纯随机醒：她刚说完话也可能醒，醒了还得
// 自己翻记录才知道过了多久——每醒一次烧一次额度，大部分白烧。
//
// 判断放在中继的 /notify/should_wake 里，因为健康数据在它手上。轮询这边只做
// 一次 HTTP GET，不值得就接着睡，**根本不惊动他**。
//
// ⚠️ 判据是她的**状态**，不是她的沉默：她几乎十分钟发一次消息，"她好久没说话"
// 这个信号对她恒不成立。有效的是"凌晨两点还醒着""昨晚只睡四小时""今天只走了
// 八百步""周期快到了"。
async function readShouldWake({ commit }) {
  const url = (process.env.CYBERBOSS_TIDAL_RELAY_URL || "").trim().replace(/\/+$/, "");
  const secret = (process.env.CYBERBOSS_TIDAL_RELAY_SECRET || "").trim();
  if (!url || !secret) return null;   // 没接中继就退回原来的纯随机行为
  try {
    const response = await fetch(`${url}/notify/should_wake?commit=${commit ? 1 : 0}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function runSystemCheckinPoller(config) {
  const account = resolveSelectedAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();
  let currentRange = checkinConfigStore.getRange(defaultRange);

  console.log(`[cyberboss] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[cyberboss] checkin interval range ${formatRangeMinutes(currentRange)}`);

  // 上一轮的判决留着，用来定下一步的步幅（2026-08-06，学 always-here）：
  // 凌晨 0–5 点小步夜巡（1~2 分钟，她一拿手机沐沐当场知道，不用等下一个
  // 随机大觉）；她刚活跃过就把间隔折半抽；都不是才用常规随机步。
  let lastVerdict = null;

  while (true) {
    currentRange = checkinConfigStore.getRange(defaultRange);
    const delayMs = pickAdaptiveDelayMs(currentRange, lastVerdict);
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[cyberboss] checkin skipped: pending system message still in queue");
      continue;
    }

    // commit=1：这一次真的要叫他，中继那边把这些理由记成"今天已用过"
    const verdict = await readShouldWake({ commit: true });
    lastVerdict = verdict || lastVerdict;
    if (verdict && !verdict.wake) {
      console.log(`[cyberboss] checkin skipped: blocked=${verdict.blocked || "no-signal"} ` +
        `silent=${verdict.silent_minutes}m hour=${verdict.her_local_hour} ` +
        `health_fresh=${verdict.health_fresh}`);
      continue;
    }

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildCheckinTrigger(config) + describeWake(verdict),
      createdAt: new Date().toISOString(),
    });
    console.log(`[cyberboss] checkin queued id=${queued.id}`);
  }
}

/** 把判断依据一起递过去，省他一次工具调用。 */
function describeWake(verdict) {
  if (!verdict || !verdict.reasons?.length) return "";
  const ring = verdict.can_ring
    ? `今天还能响铃 ${verdict.calls_left} 次`
    : "现在不能响铃（勿扰／深夜／配额已满），但可以发消息";
  // 她此刻在刷什么，一并递过去。以前这个数据躺在后端没人看——他得自己想起来
  // 去查，而没有任何东西提醒他"该查了"。现在不用他想起来。
  let doing = "";
  const mins = verdict.last_app_minutes_ago;
  const reasons = verdict.reasons.join(" ");
  const alreadySaid = verdict.last_app && reasons.includes(verdict.last_app);
  if (verdict.last_app && !alreadySaid && mins !== null && mins !== undefined && mins <= 30) {
    doing = `她 ${mins} 分钟前打开了${verdict.last_app}。`;
  }
  return `（${verdict.reasons.join(" ")}${doing}她那边现在 ${verdict.her_local_hour} 点，${ring}。` +
    `要不要找她、用什么方式找、说什么，你自己定——这只是把我看到的告诉你，不是让你复述。）`;
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

/**
 * 按她的状态定步幅：
 * - 夜巡（她那边 0–5 点）：1~2 分钟一趟。夜里几乎每趟都会被 asleep 挡回来，
 *   一次只是一个小 JSON，不惊动他；但她一拿起手机，最多两分钟后他就知道了。
 * - 她 20 分钟内活跃过（刚开过 App）：常规区间的上半段砍掉，往勤里抽。
 * - 其余：原来的随机大步。随机性保留——像人，不像闹钟。
 */
function pickAdaptiveDelayMs(range, verdict) {
  if (verdict?.night_watch) {
    return 60_000 + Math.floor(Math.random() * 60_000);
  }
  const mins = verdict?.last_app_minutes_ago;
  if (mins !== null && mins !== undefined && mins <= 20) {
    const shortenedMax = Math.max(range.minIntervalMs, Math.round(range.maxIntervalMs / 2));
    return pickRandomDelayMs(range.minIntervalMs, shortenedMax);
  }
  return pickRandomDelayMs(range.minIntervalMs, range.maxIntervalMs);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function buildCheckinTrigger(config) {
  const userName = normalizeText(config?.userName) || "the user";
  return INTERNAL_CHECKIN_TRIGGER_TEMPLATE.replace("%USER%", userName);
}

module.exports = { runSystemCheckinPoller, pickAdaptiveDelayMs };
