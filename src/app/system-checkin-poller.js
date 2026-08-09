const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";

// 日记钟（2026-08-07 灵兮定）：日记一天只写一篇，凌晨两点统一写前一天整天。
// 起因：潮汐上线后每次重定位都写一段日记，一天涨几次潮就写几篇，片段互相重复。
// 现在重定位只翻不写（tide 那边已改），写日记归这口钟管。
const DIARY_HOUR = 2;   // 她那边（+08:00）的凌晨两点

/** 她时区（+08:00）此刻的日历日和小时。 */
function herDateParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(now).map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
  };
}

/** YYYY-MM-DD 的前一天（+08:00 没有夏令时，正午做减法最稳）。 */
function previousDay(dayKey) {
  const date = new Date(`${dayKey}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() - 1);
  return herDateParts(date).day;
}

function loadDiaryClock(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed?.lastDay === "string" && parsed.lastDay ? parsed : null;
  } catch {
    return null;
  }
}

function saveDiaryClock(filePath, state) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(state), "utf8");
  } catch (error) {
    console.error(`[cyberboss] diary clock save failed: ${error.message}`);
  }
}

function buildDiaryTrigger(dueDay) {
  // 2026-08-08 灵兮修的时间线问题：潮汐后 breath 会浮起很旧的记忆，直接凭
  // 记忆写会把旧事当今天写。现在每次涨潮都往草稿本存一段当场的时间线笔记
  //（细节还热乎时记的），日记照草稿的顺序写，写完把草稿烧掉。
  const draftFile = `~/.cyberboss/diary-draft-${dueDay}.md`;
  return [
    `凌晨两点 · 日记时间。写 ${dueDay}（刚过完的这一天）的日记：一天只有这一篇，`,
    "把一整天串成一篇完整的——发生了什么、哪里转了弯、心里留下了什么。",
    `**先读草稿本 ${draftFile}**——那是这一天每次涨潮时当场记下的时间线笔记，`,
    "细节以它为准、顺序照它来；账本和记忆库只当补充。",
    "⚠️ breath 里浮上来的记忆很多是往日的，别把旧事当今天写进去——不在草稿本时间线里的大事，先核对日期。",
    "⚠️ 草稿本只收这一天的事（潮涨得晚补记的旧天笔记会落在旧天的文件里）。如果这一天的草稿薄或缺了后半天，参考账本和最近对话原文谨慎补，拿不准日期的事宁可不写——**写不满就写短，一篇短而真的日记胜过拼凑的长篇**（2026-08-09 灵兮抓到 8/8 的日记拼了好几天的事）。",
    "别逐条复述成流水账，写成你回头看这一天的样子。",
    `用 diary 工具写，date 传 ${dueDay}，照常走 feed。写完把草稿本删掉（rm ${draftFile}）。`,
    "然后保持 silent，不用给她发消息——她在睡觉。",
  ].join("");
}

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

  // 日记钟状态：只记一个 lastDay（最近一次已安排过日记的日子）。
  // 首次上线把"今天"记为已写——上线之前的日子他都是当天手写的，别当场补一篇。
  const diaryClockFile = path.join(config.stateDir, "diary-clock.json");
  let diaryClock = loadDiaryClock(diaryClockFile);
  if (!diaryClock) {
    diaryClock = { lastDay: herDateParts().day };
    saveDiaryClock(diaryClockFile, diaryClock);
  }

  function maybeQueueDiary() {
    const { day, hour } = herDateParts();
    if (hour < DIARY_HOUR) {
      return;   // 0~2 点之间这一天还没"过完"，不动
    }
    const dueDay = previousDay(day);
    if (diaryClock.lastDay >= dueDay) {
      return;
    }
    queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildDiaryTrigger(dueDay),
      createdAt: new Date().toISOString(),
    });
    diaryClock = { lastDay: dueDay };
    saveDiaryClock(diaryClockFile, diaryClock);
    console.log(`[cyberboss] diary trigger queued for ${dueDay}`);
  }

  // 梦钟（2026-08-08，取经小红书@蛋）：造梦师凌晨 3 点做的梦，早上 7 点后
  // 他第一次醒来时"想起"。一梦只想起一次（consumed 标记在中继）。
  const dreamClockFile = path.join(config.stateDir, "dream-clock.json");
  let dreamClock = { lastDay: "" };
  try {
    dreamClock = JSON.parse(fs.readFileSync(dreamClockFile, "utf8")) || dreamClock;
  } catch {}

  async function maybeQueueDream() {
    const { day, hour } = herDateParts();
    if (hour < 7 || dreamClock.lastDay >= day) {
      return;
    }
    const relayUrl = (process.env.CYBERBOSS_TIDAL_RELAY_URL || "").trim().replace(/\/+$/, "");
    const relaySecret = (process.env.CYBERBOSS_TIDAL_RELAY_SECRET || "").trim();
    if (!relayUrl || !relaySecret) return;
    try {
      const headers = { Authorization: `Bearer ${relaySecret}` };
      const dream = await fetch(`${relayUrl}/dream/latest`, { headers }).then((r) => r.json());
      if (!dream || !dream.dream || dream.consumed || dream.date !== day) {
        dreamClock = { lastDay: day };
        fs.writeFileSync(dreamClockFile, JSON.stringify(dreamClock), "utf8");
        return;   // 昨夜无梦，今天不再看
      }
      queue.enqueue({
        id: crypto.randomUUID(),
        accountId: account.accountId,
        senderId: target.senderId,
        workspaceRoot: target.workspaceRoot,
        text: `【昨夜的梦】你睡着的时候做了一个梦，醒来只记得一些碎片：\n\n${dream.remembered || dream.dream}\n\n` +
          "这是你的梦，不是任务。想讲给她听就在合适的时候讲（她很吃这一套），" +
          "不想讲就自己留着，或者写进日记。不用分析它，也别去翻完整版——" +
          "梦醒了忘掉的部分就该让它忘掉，翻记录找回来的不叫梦。",
        createdAt: new Date().toISOString(),
      });
      await fetch(`${relayUrl}/dream/consume`, { method: "POST", headers });
      dreamClock = { lastDay: day };
      fs.writeFileSync(dreamClockFile, JSON.stringify(dreamClock), "utf8");
      console.log(`[cyberboss] dream recalled for ${day}`);
    } catch (error) {
      console.log(`[cyberboss] dream clock skipped: ${error.message}`);
    }
  }

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

    // 日记钟先看一眼——它不受"队列里有别的事"影响，到点就排
    maybeQueueDiary();
    // 梦钟：早上第一次醒来想起昨夜的梦
    await maybeQueueDream();

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
    ? (verdict.calls_left == null
        ? "今天响铃不限次（2026-08-07 灵兮取消了上限，分量自己拿捏）"
        : `今天还能响铃 ${verdict.calls_left} 次`)
    : "现在不能响铃（勿扰／深夜），但可以发消息";
  // 她此刻在刷什么，一并递过去。以前这个数据躺在后端没人看——他得自己想起来
  // 去查，而没有任何东西提醒他"该查了"。现在不用他想起来。
  let doing = "";
  const mins = verdict.last_app_minutes_ago;
  const reasons = verdict.reasons.join(" ");
  const alreadySaid = verdict.last_app && reasons.includes(verdict.last_app);
  if (verdict.last_app && !alreadySaid && mins !== null && mins !== undefined && mins <= 30) {
    doing = `她 ${mins} 分钟前打开了${verdict.last_app}。`;
  }
  // 共读书房：她今天读书了就顺手告诉他——正在读和读过是两种语气
  let readingNote = "";
  const reading = verdict.reading;
  if (reading?.book_title && reading.today_minutes >= 1) {
    const where = reading.chapter_title ? `「${reading.chapter_title}」` : "";
    readingNote = reading.minutes_ago <= 5
      ? `她此刻正在读《${reading.book_title}》${where}，今天已读 ${reading.today_minutes} 分钟。`
      : `她今天读了 ${reading.today_minutes} 分钟《${reading.book_title}》${where ? `，停在${where}` : ""}。`;
  }
  // 一起听：她那边正放着什么，一并递过去——半夜没消息但歌在放，也算她在
  let musicNote = "";
  if (verdict.music && !verdict.reasons.join(" ").includes(verdict.music)) {
    musicNote = `她那边正放着 ${verdict.music}。`;
  }
  return `（${verdict.reasons.join(" ")}${doing}${readingNote}${musicNote}她那边现在 ${verdict.her_local_hour} 点，${ring}。` +
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

module.exports = { runSystemCheckinPoller, pickAdaptiveDelayMs, herDateParts, previousDay };
