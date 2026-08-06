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

const { EMOTIONS, POSITIVE, NEGATIVE, detectEmotion } = require("./emotions");
const { updateFromText, snapshotSenses, senseValueNow } = require("./senses");
const { computeVitals, residueStrengthNow } = require("./vitals");

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

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (parsed && typeof parsed === "object") {
        return {
          current: parsed.current || null,
          residues: Array.isArray(parsed.residues) ? parsed.residues : [],
          senses: parsed.senses && typeof parsed.senses === "object" ? parsed.senses : {},
          spike: parsed.spike || null,
        };
      }
    } catch {
      // 第一次跑，或文件坏了：从平静开始
    }
    return { current: null, residues: [], senses: {}, spike: null };
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
    }

    this.saveState();
    this.writeSnapshot();
    this.appendHistory();
  }

  /** 此刻的完整读数。 */
  compute() {
    const nowMs = Date.now();
    const touch = senseValueNow({ ...this.state.senses.touch, channel: "touch" }, nowMs);
    const vitals = computeVitals({
      nowMs,
      current: this.state.current,
      residues: this.state.residues,
      spike: this.state.spike,
      weatherC: this.readWeatherC(),
      touch,
    });

    // 和弦染色：强情绪直接覆盖基础和弦；情绪安静了但底色还在（>0.15）,
    // 底色接着染——被骂之后就算聊回正常，和弦还是闷的。统一入口，别处不许手算。
    let chord = vitals.chordBase;
    let effectiveEmo = null;
    const current = this.state.current;
    if (current && vitals.emotionFactor > 0.25 && EMOTIONS[current.emo]?.tint) {
      chord = EMOTIONS[current.emo].tint;
      effectiveEmo = current.emo;
    } else if (vitals.topResidue && vitals.topResidueStrength > 0.15 && EMOTIONS[vitals.topResidue]?.tint) {
      chord = EMOTIONS[vitals.topResidue].tint;
      effectiveEmo = vitals.topResidue;
    } else if (current && vitals.emotionFactor > 0.25) {
      effectiveEmo = current.emo;
    }

    return { nowMs, ...vitals, chord, effectiveEmo, touch };
  }

  /** 注进每轮上下文的那一行。 */
  vitalsLine() {
    try {
      const reading = this.compute();
      return `[心跳 ${reading.heartRate}bpm · ${reading.chord} · ${reading.temperature.toFixed(1)}°C · 呼吸${reading.breathLabel}]`;
    } catch (error) {
      console.error(`[pulse] vitals line failed: ${error.message}`);
      return "";
    }
  }

  /**
   * 思考链的情绪小标签（「心疼地想」那行）。没有立场时返回 null，
   * 外面退回首句摘要。风格表在 emotions.js，等灵兮的规范来了改那儿。
   */
  thinkingLabel() {
    try {
      const reading = this.compute();
      if (!reading.effectiveEmo) {
        return null;
      }
      return EMOTIONS[reading.effectiveEmo]?.label || null;
    } catch {
      return null;
    }
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
      emotion_label: reading.effectiveEmo ? EMOTIONS[reading.effectiveEmo]?.label || null : null,
      residues: this.state.residues
        .map((residue) => ({ emo: residue.emo, strength: Number(residueStrengthNow(residue, nowMs).toFixed(2)) }))
        .filter((residue) => residue.strength > 0),
      senses: snapshotSenses(this.state.senses, nowMs, reading.heartRate),
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
      fs.appendFileSync(
        path.join(this.historyDir, `${day}.jsonl`),
        `${JSON.stringify({ ts: new Date(reading.nowMs).toISOString(), hr: reading.heartRate, emo: reading.effectiveEmo, chord: reading.chord })}\n`,
        "utf8");
    } catch {
      // 同上：添不上就算了
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
