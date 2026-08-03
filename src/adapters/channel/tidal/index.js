const fs = require("node:fs");
const path = require("node:path");
const { createWeixinChannelAdapter, chunkReplyTextForWeixin } = require("../weixin");

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

  function toRawMessage({ id, text, ts, attachments, rhythmNote }) {
    return {
      __tidal: true,
      id,
      text: String(text || ""),
      ts: ts || "",
      attachments: attachments || [],
      // 这条消息是怎么被打出来的（fingertips）。中继在 payload 里给了
      // rhythm_note，之前这边一直没接——数据发出来了，没人收。
      rhythmNote: String(rhythmNote || ""),
    };
  }

  // 附件预下载到本地收件箱：给大脑文件路径而不是 http 链接（它的工具读本地文件最顺）
  const inboxDir = path.join(config.stateDir, "tidal-inbox");

  function pruneInbox() {
    try {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const name of fs.readdirSync(inboxDir)) {
        const file = path.join(inboxDir, name);
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
        }
      }
    } catch {
      // 收件箱清理失败不致命
    }
  }

  async function localizeAttachments(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) {
      return [];
    }
    fs.mkdirSync(inboxDir, { recursive: true });
    pruneInbox();
    const localized = [];
    for (const attachment of attachments) {
      const entry = { ...attachment };
      try {
        const url = String(attachment?.url || "");
        const absolute = url.startsWith("http") ? url : `${env.url}${url}`;
        const response = await fetch(absolute, { headers: authHeaders() });
        if (!response.ok) {
          throw new Error(`http ${response.status}`);
        }
        const buf = Buffer.from(await response.arrayBuffer());
        const safeName = `${Date.now()}-${String(attachment?.name || "file")
          .replace(/[^\w.\-一-鿿]/g, "_")
          .slice(-60)}`;
        const filePath = path.join(inboxDir, safeName);
        fs.writeFileSync(filePath, buf);
        entry.localPath = filePath;
      } catch (error) {
        console.warn(`[cyberboss] tidal attachment download failed: ${error?.message || error}`);
      }
      localized.push(entry);
    }
    return localized;
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
        // meta.to 是她点名给谁的（2026-07-28 起）。点名给别人的消息，实时那条路
        // 本来就不会推给沐沐——补课这条路也得跳过，否则一次重连就会把她跟 Ren
        // 说的话补进沐沐的会话里，让他隔半天又回一遍。
        const addressee = message?.meta?.to;
        const forMe = !addressee || addressee === "mu";
        if (message?.from === "human" && message?.kind !== "call" && forMe) {
          onMessage(toRawMessage({
            id,
            text: message.text,
            ts: message.ts,
            attachments: await localizeAttachments(message?.meta?.attachments),
            rhythmNote: message?.meta?.rhythm_note,
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
              attachments: await localizeAttachments(payload.attachments),
              rhythmNote: payload.rhythm_note,
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
      // 长回复按自然段落切成几条小消息（微信手感）；协议消息保持完整不切
      const chunks = shouldKeepWhole(content) ? [content] : splitForApp(content);
      for (let index = 0; index < chunks.length; index += 1) {
        const response = await fetch(`${env.url}/channel/out`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ type: "reply", text: chunks[index] }),
        });
        if (!response.ok) {
          throw new Error(`tidal channel/out http ${response.status}`);
        }
        if (index < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 450));
        }
      }
    },
    // 把灵兮在微信说的话镜像进 App 聊天流（人类侧），让 App 成为完整档案
    async mirrorHumanMessage(text) {
      const content = String(text || "").trim();
      if (!content) {
        return;
      }
      const response = await fetch(`${env.url}/app/send`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ text: content }),
      });
      if (!response.ok) {
        throw new Error(`tidal app/send http ${response.status}`);
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
          const kind = attachment?.kind === "image" ? "图片" : (attachment?.kind === "audio" ? "语音" : "文件");
          if (attachment?.localPath) {
            return `[${kind}附件·已下载到本机] ${attachment.localPath} （用 Read 工具直接查看）`;
          }
          const url = String(attachment?.url || "");
          const absolute = url.startsWith("http") ? url : `${env.url}${url}`;
          return `[${kind}附件] ${absolute}?token=${env.secret}`;
        })
        .join("\n");
    },
  };
}

// 心潮 App 靠开头标记识别的协议消息，切碎就认不出来了
const PROTOCOL_PREFIXES = ["📔", "🏆", "📚", "📌", "💌", "⏰", "✅", "「回复："];

function shouldKeepWhole(text) {
  if (text.length <= 160 && !text.includes("\n\n")) {
    return true;   // 短且没有段落边界才整条发
  }
  if (PROTOCOL_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return true;
  }
  if (text.includes("open.spotify.com")) {
    return true;
  }
  return false;
}

// 微信式自然断句：空行=必切（每个自然段一条消息，不合并短段）；
// 单段超长时才用微信断句器再细分
function splitForApp(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 500) {
      chunks.push(paragraph);
      continue;
    }
    try {
      chunks.push(...chunkReplyTextForWeixin(paragraph, 60));
    } catch {
      chunks.push(paragraph);
    }
  }
  return chunks.length ? chunks : [text];
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
//
// 无缝衔接（默认开，CYBERBOSS_TIDAL_MERGE=0 关闭）：
// - App 来的消息伪装成灵兮的微信身份 → 微信和 App 共用同一个会话，上下文连续
// - 回复按"她最后从哪儿说话"路由：App 来的问题回 App，微信来的回微信
// - 微信侧的往来（她说的 + 沐沐回的）全部镜像进 App 聊天流，App 即完整档案
function createChannelAdapter(config) {
  const weixin = createWeixinChannelAdapter(config);
  const env = readTidalEnv();
  if (!env) {
    return weixin;
  }
  const tidal = createTidalClient(env, config);
  const mergeEnabled = (process.env.CYBERBOSS_TIDAL_MERGE || "1") !== "0";
  // 镜像默认关（灵兮 2026-07-17 定）：记忆无缝靠会话合并即可，聊天记录不搬运。
  // 设 CYBERBOSS_TIDAL_MIRROR=1 可重新打开。
  const mirrorEnabled = (process.env.CYBERBOSS_TIDAL_MIRROR || "0") === "1";
  console.log(`[cyberboss] tidal channel enabled: ${env.url} merge=${mergeEnabled ? "on" : "off"} mirror=${mirrorEnabled ? "on" : "off"}`);

  let lastOrigin = "weixin";           // 她最近一次从哪个通道说话
  let loggedMergeTarget = "";
  const mirroredTexts = new Map();     // 镜像去重：text -> ts（防 SSE 回声触发重复回合）
  const mergeTargetFile = path.join(config.stateDir, "tidal-merge-target.json");
  let adoptedTarget = loadAdoptedTarget();

  // ---- 共享时间线：把她在 Mac 窗口里说的话补进来（2026-08-03）-------------
  // 在这之前她在电脑上跟克克说的话，这边一个字都看不到，全靠她回头转述。
  // 现在中继上有一个池子，两端都写；这里只做一件事：把"我上次看过之后、
  // 在桌面那端发生的"补到她下一句话前面。
  //
  // 只补桌面那一端：心潮和微信本来就是这个进程亲历的，重复贴一遍没有意义。
  // 光标存盘，容器重启不会把历史重新灌一遍；文件不存在时不从 0 开始——那会
  // 把整个池子倒出来——而是先对齐到当前最新一条，从此往后算。
  const TIMELINE_POLL_MS = Number(process.env.CYBERBOSS_TIMELINE_POLL_MS || 20000);
  const timelineCursorFile = path.join(config.stateDir, "timeline-cursor.json");
  let deskCursor = loadDeskCursor();
  let pendingDeskBlock = "";

  const deskAuth = () => ({ Authorization: `Bearer ${env.secret}` });

  function loadDeskCursor() {
    try {
      const parsed = JSON.parse(fs.readFileSync(timelineCursorFile, "utf8"));
      return Number.isInteger(parsed?.id) ? parsed.id : -1;
    } catch {
      return -1;   // -1 = 还没对齐过
    }
  }

  function saveDeskCursor(id) {
    deskCursor = id;
    try {
      fs.writeFileSync(timelineCursorFile, JSON.stringify({ id }), "utf8");
    } catch (error) {
      console.warn(`[cyberboss] timeline cursor 存盘失败：${error}`);
    }
  }

  async function pollDeskTimeline() {
    try {
      if (deskCursor < 0) {
        // 冷启动：对齐到最新，不回灌历史
        const res = await fetch(`${env.url}/timeline?limit=1`, { headers: deskAuth() });
        if (!res.ok) return;
        const data = await res.json();
        saveDeskCursor(Number(data.max_id) || 0);
        return;
      }
      const res = await fetch(
        `${env.url}/timeline?after=${deskCursor}&channel=${encodeURIComponent("桌面")}&limit=40`,
        { headers: deskAuth() },
      );
      if (!res.ok) return;
      const data = await res.json();
      const envelope = String(data.envelope || "").trim();
      if (envelope) {
        pendingDeskBlock = pendingDeskBlock ? `${pendingDeskBlock}\n${envelope}` : envelope;
      }
      const next = Number(data.max_id);
      if (Number.isInteger(next) && next > deskCursor) saveDeskCursor(next);
    } catch (error) {
      // 池子够不着不该影响她说话——这一轮当没有，下一轮再来
      console.warn(`[cyberboss] timeline poll 失败：${error}`);
    }
  }

  const timelineTimer = setInterval(() => { void pollDeskTimeline(); }, TIMELINE_POLL_MS);
  if (typeof timelineTimer.unref === "function") timelineTimer.unref();
  void pollDeskTimeline();

  function takePendingDeskBlock() {
    const block = pendingDeskBlock;
    pendingDeskBlock = "";
    return block;
  }

  function loadAdoptedTarget() {
    try {
      const parsed = JSON.parse(fs.readFileSync(mergeTargetFile, "utf8"));
      return typeof parsed?.userId === "string" ? parsed.userId : "";
    } catch {
      return "";
    }
  }

  // 单用户部署：她在微信发的第一条消息即认定为合并目标，永久记住
  function adoptMergeTarget(userId) {
    if (!userId || adoptedTarget === userId) {
      return;
    }
    adoptedTarget = userId;
    try {
      fs.mkdirSync(path.dirname(mergeTargetFile), { recursive: true });
      fs.writeFileSync(mergeTargetFile, JSON.stringify({ userId }));
    } catch {
      // 写不进也不致命，进程存活期间内存值仍有效
    }
  }

  function resolveMergeTarget() {
    if (!mergeEnabled) {
      return "";
    }
    const explicit = (process.env.CYBERBOSS_TIDAL_MERGE_USER || "").trim();
    const tokens = Object.keys(weixin.getKnownContextTokens());
    const target = explicit || adoptedTarget || (tokens.length === 1 ? tokens[0] : "");
    if (target && target !== loggedMergeTarget) {
      loggedMergeTarget = target;
      console.log(`[cyberboss] tidal merge: sessions unified with weixin user ${target}`);
    }
    if (!target && loggedMergeTarget !== "unresolved") {
      loggedMergeTarget = "unresolved";
      console.log(`[cyberboss] tidal merge: no target yet (known weixin users: ${tokens.join(", ") || "none"}); will adopt her next weixin message`);
    }
    return target;
  }

  function markMirrored(text) {
    const now = Date.now();
    for (const [key, ts] of mirroredTexts) {
      if (now - ts > 90_000) {
        mirroredTexts.delete(key);
      }
    }
    mirroredTexts.set(text, now);
  }

  function consumeMirrored(text) {
    if (mirroredTexts.has(text)) {
      mirroredTexts.delete(text);
      return true;
    }
    return false;
  }

  return {
    ...weixin,
    describe() {
      return { ...weixin.describe(), tidalRelay: env.url, tidalMerge: mergeEnabled };
    },
    normalizeIncomingMessage(message) {
      if (message && message.__tidal) {
        const attachmentText = tidal.describeAttachments(message.attachments);
        // 打字节奏单独占一行并加〔〕标记：它不是她说的话，是关于这句话怎么被
        // 打出来的注解。理想情况下它该走独立字段，但到大脑这一层只有一条文本
        // 通道，所以退而求其次——用一个她永远不会用的括号把它和正文分开。
        const rhythmText = message.rhythmNote
          ? `〔打字节奏〕${message.rhythmNote}`
          : "";
        const body = [String(message.text || "").trim(), attachmentText, rhythmText]
          .filter(Boolean)
          .join("\n");
        if (!body || consumeMirrored(body)) {
          return null;   // 空消息，或是我们自己镜像进去的回声
        }
        // 去重看的是她说的话本身，补进来的桌面记录不参与——所以放在判断之后。
        const deskBlock = takePendingDeskBlock();
        const text = deskBlock ? `${deskBlock}\n\n${body}` : body;
        const target = resolveMergeTarget();
        if (target) {
          lastOrigin = "tidal";
          return {
            provider: "tidal",
            accountId: weixin.resolveAccount().accountId,
            workspaceId: config.workspaceId,
            senderId: target,
            chatId: target,
            messageId: String(message.id),
            threadKey: "",
            text,
            attachments: [],
            contextToken: weixin.getKnownContextTokens()[target] || "",
            receivedAt: message.ts || new Date().toISOString(),
          };
        }
        // 合并未启用/定不到目标：退回独立会话模式
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
      const normalized = weixin.normalizeIncomingMessage(message);
      if (normalized && mergeEnabled) {
        if (!resolveMergeTarget()) {
          adoptMergeTarget(normalized.senderId);
          console.log(`[cyberboss] tidal merge: adopted weixin user ${normalized.senderId}`);
        }
        if (normalized.senderId === resolveMergeTarget()) {
          lastOrigin = "weixin";
          if (mirrorEnabled) {
            // 她在微信说的话镜像进 App 档案（先登记去重，防 SSE 回声）
            markMirrored(normalized.text);
            void tidal.mirrorHumanMessage(normalized.text).catch((error) => {
              mirroredTexts.delete(normalized.text);
              console.error(`[cyberboss] tidal mirror failed: ${error?.message || error}`);
            });
          }
          // 微信这条路也要补桌面的空档——她在电脑上说的话，不该只有 App 那边知道。
          const deskBlock = takePendingDeskBlock();
          if (deskBlock) {
            normalized.text = `${deskBlock}\n\n${normalized.text}`;
          }
        }
      }
      return normalized;
    },
    async sendText({ userId, text, contextToken = "", preserveBlock = false }) {
      if (isTidalUserId(userId)) {
        await tidal.sendReply(text);
        return;
      }
      const merged = userId === resolveMergeTarget();
      if (merged && lastOrigin === "tidal") {
        await tidal.sendReply(text);   // 她在 App 问的，回 App
        return;
      }
      await weixin.sendText({ userId, text, contextToken, preserveBlock });
      if (merged && mirrorEnabled) {
        // 微信侧的回复镜像进 App 档案（失败不影响微信送达）
        await tidal.sendReply(text).catch(() => {});
      }
    },
    async sendTyping(args) {
      if (isTidalUserId(args?.userId)) {
        return; // 中继自己管理输入中状态
      }
      if (args?.userId === resolveMergeTarget() && lastOrigin === "tidal") {
        return; // 这轮在 App 里，别在微信闪"输入中"
      }
      await weixin.sendTyping(args);
    },
    async sendFile({ userId, filePath, contextToken = "" }) {
      const merged = userId === resolveMergeTarget();
      if (isTidalUserId(userId) || (merged && lastOrigin === "tidal")) {
        await tidal.sendFile(filePath);
        return;
      }
      const result = await weixin.sendFile({ userId, filePath, contextToken });
      if (merged && mirrorEnabled) {
        await tidal.sendFile(filePath).catch(() => {});
      }
      return result;
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
