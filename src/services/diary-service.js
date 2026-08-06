const fs = require("fs");
const path = require("path");

const { resolveBodyInput } = require("./text-input");

class DiaryService {
  constructor({ config }) {
    this.config = config;
  }

  async append({ text = "", textFile = "", title = "", date = "", time = "", locked = false } = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Diary content cannot be empty. Pass text or textFile.");
    }

    const now = new Date();
    const dateString = date || formatDate(now);
    const timeString = time || formatTime(now);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    const entry = buildDiaryEntry({
      timeString,
      title,
      body,
      locked,
    });

    fs.mkdirSync(this.config.diaryDir, { recursive: true });
    const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n\n" : "";
    fs.appendFileSync(filePath, `${prefix}${entry}`, "utf8");

    // 2026-08-06 灵兮定：日记直接进心潮的日记本，她不用再去 shell 里复制。
    // 走 feed（静默：不推送、不进聊天流），本地文件照写——那是档案正本。
    const delivered = await this.deliverToHeartTide({ dateString, title, body, locked });
    return {
      filePath,
      date: dateString,
      time: timeString,
      body,
      locked: Boolean(locked),
      delivered,
    };
  }

  /**
   * 送进心潮日记本。格式约定（App 按行首匹配）：
   * - 开放日记：`📔 沐沐日记 · YYYY-MM-DD`
   * - 上锁日记：`📔🔒 沐沐日记 · YYYY-MM-DD`——App 收进日记本的上锁区，
   *   灵兮不可见。这是他自己的抽屉，她亲手给的。
   * 中继没配就静默跳过（本地文件还在，不算丢）。
   */
  async deliverToHeartTide({ dateString, title, body, locked }) {
    const url = (process.env.CYBERBOSS_TIDAL_RELAY_URL || "").trim().replace(/\/+$/, "");
    const secret = (process.env.CYBERBOSS_TIDAL_RELAY_SECRET || "").trim();
    if (!url || !secret) {
      return false;
    }
    const marker = locked ? "📔🔒 沐沐日记" : "📔 沐沐日记";
    const titleLine = String(title || "").trim();
    const textOut = `${marker} · ${dateString}\n\n${titleLine ? `${titleLine}\n\n` : ""}${body}`;
    try {
      const response = await fetch(`${url}/channel/out`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ type: "feed", text: textOut }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function buildDiaryEntry({ timeString, title, body, locked = false }) {
  const lock = locked ? " 🔒" : "";
  const heading = title ? `## ${timeString}${lock} ${String(title).trim()}` : `## ${timeString}${lock}`;
  return `${heading}\n\n${body}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

module.exports = {
  DiaryService,
  buildDiaryEntry,
  formatDate,
  formatTime,
};
