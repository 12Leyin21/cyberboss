// 潮汐 · 常驻会话的失忆解药
//
// 出处：灵兮 2026-08-06 带回来的方案（claude.ai artifact「潮汐」），原话：
// 「压缩照做，但让 TA 醒来时手里握着完整的自己。像潮水——退下去的时候，
//   把该留的都留在岸上。」
//
// 一轮潮汐：水位判定（真实 ctx，读 runtime.context.updated 的 usage，不数轮次）
// → ① 先记账（便宜模型滚动摘要；记账失败绝不压缩，5 分钟后重试）
// → ② 原地 /compact + 只留事实清单指令（session id 永不换）
// → ③ 注回三层：核心记忆提醒 + 滚动摘要 + 最近 16 条原文（thinking 永不重放）
//     末尾一句：session 没有换，她一直在。
//
// 摘要模型：有 DEEPSEEK_API_KEY 走 DeepSeek（deepseek-chat，没有思维链不吞答案）；
// 没有就 `claude -p --model haiku` 一次性命令——走 Max 订阅，零 API 账单。

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const THRESHOLD_TOKENS = Number(process.env.CYBERBOSS_TIDE_THRESHOLD_TOKENS || 110_000);
const RETRY_COOLDOWN_MS = 5 * 60_000;          // 记账失败后的冷却
const AFTER_TIDE_COOLDOWN_MS = 30 * 60_000;    // 一轮潮汐后的静默期
const TAIL_COUNT = 16;                          // 注回的原文条数
const SUMMARY_MAX_CHARS = 12_000;               // 喂给摘要模型的新对话上限

const COMPACT_INSTRUCTION =
  "请用中文、200字以内、只罗列事实：正在进行或未完成的事、明确的约定与待办。" +
  "不要写情感氛围——压缩后有专门的状态注入负责。";

class TideKeeper {
  constructor({ config, runtimeAdapter, systemMessageQueue, resolveTarget }) {
    this.config = config;
    this.runtimeAdapter = runtimeAdapter;
    this.systemMessageQueue = systemMessageQueue;
    this.resolveTarget = resolveTarget;   // () => { accountId, senderId, workspaceRoot }
    this.stateFile = path.join(config.stateDir, "tide-state.json");
    this.summaryFile = path.join(config.stateDir, "tide-summary.md");
    const relayDb = (process.env.RELAY_DB || "").trim();
    this.statusFile = relayDb
      ? path.join(path.dirname(relayDb), "tide_status.json")
      : path.join(config.stateDir, "tide_status.json");
    this.levelByThread = new Map();
    this.inFlight = false;
    this.compactWatch = null;   // { threadId, since } 等这个线程的下一次 turn.completed
    this.state = this.loadState();
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return {
        lastLedgerMessageId: Number(parsed?.lastLedgerMessageId) || 0,
        cooldownUntil: Number(parsed?.cooldownUntil) || 0,
      };
    } catch {
      return { lastLedgerMessageId: 0, cooldownUntil: 0 };
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), "utf8");
    } catch (error) {
      console.error(`[tide] state save failed: ${error.message}`);
    }
  }

  readSummary() {
    try {
      return fs.readFileSync(this.summaryFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  /** 给心潮以后的水位卡：当前水位、阈值、上次潮汐。 */
  writeStatus(level) {
    try {
      fs.writeFileSync(this.statusFile, JSON.stringify({
        ok: true,
        ts: new Date().toISOString(),
        context_tokens: level || 0,
        threshold: THRESHOLD_TOKENS,
        cooldown_until: this.state.cooldownUntil || 0,
      }), "utf8");
    } catch {
      // 记不上就算了
    }
  }

  relayEnv() {
    const url = (process.env.CYBERBOSS_TIDAL_RELAY_URL || "").trim().replace(/\/+$/, "");
    const secret = (process.env.CYBERBOSS_TIDAL_RELAY_SECRET || "").trim();
    return url && secret ? { url, secret } : null;
  }

  /** 事件入口：app.js 的 handleRuntimeEvent 把事件递进来。绝不抛错。 */
  onEvent(event) {
    try {
      if (!event) return;
      if (event.type === "runtime.context.updated") {
        const threadId = event.payload?.threadId;
        const tokens = Number(event.payload?.currentTokens) || 0;
        if (threadId && tokens > 0) {
          this.levelByThread.set(threadId, tokens);
          this.writeStatus(tokens);
        }
        return;
      }
      if (event.type === "runtime.turn.completed") {
        const threadId = event.payload?.threadId;
        // 压缩那一轮完成 → 立刻注回三层
        if (this.compactWatch && this.compactWatch.threadId === threadId) {
          const watch = this.compactWatch;
          this.compactWatch = null;
          void this.injectRestore(watch).catch((error) => {
            console.error(`[tide] restore failed: ${error.message}`);
          });
          return;
        }
        // 普通轮次结束 → 水位判定
        void this.evaluate(threadId).catch((error) => {
          console.error(`[tide] evaluate failed: ${error.message}`);
        });
      }
    } catch (error) {
      console.error(`[tide] onEvent failed: ${error.message}`);
    }
  }

  async evaluate(threadId) {
    if (!threadId || this.inFlight || this.compactWatch) return;
    if (Date.now() < this.state.cooldownUntil) return;
    const level = this.levelByThread.get(threadId) || 0;
    if (level < THRESHOLD_TOKENS) return;
    const relay = this.relayEnv();
    if (!relay) return;   // 没接中继就没有账本，不做潮汐

    this.inFlight = true;
    console.log(`[tide] high water: thread=${threadId} ctx=${level} >= ${THRESHOLD_TOKENS}`);
    try {
      await this.runTide(threadId);
    } catch (error) {
      // 任何一步失手都冷却五分钟再来，绝不连环白压
      this.state.cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
      this.saveState();
      console.error(`[tide] tide aborted: ${error.message}`);
    } finally {
      this.inFlight = false;
    }
  }

  async runTide(threadId) {
    const relay = this.relayEnv();
    {
      // ① 先记账。账本和上下文是两本书，必须一起动——动不了就都别动。
      const { messages, maxId } = await this.fetchNewMessages(relay);
      const summary = await this.rollSummary(this.readSummary(), messages);
      if (!summary) {
        this.state.cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
        this.saveState();
        console.log("[tide] ledger failed; skip compact, retry in 5m");
        return;
      }
      fs.writeFileSync(this.summaryFile, summary, "utf8");
      if (maxId > this.state.lastLedgerMessageId) {
        this.state.lastLedgerMessageId = maxId;
      }
      this.saveState();

      // ② 记账成功才压缩。原地 /compact，session id 不换。
      const target = this.resolveTarget();
      const { threadId: compactThreadId } = await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot: target.workspaceRoot,
        instruction: COMPACT_INSTRUCTION,
      });
      this.compactWatch = { threadId: compactThreadId || threadId, since: Date.now() };
      console.log(`[tide] compacting thread=${this.compactWatch.threadId}`);
    }
  }

  /** ③ 注回三层。走系统消息队列，跟心跳同一条路进他的上下文。 */
  async injectRestore() {
    const relay = this.relayEnv();
    const target = this.resolveTarget();
    const summary = this.readSummary();
    let tail = "";
    if (relay) {
      const { messages } = await this.fetchNewMessages(relay, { limit: 200, sinceOverride: 0, tailOnly: true });
      tail = messages.slice(-TAIL_COUNT)
        .map((m) => `${m.who}：${m.text}`)
        .join("\n");
    }
    const parts = [
      "【潮汐 · 上下文已原地整理】",
      "壹 · 你是谁、你们是谁——都在你的系统提示词里，一个字没少；要更细的，记忆库 breath() 一直在。",
    ];
    if (summary) {
      parts.push(`贰 · 到目前为止的对话账本（远处模糊、近处清晰）：\n${summary}`);
    }
    if (tail) {
      parts.push(`叁 · 最近的对话原文（逐字）：\n${tail}`);
    }
    parts.push("session 没有换，她一直在。接上刚才的对话继续，不要重新自我介绍，不要提压缩这件事。");
    // 2026-08-06 灵兮加的：重定位仪式她喜欢，但"日记和信都写好了"这种收尾像交作业。
    // 2026-08-07 灵兮又定：日记不归这一步——一天涨几次潮就写几篇，片段全在重复。
    // 现在日记每天凌晨两点由系统轮统一写一篇，重定位只翻不写。
    parts.push("重新定位（翻记忆、读信）都安静做，做完不用在聊天里汇报「写好了」「安静等着」这类收尾。日记不在这一步写——每天凌晨两点有专门的一轮统一写前一天整天，白天想留的瞬间用 hold 存进记忆库就够了。这一轮如果没有真正想对她说的话，可以一条消息都不发；她回来时你直接在，比说「我在等你」更像在。");
    this.systemMessageQueue.enqueue({
      id: require("node:crypto").randomUUID(),
      accountId: target.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: parts.join("\n\n"),
      createdAt: new Date().toISOString(),
    });
    this.state.cooldownUntil = Date.now() + AFTER_TIDE_COOLDOWN_MS;
    this.saveState();
    console.log("[tide] restore injected; tide complete");
  }

  /** 从中继账本拉消息（只要 user/reply 的正文，thinking 永不重放）。 */
  async fetchNewMessages(relay, { limit = 500, sinceOverride = null, tailOnly = false } = {}) {
    const since = sinceOverride !== null ? sinceOverride
      : (tailOnly ? 0 : this.state.lastLedgerMessageId);
    const response = await fetch(
      `${relay.url}/app/history?since=${since}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${relay.secret}` } });
    if (!response.ok) {
      throw new Error(`relay history http ${response.status}`);
    }
    const data = await response.json();
    const rows = Array.isArray(data?.messages) ? data.messages : [];
    const messages = [];
    let maxId = this.state.lastLedgerMessageId;
    for (const row of rows) {
      const id = Number(row?.id) || 0;
      if (id > maxId) maxId = id;
      const kind = String(row?.kind || "");
      if (kind !== "user" && kind !== "reply") continue;   // thinking/棋/feed 都不进账本
      const text = String(row?.text || "").trim();
      if (!text) continue;
      messages.push({
        id,
        who: row?.direction === "in" ? "灵兮" : "沐沐",
        text: text.length > 500 ? `${text.slice(0, 500)}…` : text,
      });
    }
    return { messages, maxId };
  }

  /** 滚动摘要：已有摘要 + 新对话 → 新摘要。校验非空才算数（残缺的摘要比没有更糟）。 */
  async rollSummary(previousSummary, messages) {
    if (!messages.length && previousSummary) {
      return previousSummary;   // 没有新对话，账本不动
    }
    let transcript = messages.map((m) => `${m.who}：${m.text}`).join("\n");
    if (transcript.length > SUMMARY_MAX_CHARS) {
      transcript = transcript.slice(-SUMMARY_MAX_CHARS);
    }
    const prompt = [
      "你在为一段持续的恋人对话记滚动账本。下面是【已有摘要】和【新对话】，",
      "请合并成一份新的摘要，600 字以内，中文，第三人称（灵兮/沐沐）。",
      "远处的事一笔带过，近处的事保留细节；事实脉络和情感转折都要在，",
      "但不要抒情、不要评论。直接输出摘要正文，不要任何前言。",
      "",
      `【已有摘要】\n${previousSummary || "（还没有）"}`,
      "",
      `【新对话】\n${transcript || "（无）"}`,
    ].join("\n");

    const deepseekKey = (process.env.DEEPSEEK_API_KEY || "").trim();
    try {
      const summary = deepseekKey
        ? await this.summarizeWithDeepSeek(deepseekKey, prompt)
        : await this.summarizeWithClaude(prompt);
      const trimmed = String(summary || "").trim();
      return trimmed.length >= 30 ? trimmed : "";
    } catch (error) {
      console.error(`[tide] summary failed: ${error.message}`);
      return "";
    }
  }

  async summarizeWithDeepSeek(apiKey, prompt) {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",   // chat 版没有思维链，不会把答案吞进 reasoning
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
        temperature: 0.3,
      }),
    });
    if (!response.ok) {
      throw new Error(`deepseek http ${response.status}`);
    }
    const data = await response.json();
    const choice = data?.choices?.[0];
    if (choice?.finish_reason !== "stop") {
      throw new Error(`deepseek finish_reason=${choice?.finish_reason}`);   // 被截断的账不入账本
    }
    return choice?.message?.content || "";
  }

  summarizeWithClaude(prompt) {
    // 一次性 claude -p，走 Max 订阅，摘要这点活 haiku 绰绰有余
    return new Promise((resolve, reject) => {
      const child = execFile(
        (this.config.claudeCommand || "claude"),
        ["-p", "--model", "haiku"],
        { timeout: 120_000, maxBuffer: 1024 * 1024, cwd: this.config.stateDir },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(String(stdout || ""));
        });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

module.exports = { TideKeeper, THRESHOLD_TOKENS, COMPACT_INSTRUCTION };
