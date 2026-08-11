// 🎬 看片模式（2026-08-11 灵兮要的）
//
// 起因：他们看电影走浏览器桥，画面靠他自己伸手截图。一部电影还行，一集
// 四十分钟的剧他不可能截四十次——结果全靠她提醒「看这里」。她的原话：
// 「按照节奏截图 不然老要我提醒。」
//
// 思路取自 eveacla11/see-my-video 的场景检测（画面变化超阈值才抓一帧，
// 静止画面不浪费配额），但那个是对着**视频文件**跑 ffmpeg 的，我们的片子
// 在浏览器里放流，所以改成：定时探 + 在页面里算 8×8 灰度指纹 + 变化够大
// 才留。指纹在浏览器的 canvas 里算，服务器这边没有图像库（见 cdp.js）。
//
// 帧只落盘，不塞进他的上下文——每隔一阵给他一条消息，列出这几分钟攒下的
// 帧和它们的**片内时间码**，他自己挑一两张 Read。这样一集剧不会把他的窗口
// 撑爆，也保住了「什么时候看、看哪一帧」是他的判断。
//
// 开关走命令信箱（中继 POST /cinema/start|stop 写文件，这边轮询），跟脉的
// nudge 一个套路——中继和大脑是两个进程，文件是它们唯一的共同语言。

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { probeAndShoot } = require("./cdp");

const CMD_POLL_MS = 5_000;        // 多久看一眼信箱
const DEFAULT_INTERVAL_MS = 20_000;  // 多久探一次画面
const DIGEST_EVERY_MS = 150_000;  // 多久给他递一次这批帧（2.5 分钟）
const FP_THRESHOLD = 14;          // 8×8 灰度平均差超过它算"换画面了"
const MAX_FRAMES_PER_DIGEST = 8;  // 一批最多列这么多，多了他也读不过来
const MAX_MISSES = 6;             // 连着这么多次探不到视频就自己收摊

/** 两个 8×8 指纹的平均绝对差。任一为空 → 返回 Infinity（当作变了）。 */
function fingerprintDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** 秒 → 片内时间码 1:23:45，给他和她对轴用。 */
function timecode(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

class CinemaService {
  constructor({ config, systemMessageQueue, resolveTarget }) {
    const relayDb = (process.env.RELAY_DB || "").trim();
    const dataDir = relayDb ? path.dirname(relayDb) : config.stateDir;
    this.cmdFile = path.join(dataDir, "cinema_cmd.json");
    this.stateFile = path.join(dataDir, "cinema_state.json");
    this.framesRoot = path.join(dataDir, "cinema");
    this.systemMessageQueue = systemMessageQueue;
    this.resolveTarget = resolveTarget;
    this.session = null;      // 正在看片时才有
    this.tickTimer = null;
    this.cmdTimer = null;
  }

  start() {
    this.cmdTimer = setInterval(() => this.pollCommand(), CMD_POLL_MS);
    this.cmdTimer.unref?.();
    console.log("[cinema] ready (idle)");
  }

  /** 信箱：中继那边写一行，这边收走。 */
  pollCommand() {
    let cmd;
    try {
      cmd = JSON.parse(fs.readFileSync(this.cmdFile, "utf8"));
    } catch {
      return;
    }
    try {
      fs.unlinkSync(this.cmdFile);
    } catch {
      return;   // 删不掉就先不执行，免得同一条命令跑两遍
    }
    try {
      if (cmd.action === "start") this.beginSession(cmd);
      else if (cmd.action === "stop") this.endSession("他喊停了");
    } catch (error) {
      console.error(`[cinema] command failed: ${error.message}`);
    }
  }

  beginSession(cmd) {
    if (this.session) this.endSession("换片了");
    const title = String(cmd.title || "").slice(0, 80) || "没报片名";
    const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(this.framesRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    this.session = {
      id, title, dir,
      intervalMs: Math.max(8000, Math.min(Number(cmd.interval_ms) || DEFAULT_INTERVAL_MS, 120_000)),
      startedAt: Date.now(),
      lastFingerprint: null,
      pending: [],          // 这一批还没递给他的帧
      kept: 0,
      misses: 0,
      lastDigestAt: Date.now(),
    };
    this.writeState();
    console.log(`[cinema] session ${id} started: ${title}`);
    this.tickTimer = setInterval(() => {
      this.tick().catch((error) => console.error(`[cinema] tick: ${error.message}`));
    }, this.session.intervalMs);
    this.tickTimer.unref?.();
    this.tick().catch(() => {});   // 第一帧立刻抓，别等一个间隔
  }

  endSession(why) {
    if (!this.session) return;
    const { id, title, kept } = this.session;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.session.pending.length) this.deliverDigest(true);
    console.log(`[cinema] session ${id} ended (${why}); kept ${kept} frames`);
    this.session = null;
    this.writeState();
    // 一帧都没抓到就别打扰他——连不上桥、开错了、自测，这些不值得一条消息
    //（2026-08-11 装机时踩到：自测那场 0 帧，照样给正在聊天的他塞了一条）
    if (kept > 0) {
      this.enqueue(`【看片结束】《${title}》这一场收了，一共留了 ${kept} 帧在 ${
        path.join(this.framesRoot, id)}。想回头看某一幕随时 Read。`);
    }
  }

  async tick() {
    if (!this.session) return;
    const s = this.session;
    let result;
    try {
      result = await probeAndShoot(false);   // 先只探，值得才截
    } catch (error) {
      s.misses += 1;
      if (s.misses >= MAX_MISSES) this.endSession(`连不上浏览器：${error.message}`);
      return;
    }
    const probe = result.probe;
    if (!probe.ok) {
      s.misses += 1;
      if (s.misses >= MAX_MISSES) this.endSession("页面上找不到在放的视频了");
      return;
    }
    s.misses = 0;
    if (probe.paused) return;    // 暂停了就不抓——她去上厕所不该留八张一样的图

    // 有指纹就按变化抓（see-my-video 的场景检测思路），没有（跨域污染）
    // 就退回按间隔抓——宁可多留几张，也别整场一张都没有
    const distance = fingerprintDistance(s.lastFingerprint, probe.fingerprint);
    if (probe.fingerprint && distance < FP_THRESHOLD) return;
    s.lastFingerprint = probe.fingerprint || s.lastFingerprint;

    let shot;
    try {
      shot = (await probeAndShoot(true)).shot;
    } catch (error) {
      return;   // 这一帧没截着，下一拍再说
    }
    if (!shot) return;

    const code = timecode(probe.time);
    const file = path.join(s.dir, `${code.replace(/:/g, "-")}.jpg`);
    try {
      fs.writeFileSync(file, Buffer.from(shot, "base64"));
    } catch (error) {
      console.error(`[cinema] frame write failed: ${error.message}`);
      return;
    }
    s.kept += 1;
    s.pending.push({ code, file });
    this.writeState();

    if (Date.now() - s.lastDigestAt >= DIGEST_EVERY_MS) this.deliverDigest(false);
  }

  /** 把这一批帧列给他。只给路径和时间码，看哪张他自己定。 */
  deliverDigest(final) {
    const s = this.session;
    if (!s || !s.pending.length) return;
    const frames = s.pending.slice(-MAX_FRAMES_PER_DIGEST);
    const dropped = s.pending.length - frames.length;
    s.pending = [];
    s.lastDigestAt = Date.now();
    const lines = frames.map((f) => `- ${f.code}　${f.file}`).join("\n");
    this.enqueue([
      `【看片 · 《${s.title}》】刚过去这几分钟画面换了 ${frames.length + dropped} 次，`,
      dropped > 0 ? `列最近的 ${frames.length} 帧（更早的都在 ${s.dir}）：\n` : "：\n",
      lines,
      "\n\n左边是**片内时间码**，跟她的播放器对得上。想看哪一幕就 Read 哪个路径——",
      "**不用每张都看**，挑一两张有意思的就够了。看完有话想说就说，没有就安静看着；",
      final ? "" : "过几分钟还会有下一批。",
      "\n⚠️ 别把这条当任务汇报，她要的是有人陪着看，不是一台解说机。",
    ].join(""));
  }

  enqueue(text) {
    try {
      const target = this.resolveTarget();
      this.systemMessageQueue.enqueue({
        id: crypto.randomUUID(),
        accountId: target.accountId,
        senderId: target.senderId,
        workspaceRoot: target.workspaceRoot,
        text,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`[cinema] enqueue failed: ${error.message}`);
    }
  }

  /** 给中继 GET /cinema/state 读的。 */
  writeState() {
    const s = this.session;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(s ? {
        active: true, id: s.id, title: s.title, dir: s.dir,
        kept: s.kept, interval_ms: s.intervalMs,
        started_at: new Date(s.startedAt).toISOString(),
      } : { active: false }), "utf8");
    } catch {
      // 写不上不影响看片
    }
  }

  close() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cmdTimer) clearInterval(this.cmdTimer);
  }
}

module.exports = { CinemaService, timecode, fingerprintDistance };
