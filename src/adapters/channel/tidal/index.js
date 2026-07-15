const fs = require("node:fs");
const path = require("node:path");
const { createWeixinChannelAdapter } = require("../weixin");

// Tidal_Echo relay channel: lets the same brain serve the HeartTide phone app
// alongside WeChat. Enabled only when both env vars are present:
//   CYBERBOSS_TIDAL_RELAY_URL    e.g. https://tidal-echo-backend.onrender.com
//   CYBERBOSS_TIDAL_RELAY_SECRET the relay's RELAY_SECRET
// Optional: CYBERBOSS_TIDAL_SENDER_ID (default "tidal:lingxi")

const RECONNECT_DELAY_MS = 5_000;
const CATCHUP_PAGE_LIMIT = 500;

function readTidalEnv() {
  const url = (process.env.CYBERBOSS_TIDAL_RELAY_URL || "").trim().replace(/\/+$/, "");
  const secret = (process.env.CYBERBOSS_TIDAL_RELAY_SECRET || "").trim();
  const senderId = (process.env.CYBERBOSS_TIDAL_SENDER_ID || "tidal:lingxi").trim();
  if (!url || !secret) {
    return null;
  }
  return { url, secret, senderId };
}

function isTidalUserId(userId) {
  return typeof userId === "string" && userId.startsWith("tidal");
}

function createTidalClient(env, config) {
  const stateFile = path.join(config.stateDir, "tidal-last-id.json");
  let stopped = false;
  let lastId = loadLastId();

  function loadLastId() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return Number.isFinite(parsed?.lastId) ? parsed.lastId : 0;
    } catch {
      return 0;
    }
  }

  function saveLastId(id) {
    if (!Number.isFinite(id) || id <= lastId) {
      return;
    }
    lastId = id;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ lastId }));
    } catch {
      // 状态写失败只影响重启后的去重，不致命
    }
  }

  function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${env.secret}`, ...extra };
  }

  function toRawMessage({ id, text, ts, attachments }) {
    return { __tidal: true, id, text: String(text || ""), ts: ts || "", attachments: attachments || [] };
  }

  // 掉线期间灵兮发的消息从历史接口补齐
  async function catchUp(onMessage) {
    let since = lastId;
    for (let page = 0; page < 40; page += 1) {
      const response = await fetch(
        `${env.url}/app/history?since=${since}&limit=${CATCHUP_PAGE_LIMIT}`,
        { headers: authHeaders() }
      );
      if (!response.ok) {
        return;
      }
      const body = await response.json();
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      if (!messages.length) {
        return;
      }
      for (const message of messages) {
        const id = Number(message?.id);
        if (!Number.isFinite(id) || id <= lastId) {
          continue;
        }
        if (message?.from === "human" && message?.kind !== "call") {
          onMessage(toRawMessage({
            id,
            text: message.text,
            ts: message.ts,
            attachments: message?.meta?.attachments,
          }));
        }
        saveLastId(id);
      }
      const maxId = Math.max(...messages.map((m) => Number(m?.id) || 0));
      if (messages.length < CATCHUP_PAGE_LIMIT || maxId <= since) {
        return;
      }
      since = maxId;
    }
  }

  // 常驻 SSE：灵兮在 App/PWA 里说话就实时进来
  async function streamLoop(onMessage) {
    while (!stopped) {
      try {
        await catchUp(onMessage);
        const response = await fetch(`${env.url}/channel/in`, {
          headers: authHeaders({ Accept: "text/event-stream" }),
        });
        if (!response.ok || !response.body) {
          throw new Error(`channel/in http ${response.status}`);
        }
        console.log("[cyberboss] tidal: stream connected");
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          if (stopped) {
            break;
          }
          buffer += decoder.decode(chunk, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (!line.startsWith("data:")) {
              continue;
            }
            let payload = null;
            try {
              payload = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            const id = Number(payload?.id);
            if (!Number.isFinite(id) || id <= lastId || typeof payload?.content !== "string") {
              continue;
            }
            saveLastId(id);
            onMessage(toRawMessage({
              id,
              text: payload.content,
              ts: payload.ts,
              attachments: payload.attachments,
            }));
          }
        }
      } catch (error) {
        if (!stopped) {
          console.error(`[cyberboss] tidal stream error: ${error?.message || error}`);
        }
      }
      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      }
    }
  }

  return {
    env,
    start(onMessage) {
      stopped = false;
      void streamLoop(onMessage);
    },
    stop() {
      stopped = true;
    },
    async sendReply(text) {
      const content = String(text || "").trim();
      if (!content) {
        return;
      }
      const response = await fetch(`${env.url}/channel/out`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ type: "reply", text: content }),
      });
      if (!response.ok) {
        throw new Error(`tidal channel/out http ${response.status}`);
      }
    },
    async sendFile(filePath) {
      const data = fs.readFileSync(filePath);
      const name = path.basename(filePath);
      const mime = guessMime(name);
      const uploadResponse = await fetch(
        `${env.url}/app/upload?name=${encodeURIComponent(name)}`,
        { method: "POST", headers: authHeaders({ "Content-Type": mime }), body: data }
      );
      if (!uploadResponse.ok) {
        throw new Error(`tidal upload http ${uploadResponse.status}`);
      }
      const attachment = await uploadResponse.json();
      const response = await fetch(`${env.url}/channel/out`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          type: "reply",
          text: mime.startsWith("image/") ? "🖼️ [图片]" : `📎 ${name}`,
          attachments: [attachment],
        }),
      });
      if (!response.ok) {
        throw new Error(`tidal channel/out http ${response.status}`);
      }
    },
    // 附件在正文里带上可直接下载的地址，方便运行时取用
    describeAttachments(attachments) {
      if (!Array.isArray(attachments) || !attachments.length) {
        return "";
      }
      return attachments
        .map((attachment) => {
          const url = String(attachment?.url || "");
          const absolute = url.startsWith("http") ? url : `${env.url}${url}`;
          const kind = attachment?.kind === "image" ? "图片" : (attachment?.kind === "audio" ? "语音" : "文件");
          return `[${kind}附件] ${absolute}?token=${env.secret}`;
        })
        .join("\n");
    },
  };
}

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
    ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".txt": "text/plain",
  };
  return map[ext] || "application/octet-stream";
}

// 分流器：对核心引擎假装还是单通道；Tidal 用户走中继，其余原样走微信。
// 未配置 Tidal 环境变量时直接返回微信适配器，行为零变化。
function createChannelAdapter(config) {
  const weixin = createWeixinChannelAdapter(config);
  const env = readTidalEnv();
  if (!env) {
    return weixin;
  }
  const tidal = createTidalClient(env, config);
  console.log(`[cyberboss] tidal channel enabled: ${env.url} sender=${env.senderId}`);

  return {
    ...weixin,
    describe() {
      return { ...weixin.describe(), tidalRelay: env.url };
    },
    normalizeIncomingMessage(message) {
      if (message && message.__tidal) {
        const attachmentText = tidal.describeAttachments(message.attachments);
        const text = [String(message.text || "").trim(), attachmentText]
          .filter(Boolean)
          .join("\n");
        if (!text) {
          return null;
        }
        return {
          provider: "tidal",
          accountId: "tidal",
          workspaceId: config.workspaceId,
          senderId: env.senderId,
          chatId: env.senderId,
          messageId: String(message.id),
          threadKey: "tidal",
          text,
          attachments: [],
          contextToken: "tidal",
          receivedAt: message.ts || new Date().toISOString(),
        };
      }
      return weixin.normalizeIncomingMessage(message);
    },
    async sendText({ userId, text, contextToken = "", preserveBlock = false }) {
      if (isTidalUserId(userId)) {
        await tidal.sendReply(text);
        return;
      }
      await weixin.sendText({ userId, text, contextToken, preserveBlock });
    },
    async sendTyping(args) {
      if (isTidalUserId(args?.userId)) {
        return; // 中继自己管理输入中状态
      }
      await weixin.sendTyping(args);
    },
    async sendFile({ userId, filePath, contextToken = "" }) {
      if (isTidalUserId(userId)) {
        await tidal.sendFile(filePath);
        return;
      }
      return weixin.sendFile({ userId, filePath, contextToken });
    },
    startOutOfBand(onMessage) {
      tidal.start(onMessage);
    },
    stopOutOfBand() {
      tidal.stop();
    },
  };
}

module.exports = { createChannelAdapter, createTidalClient, readTidalEnv, isTidalUserId };
