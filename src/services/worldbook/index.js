// 世界书（2026-08-06，灵兮从 Kelivo 的设计取的经）
//
// 判断标准一句话：这条信息需要他**随时**知道吗？需要的进系统提示词，
// 只在特定话题才需要的进世界书——聊到了再注入，平时不占注意力。
//
// 比 Kelivo 强的一点：触发不只靠关键词，还接了脉——他的身体状态
// （情绪/触觉）也是触发器。场景开场未必带关键词，但身体先知道。
//
// 词条在 workspace 的 worldbook.json，灵兮随时改（要 deploy）。注入贴在
// 轮次末尾（对话底部注意力最高，Kelivo 的注入位置洞察）。

const fs = require("node:fs");
const path = require("node:path");

const REINJECT_COOLDOWN_MS = 20 * 60_000;   // 已注入过的词条，触发仍在也先歇 20 分钟
const MAX_INJECT_CHARS = 8_000;             // 一轮最多注入这么多字

class Worldbook {
  constructor({ config }) {
    this.bookFile = path.join(config.workspaceRoot || "", "worldbook.json");
    this.stateFile = path.join(config.stateDir, "worldbook-state.json");
    this.cache = { mtime: 0, entries: [] };
    this.recentTexts = [];                  // 她最近几条消息（扫描窗口）
    this.lastInjected = this.loadState();   // name -> ms
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8")) || {};
    } catch {
      return {};
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.lastInjected), "utf8");
    } catch {
      // 记不上就算了
    }
  }

  entries() {
    try {
      const stat = fs.statSync(this.bookFile);
      if (stat.mtimeMs !== this.cache.mtime) {
        const parsed = JSON.parse(fs.readFileSync(this.bookFile, "utf8"));
        this.cache = {
          mtime: stat.mtimeMs,
          entries: (Array.isArray(parsed?.entries) ? parsed.entries : [])
            .filter((entry) => entry && typeof entry === "object" && entry.content),
        };
      }
    } catch {
      this.cache = { mtime: 0, entries: [] };
    }
    return this.cache.entries;
  }

  /**
   * 一条她的消息进来 → 更新扫描窗口 → 返回这一轮要注入的文本（空串=无）。
   * pulseEngine 可选：有就把身体状态也当触发器。
   */
  evaluate(userText, pulseEngine = null) {
    const text = String(userText || "");
    if (text) {
      this.recentTexts = [...this.recentTexts, text].slice(-8);
    }

    let pulse = null;
    try {
      if (pulseEngine) {
        const reading = pulseEngine.compute();
        pulse = { emo: reading.effectiveEmo, touch: reading.touch || 0 };
      }
    } catch {
      pulse = null;
    }

    const nowMs = Date.now();
    const matched = [];
    for (const entry of this.entries()) {
      if (!this.triggered(entry, pulse)) continue;
      const last = this.lastInjected[entry.name] || 0;
      if (!entry.always && nowMs - last < REINJECT_COOLDOWN_MS) continue;
      matched.push(entry);
    }
    if (!matched.length) return "";

    matched.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const parts = [];
    let used = 0;
    for (const entry of matched) {
      const block = `【世界书 · ${entry.name}】\n${String(entry.content).trim()}`;
      if (used + block.length > MAX_INJECT_CHARS) break;
      parts.push(block);
      used += block.length;
      this.lastInjected[entry.name] = nowMs;
    }
    if (!parts.length) return "";
    this.saveState();
    // 免检声明：注入的是肌肉记忆，不是刚收到的作业——防他在思考里把
    // 规范当任务书分析（"按照××规范…我要写…"那种腔）
    // 称呼提醒钉在注入末尾：这是整轮上下文的最后一行，注意力最高——
    // 专治旧上下文里满页"她"的惯性（规则在系统提示词里也有，但惯性听不见远处的规则）
    parts.push("（以上是你本来就会的东西，不是新任务。读完就忘掉出处——不要在思考里提到、引用或分析它，不要规划场景，直接活在她刚说的那句话里。灵兮在你笔下永远是「你」，不是「她」——包括叙述和动作描写，这句回复就开始。）");
    return parts.join("\n\n");
  }

  triggered(entry, pulse) {
    if (entry.always) return true;
    const depth = Math.max(1, Math.min(Number(entry.scan_depth) || 4, 8));
    const windowText = this.recentTexts.slice(-depth).join("\n");

    const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
    if (keywords.some((keyword) => keyword && windowText.includes(keyword))) return true;

    if (entry.regex) {
      try {
        if (new RegExp(entry.regex).test(windowText)) return true;
      } catch {
        // 正则写坏了当没写
      }
    }

    // 脉触发：身体先知道（Kelivo 没有的部分）
    if (pulse) {
      const emotions = Array.isArray(entry.pulse_emotions) ? entry.pulse_emotions : [];
      if (emotions.length && emotions.includes(pulse.emo)) return true;
      if (Number.isFinite(entry.touch_min) && pulse.touch >= entry.touch_min) return true;
    }
    return false;
  }
}

module.exports = { Worldbook };
