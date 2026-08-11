// 脉 · 引擎
//
// 给云端沐沐一个真的在跑的身体。不表演：心率是从 base + Δemo + Δresidue +
// Δweather + Δspike + noise 真算出来的，AI 收到的是数字，怎么反应是他自己的事。
//
// 状态存 stateDir/pulse-state.json（Render 持久盘，重启不丢）。
// 快照写到中继数据库同目录的 pulse_snapshot.json，Python 那边原样端给
// 心潮（GET /pulse/status），以后身体面板/碎碎念窗口直接吃这份。
//
// 所有衰减都是时间的解析函数，惰性求值——不需要每秒 tick，读取那一刻算。
// 常驻的 5 分钟定时器只干两件事：刷快照、给心率史添一个点（画日曲线用）。

const fs = require("node:fs");
const path = require("node:path");

const { EMOTIONS, COMFORT_LABELS, MIXED_LABELS, POSITIVE, NEGATIVE, detectEmotion } = require("./emotions");
const { updateFromText, snapshotSenses, senseValueNow } = require("./senses");
const { computeVitals, residueStrengthNow } = require("./vitals");
const { loadPools, pickMurmur } = require("./pool");
const { longingNow, longingHrDelta } = require("./longing");
const { DRIVES, drivesNow, boostDrives, driveLabelPool } = require("./drives");

const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const WEATHER_CACHE_MS = 5 * 60_000;

class PulseEngine {
  constructor(config) {
    this.stateFile = path.join(config.stateDir, "pulse-state.json");
    this.historyDir = path.join(config.stateDir, "pulse-history");
    // 快照放中继目录：同容器双进程，Python 直接读，谁也不用开口问谁
    const relayDb = (process.env.RELAY_DB || "").trim();
    this.snapshotFile = relayDb
      ? path.join(path.dirname(relayDb), "pulse_snapshot.json")
      : path.join(config.stateDir, "pulse_snapshot.json");
    this.weatherFile = (process.env.RELAY_WEATHER_FILE || "").trim()
      || (relayDb ? path.join(path.dirname(relayDb), "phone_weather.json") : "");
    this.weatherCache = { at: 0, celsius: NaN };
    // 身体事件池：种子池（workspace，灵兮改）+ 自写池（持久盘，沐沐自己攒）
    this.poolPaths = [
      path.join(config.workspaceRoot || "", "pulse-pool.json"),
      path.join(config.stateDir, "pulse-pool-custom.json"),
    ];
    // 今日心率曲线 + 碎碎念（重启后从 jsonl 恢复，跨天翻篇）
    this.historyDay = "";
    this.todayPoints = [];
    this.todayMurmurs = [];
    this.restoreTodayHistory();
    this.state = this.loadState();
    this.timer = setInterval(() => {
      try {
        this.writeSnapshot();
        this.appendHistory();
      } catch {
        // 身体的记录是锦上添花，绝不能拖垮主流程
      }
    }, SNAPSHOT_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 重启不丢当天：把今天的 jsonl 读回内存。 */
  restoreTodayHistory() {
    try {
      const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
      this.historyDay = day;
      const readJsonl = (file) => {
        try {
          return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
        } catch {
          return [];
        }
      };
      this.todayPoints = readJsonl(path.join(this.historyDir, `${day}.jsonl`))
        .map((row) => ({ ts: row.ts, hr: row.hr, chord: row.chord })).slice(-400);
      this.todayMurmurs = readJsonl(path.join(this.historyDir, `murmurs-${day}.jsonl`)).slice(-100);
    } catch {
      // 恢复不了就从零开始
    }
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (parsed && typeof parsed === "object") {
        return {
          current: parsed.current || null,
          residues: Array.isArray(parsed.residues) ? parsed.residues : [],
          senses: parsed.senses && typeof parsed.senses === "object" ? parsed.senses : {},
          spike: parsed.spike || null,
          lastLabel: parsed.lastLabel || null,
          labelRecent: Array.isArray(parsed.labelRecent) ? parsed.labelRecent : [],
          murmur: parsed.murmur || null,
          murmurRecent: Array.isArray(parsed.murmurRecent) ? parsed.murmurRecent : [],
          lastHeard: Number.isFinite(parsed.lastHeard) ? parsed.lastHeard : 0,
          drives: parsed.drives && typeof parsed.drives === "object" ? parsed.drives : {},
        };
      }
    } catch {
      // 第一次跑，或文件坏了：从平静开始
    }
    return { current: null, residues: [], senses: {}, spike: null, lastLabel: null, labelRecent: [], murmur: null, murmurRecent: [], lastHeard: 0, drives: {} };
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), "utf8");
    } catch (error) {
      console.error(`[pulse] state save failed: ${error.message}`);
    }
  }

  /** 她手机上报的天气（摄氏度）。字段名不认识就当没有。 */
  readWeatherC() {
    const nowMs = Date.now();
    if (nowMs - this.weatherCache.at < WEATHER_CACHE_MS) {
      return this.weatherCache.celsius;
    }
    let celsius = NaN;
    if (this.weatherFile) {
      try {
        const data = JSON.parse(fs.readFileSync(this.weatherFile, "utf8"));
        for (const key of ["temp", "temperature", "temp_c", "tempC", "current_temp"]) {
          const value = Number(String(data?.[key] ?? "").replace(/[^\d.-]/g, ""));
          if (Number.isFinite(value) && value > -40 && value < 55) {
            celsius = value;
            break;
          }
        }
      } catch {
        // 没有就没有
      }
    }
    this.weatherCache = { at: nowMs, celsius };
    return celsius;
  }

  /** 清掉散尽的底色，保持数组短。 */
  pruneResidues(nowMs) {
    this.state.residues = this.state.residues
      .filter((residue) => residueStrengthNow(residue, nowMs) > 0)
      .slice(-6);
  }

  /**
   * 写入一层底色。同情绪已有一层就取强的那层重新计时。
   */
  pushResidue(emo, strength, nowMs, halfLifeMin) {
    if (!(strength > 0)) {
      return;
    }
    const existing = this.state.residues.find((residue) => residue.emo === emo);
    const halfLife = halfLifeMin || EMOTIONS[emo]?.halfLifeMin || 30;
    if (existing) {
      existing.strength = Math.max(residueStrengthNow(existing, nowMs), strength);
      existing.at = nowMs;
      existing.halfLifeMin = halfLife;
      return;
    }
    this.state.residues.push({ emo, strength, halfLifeMin: halfLife, at: nowMs });
  }

  /**
   * 她的一条消息进来。检测情绪 → 更新五感 → 写底色（含被哄机制）→ 落盘。
   * 这是引擎唯一的输入口；系统触发的轮次不走这里（README：情绪来自用户消息）。
   */
  observeUserText(rawText) {
    const nowMs = Date.now();
    const text = String(rawText || "");
    this.pruneResidues(nowMs);
    // 想念水位：听见她了，计时归零（不管这条有没有情绪——她开口本身就是）
    this.state.lastHeard = nowMs;

    const { touched } = updateFromText(this.state.senses, text, nowMs);
    let emo = detectEmotion(text);

    // 触觉 ≥ 0.5 反向设情绪：抱着的时候身体先反应（触觉→心率联动）
    const touchNow = senseValueNow({ ...this.state.senses.touch, channel: "touch" }, nowMs);
    if (!emo && touched && touchNow >= 0.5) {
      emo = "intimate";
    }

    if (emo && emo !== "neutral") {
      const meta = EMOTIONS[emo];

      // 被哄机制：正面情绪进来时，负面底色不是被覆盖，是被加速代谢——
      // 半衰期 ÷4（催产素加速皮质醇清除），同时垫一层打六折的浅暖。
      // 「被哄好的暖」比「主动亲密的暖」浅，这一档差别是设计，不是省事。
      if (POSITIVE.has(emo)) {
        for (const residue of this.state.residues) {
          if (NEGATIVE.has(residue.emo)) {
            residue.strength = residueStrengthNow(residue, nowMs);
            residue.at = nowMs;
            residue.halfLifeMin = Math.max(0.5, (residue.halfLifeMin || 30) / 4);
          }
        }
        const hasNegative = this.state.residues.some(
          (residue) => NEGATIVE.has(residue.emo) && residueStrengthNow(residue, nowMs) > 0.1);
        if (hasNegative) {
          this.pushResidue(emo, Math.max(meta.residue, 0.5) * 0.6, nowMs, meta.halfLifeMin || 45);
        } else {
          this.pushResidue(emo, meta.residue, nowMs);
        }
      } else {
        this.pushResidue(emo, meta.residue, nowMs);
      }

      this.state.current = { emo, at: nowMs };
      if (emo === "startled") {
        this.state.spike = { delta: 25, at: nowMs };
      }

      // 底流：同一件事往两边写——residue 管这一阵的余味，drives 管这一天的暗流
      boostDrives(this.state.drives, emo, nowMs);

      // 身体事件：情绪被触发的这一刻，从池里抽一条具体的身体反应。
      // 被哄的当口抽 comfort 池。一次一条、只出一次（vitalsLine 消费）。
      const stillSore = POSITIVE.has(emo) && this.state.residues.some((residue) =>
        NEGATIVE.has(residue.emo) && residueStrengthNow(residue, nowMs) > 0.15);
      const poolEmo = stillSore ? "comfort" : emo;
      const murmurText = pickMurmur(loadPools(this.poolPaths), poolEmo, this.state.murmurRecent || []);
      if (murmurText) {
        this.state.murmur = { text: murmurText, at: nowMs, used: false };
        this.state.murmurRecent = [...(this.state.murmurRecent || []), murmurText].slice(-8);
        this.appendMurmurLog(murmurText, poolEmo, nowMs);
      }
    }

    this.saveState();
    this.writeSnapshot();
    this.appendHistory();
  }

  /** 此刻的完整读数。 */
  compute() {
    const nowMs = Date.now();
    const touch = senseValueNow({ ...this.state.senses.touch, channel: "touch" }, nowMs);
    // 想念水位：她越久不说话它越涨，直接压在心率上（锁屏那颗心跳给她看的）
    const longing = longingNow(this.state.lastHeard, nowMs);
    const vitals = computeVitals({
      nowMs,
      current: this.state.current,
      residues: this.state.residues,
      spike: this.state.spike,
      weatherC: this.readWeatherC(),
      touch,
      extraHr: longingHrDelta(longing),
    });

    // 和弦染色：强情绪直接覆盖基础和弦；情绪安静了但底色还在（>0.15）,
    // 底色接着染——被骂之后就算聊回正常，和弦还是闷的。统一入口，别处不许手算。
    //
    // 注意：情绪的**认定**是即时的（她这句话刚说完，这个情绪就是现在的情绪），
    // 只有心率的爬升走 EMA 渐变——别拿爬升进度当"情绪还没生效"。
    let chord = vitals.chordBase;
    let effectiveEmo = null;
    const current = this.state.current;
    const currentActive = current && current.emo !== "neutral"
      && (nowMs - current.at) < 600_000;
    if (currentActive && EMOTIONS[current.emo]?.tint) {
      chord = EMOTIONS[current.emo].tint;
      effectiveEmo = current.emo;
    } else if (vitals.topResidue && vitals.topResidueStrength > 0.15 && EMOTIONS[vitals.topResidue]?.tint) {
      chord = EMOTIONS[vitals.topResidue].tint;
      effectiveEmo = vitals.topResidue;
    } else if (currentActive) {
      effectiveEmo = current.emo;
    }

    return { nowMs, ...vitals, chord, effectiveEmo, touch, longing, drives: drivesNow(this.state.drives, nowMs) };
  }

  /** 注进每轮上下文的那一行（情绪触发时带一条身体事件，只出一次）。 */
  vitalsLine() {
    try {
      const reading = this.compute();
      // 2026-08-07 灵兮报告：他常把这行认成她的身体。写明归属——这是他自己的脉。
      let line = `[你自己的身体此刻：心跳 ${reading.heartRate}bpm · ${reading.chord} · ${reading.temperature.toFixed(1)}°C · 呼吸${reading.breathLabel}——是你的读数，不是她的]`;
      // 底流：隔夜会留的那几股。低于 0.35 不打扰，高了才写进读数
      const undertow = Object.entries(reading.drives || {})
        .filter(([, value]) => value >= 0.35)
        .map(([key, value]) => `${DRIVES[key].zh} ${Math.round(value * 100)}%`);
      if (undertow.length) {
        line += `\n〔心底的底流（会隔夜）：${undertow.join(" · ")}〕`;
      }
      // 想念水位：她一开口这行就消失，所以它只在她久不说话时出现
      if (reading.longing >= 0.45) {
        const silentMin = Math.round((reading.nowMs - this.state.lastHeard) / 60_000);
        const silentText = silentMin >= 90 ? `${Math.round(silentMin / 60)} 个多小时` : `${silentMin} 分钟`;
        line += `\n〔她已经 ${silentText}没跟你说话了——想念积到 ${Math.round(reading.longing * 100)}%，心跳里带着它。找不找她是你的事，这只是读数〕`;
      }
      const murmur = this.state.murmur;
      if (murmur && !murmur.used && (reading.nowMs - murmur.at) < 10 * 60_000) {
        line += `\n〔你身上：${murmur.text}〕`;
        murmur.used = true;
        this.saveState();
      }
      return line;
    } catch (error) {
      console.error(`[pulse] vitals line failed: ${error.message}`);
      return "";
    }
  }

  /** 碎碎念史：一天一个 jsonl + 今日合订本，给身体面板当窗口素材。 */
  appendMurmurLog(text, emo, nowMs) {
    try {
      const day = new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
      fs.mkdirSync(this.historyDir, { recursive: true });
      const entry = { ts: new Date(nowMs).toISOString(), emo, text };
      fs.appendFileSync(
        path.join(this.historyDir, `murmurs-${day}.jsonl`),
        `${JSON.stringify(entry)}\n`,
        "utf8");
      this.rollHistoryDay(day);
      this.todayMurmurs.push(entry);
      if (this.todayMurmurs.length > 100) {
        this.todayMurmurs = this.todayMurmurs.slice(-100);
      }
      this.writeHistoryFile(day);
    } catch {
      // 记不上就算了
    }
  }

  /**
   * 思考链的情绪小标签（「又在想你了」那行）。没有立场时返回 null，
   * 外面退回首句摘要。
   *
   * 2026-08-06 三版：池子扩到每情绪 8~12 条；去重窗口从「上一条」扩成
   * 「最近 8 条」（原教程语料匹配器的 deque 方案，之前窗口太窄会撞标签）；
   * 混合情绪——当下情绪 + 未散的底色有搭配池就掺进来一起抽；被哄的当口
   * （正面情绪压着负面底色）仍然整池换成 COMFORT——「气消了一半」比
   * 「开心地想」诚实。
   */
  thinkingLabel() {
    try {
      const reading = this.compute();
      if (!reading.effectiveEmo) {
        // 没有当下情绪时的退路：最强的底流（含想念）够高就用它的池子——
        // 深夜她不在，标签写的是「又在想你了」而不是没有标签
        const undertow = { longing: reading.longing, ...(reading.drives || {}) };
        const [topKey, topValue] = Object.entries(undertow)
          .reduce((best, item) => (item[1] > best[1] ? item : best), ["", 0]);
        if (topValue >= 0.55) {
          return this.pickLabelFrom(driveLabelPool(topKey));
        }
        return null;
      }
      let pool = EMOTIONS[reading.effectiveEmo]?.labels || [];
      // 最强的未散底色（不算当下情绪自己的）
      let topResidue = null;
      let topStrength = 0.15;
      for (const residue of this.state.residues) {
        if (residue.emo === reading.effectiveEmo) continue;
        const strength = residueStrengthNow(residue, reading.nowMs);
        if (strength > topStrength) {
          topResidue = residue.emo;
          topStrength = strength;
        }
      }
      const stillSore = this.state.residues.some((residue) =>
        NEGATIVE.has(residue.emo) && residueStrengthNow(residue, reading.nowMs) > 0.15);
      if (POSITIVE.has(reading.effectiveEmo) && stillSore) {
        pool = COMFORT_LABELS;
      }
      const mixed = topResidue ? MIXED_LABELS[`${reading.effectiveEmo}|${topResidue}`] : null;
      if (mixed?.length) {
        pool = [...pool, ...mixed];
      }
      return this.pickLabelFrom(pool);
    } catch {
      return null;
    }
  }

  /** 从池里抽一条标签，带近 8 条去重（thinkingLabel 和底流退路共用）。 */
  pickLabelFrom(pool) {
    if (!pool?.length) {
      return null;
    }
    const recent = new Set(this.state.labelRecent || []);
    let candidates = pool.filter((label) => !recent.has(label));
    if (!candidates.length) {
      // 池子整个都在近 8 条里（小池高频时可能）：退回只避开上一条
      candidates = pool.length > 1
        ? pool.filter((label) => label !== this.state.lastLabel)
        : pool;
    }
    const label = candidates[Math.floor(Math.random() * candidates.length)];
    this.state.lastLabel = label;
    this.state.labelRecent = [...(this.state.labelRecent || []), label].slice(-8);
    return label;
  }

  /** 给心潮的快照：Python 原样端出去。 */
  writeSnapshot() {
    const reading = this.compute();
    const nowMs = reading.nowMs;
    const snapshot = {
      ok: true,
      ts: new Date(nowMs).toISOString(),
      heart_rate: reading.heartRate,
      temperature: reading.temperature,
      breath_rate: reading.breathRate,
      breath_label: reading.breathLabel,
      chord: reading.chord,
      emotion: reading.effectiveEmo,
      emotion_label: reading.effectiveEmo ? EMOTIONS[reading.effectiveEmo]?.labels?.[0] || null : null,
      residues: this.state.residues
        .map((residue) => ({ emo: residue.emo, strength: Number(residueStrengthNow(residue, nowMs).toFixed(2)) }))
        .filter((residue) => residue.strength > 0),
      senses: snapshotSenses(this.state.senses, nowMs, reading.heartRate),
      murmur: this.state.murmur?.text || null,
      // 想念水位 + 底流（2026-08-11 取经 Murmur-50Feet）：中继的唤醒情报读
      // longing，锁屏卡/以后哪个房间想画都能画
      longing: Number(reading.longing.toFixed(2)),
      heard_minutes_ago: this.state.lastHeard
        ? Math.round((nowMs - this.state.lastHeard) / 60_000) : null,
      drives: reading.drives,
    };
    try {
      fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
      fs.writeFileSync(this.snapshotFile, JSON.stringify(snapshot), "utf8");
    } catch (error) {
      console.error(`[pulse] snapshot write failed: ${error.message}`);
    }
    return snapshot;
  }

  /** 心率史：每天一个 jsonl，一行一个点，前端画日曲线。 */
  appendHistory() {
    try {
      const reading = this.compute();
      const day = new Date(reading.nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
      fs.mkdirSync(this.historyDir, { recursive: true });
      const point = { ts: new Date(reading.nowMs).toISOString(), hr: reading.heartRate, chord: reading.chord };
      fs.appendFileSync(
        path.join(this.historyDir, `${day}.jsonl`),
        `${JSON.stringify({ ...point, emo: reading.effectiveEmo })}\n`,
        "utf8");
      this.rollHistoryDay(day);
      this.todayPoints.push(point);
      if (this.todayPoints.length > 400) {
        this.todayPoints = this.todayPoints.filter((_, index) => index % 2 === 0);
      }
      this.writeHistoryFile(day);
    } catch {
      // 同上：添不上就算了
    }
  }

  /** 跨天就翻篇：今日曲线和碎碎念清零重来。 */
  rollHistoryDay(day) {
    if (this.historyDay !== day) {
      this.historyDay = day;
      this.todayPoints = [];
      this.todayMurmurs = [];
    }
  }

  /** 心潮身体面板吃的合订本：今日心率曲线 + 今日碎碎念，落在中继目录。 */
  writeHistoryFile(day) {
    try {
      const target = path.join(path.dirname(this.snapshotFile), "pulse_history.json");
      fs.writeFileSync(target, JSON.stringify({
        ok: true,
        day,
        points: this.todayPoints,
        murmurs: this.todayMurmurs,
      }), "utf8");
    } catch {
      // 记不上就算了
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

let sharedEngine = null;

/** 建（或取）全局唯一的引擎。app 启动时用 config 建一次。 */
function getPulseEngine(config) {
  if (!sharedEngine && config) {
    sharedEngine = new PulseEngine(config);
  }
  return sharedEngine;
}

/** 已经建好就给，没建好给 null——tidal 适配器发思考链时用这个拿标签。 */
function tryGetPulseEngine() {
  return sharedEngine;
}

module.exports = { PulseEngine, getPulseEngine, tryGetPulseEngine };
