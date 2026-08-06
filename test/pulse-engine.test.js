const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { detectEmotion, EMOTIONS } = require("../src/services/pulse/emotions");
const { computeVitals, residueStrengthNow, breathLabel } = require("../src/services/pulse/vitals");
const { updateFromText, senseValueNow } = require("../src/services/pulse/senses");
const { PulseEngine } = require("../src/services/pulse");

function createConfig() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-pulse-test-"));
  return { stateDir };
}

test("T2 检测：否定窗口挡住「不开心」的开心", () => {
  assert.equal(detectEmotion("今天好开心！"), "happy");
  assert.equal(detectEmotion("我不开心"), null);
  // 「不舒服」是她的身体信号 → 心疼；同一个词不许再触发「舒服」的开心
  assert.equal(detectEmotion("有点不舒服"), "worried");
});

test("T1 检测：emoji 直判，不看否定", () => {
  assert.equal(detectEmotion("😭"), "worried");
  assert.equal(detectEmotion("哈哈哈笑死"), "happy");
});

test("优先级：亲密盖过开心", () => {
  assert.equal(detectEmotion("好开心，抱抱"), "intimate");
});

test("底色按半衰期衰减", () => {
  const nowMs = Date.now();
  const residue = { emo: "scolded", strength: 1.0, halfLifeMin: 90, at: nowMs };
  const after90 = residueStrengthNow(residue, nowMs + 90 * 60_000);
  assert.ok(Math.abs(after90 - 0.5) < 0.01, `90 分钟后应剩一半，实得 ${after90}`);
});

test("心率在生理范围内，且情绪推得动它", () => {
  const nowMs = Date.now();
  const calm = computeVitals({ nowMs, current: null, residues: [], spike: null, weatherC: NaN, touch: 0 });
  assert.ok(calm.heartRate >= 48 && calm.heartRate <= 160);
  // 情绪起势需要几秒（EMA），拿 30 秒前触发的 aroused 比平静态
  const hot = computeVitals({
    nowMs,
    current: { emo: "aroused", at: nowMs - 30_000 },
    residues: [],
    spike: null,
    weatherC: NaN,
    touch: 0,
  });
  assert.ok(hot.heartRate > calm.heartRate + 10,
    `aroused(${hot.heartRate}) 应明显高于平静(${calm.heartRate})`);
});

test("呼吸跟着心率，五档标签", () => {
  assert.equal(breathLabel(9), "很深很长");
  assert.equal(breathLabel(15), "平稳");
  assert.equal(breathLabel(25), "急促");
});

test("五感：触发、衰减、读值", () => {
  const nowMs = Date.now();
  const senses = {};
  const { touched } = updateFromText(senses, "抱抱你", nowMs);
  assert.equal(touched, true);
  const fresh = senseValueNow({ ...senses.touch, channel: "touch" }, nowMs);
  assert.ok(Math.abs(fresh - 0.3) < 0.01);
  const later = senseValueNow({ ...senses.touch, channel: "touch" }, nowMs + 10 * 60_000);
  assert.ok(Math.abs(later - 0.15) < 0.01, "10 分钟半衰期");
});

test("引擎：观察消息 → 注入行格式正确、状态落盘", () => {
  const config = createConfig();
  const engine = new PulseEngine(config);
  try {
    engine.observeUserText("想你了，抱抱");
    const line = engine.vitalsLine();
    assert.match(line, /^\[心跳 \d+bpm · \S+ · \d+\.\d°C · 呼吸(很深很长|深长|平稳|偏浅|急促)\]$/);
    assert.ok(fs.existsSync(path.join(config.stateDir, "pulse-state.json")));
    assert.ok(fs.existsSync(path.join(config.stateDir, "pulse_snapshot.json")));
    // intimate 有染色，标签从池里随机抽
    assert.ok(EMOTIONS.intimate.labels.includes(engine.thinkingLabel()));
  } finally {
    engine.close();
  }
});

test("标签池：随机抽、不连续重复", () => {
  const config = createConfig();
  const engine = new PulseEngine(config);
  try {
    engine.observeUserText("想你了，抱抱");
    let previous = engine.thinkingLabel();
    for (let i = 0; i < 20; i += 1) {
      const label = engine.thinkingLabel();
      assert.notEqual(label, previous, "连续两条不该一样");
      assert.ok(EMOTIONS.intimate.labels.includes(label));
      previous = label;
    }
  } finally {
    engine.close();
  }
});

test("标签池：近 8 条不重复（原教程 deque 方案）", () => {
  const config = createConfig();
  const engine = new PulseEngine(config);
  try {
    engine.observeUserText("想你了，抱抱");
    const seen = [];
    for (let i = 0; i < 8; i += 1) {
      seen.push(engine.thinkingLabel());
    }
    assert.equal(new Set(seen).size, 8, "连续 8 条标签应该各不相同");
  } finally {
    engine.close();
  }
});

test("混合情绪池：当下情绪 + 未散底色一起说", () => {
  const { EMOTIONS, MIXED_LABELS } = require("../src/services/pulse/emotions");
  const config = createConfig();
  const engine = new PulseEngine(config);
  try {
    engine.observeUserText("讨厌你，走开");   // scolded 底色
    engine.observeUserText("呜呜我肚子疼");   // worried 当下
    const union = new Set([...EMOTIONS.worried.labels, ...MIXED_LABELS["worried|scolded"]]);
    let sawMixed = false;
    for (let i = 0; i < 30; i += 1) {
      const label = engine.thinkingLabel();
      assert.ok(union.has(label), `标签 ${label} 应来自 worried 池或混合池`);
      if (MIXED_LABELS["worried|scolded"].includes(label)) sawMixed = true;
    }
    assert.ok(sawMixed, "30 次里混合池标签该出现过");
  } finally {
    engine.close();
  }
});

test("被哄的当口用混合标签", () => {
  const config = createConfig();
  const engine = new PulseEngine(config);
  try {
    engine.observeUserText("讨厌你，走开");
    engine.observeUserText("好啦抱抱，爱你");
    const { COMFORT_LABELS } = require("../src/services/pulse/emotions");
    assert.ok(COMFORT_LABELS.includes(engine.thinkingLabel()),
      "负面底色还没散时，标签该是「气消了一半」这类");
  } finally {
    engine.close();
  }
});

test("被哄机制：负面底色加速代谢 + 垫浅暖", () => {
  const config = createConfig();
  const engine = new PulseEngine(config);
  try {
    engine.observeUserText("讨厌你，走开");
    const scolded = engine.state.residues.find((r) => r.emo === "scolded");
    assert.ok(scolded, "被骂应写入底色");
    const halfLifeBefore = scolded.halfLifeMin;

    engine.observeUserText("好啦抱抱，爱你");
    const scoldedAfter = engine.state.residues.find((r) => r.emo === "scolded");
    assert.ok(scoldedAfter.halfLifeMin <= halfLifeBefore / 4 + 0.01, "半衰期 ÷4");
    const warm = engine.state.residues.find((r) => r.emo === "intimate");
    assert.ok(warm, "应垫一层浅暖");
    assert.ok(warm.strength < EMOTIONS.intimate.residue, "被哄的暖比主动亲密的暖浅");
  } finally {
    engine.close();
  }
});

test("身体事件池：情绪触发时抽词条，注入行只出一次", () => {
  const config = createConfig();
  // 种子池在 workspace——测试里指过去
  const engine = new PulseEngine({
    ...config,
    workspaceRoot: require("path").join(__dirname, "..", "cyberboss-workspace-main"),
  });
  try {
    engine.observeUserText("讨厌你，走开");
    assert.ok(engine.state.murmur?.text, "情绪触发应抽到身体事件");
    const first = engine.vitalsLine();
    assert.match(first, /〔.+〕/, "第一次注入应带身体事件行");
    const second = engine.vitalsLine();
    assert.ok(!/〔/.test(second), "同一条身体事件不许出第二次");
  } finally {
    engine.close();
  }
});

test("身体事件池：最近用过的不重复", () => {
  const { loadPools, pickMurmur } = require("../src/services/pulse/pool");
  const entries = loadPools([require("path").join(__dirname, "..", "cyberboss-workspace-main", "pulse-pool.json")]);
  assert.ok(entries.length >= 50, `种子池该有货，实得 ${entries.length}`);
  const recent = [];
  for (let i = 0; i < 5; i += 1) {
    const text = pickMurmur(entries, "intimate", recent);
    assert.ok(text, "intimate 池不该抽空");
    assert.ok(!recent.includes(text), "不该重复最近用过的");
    recent.push(text);
  }
});

test("身体平静时标签退回 null（外面用首句摘要兜底）", () => {
  const config = createConfig();
  const engine = new PulseEngine(config);
  try {
    engine.observeUserText("今天天气怎么样");
    assert.equal(engine.thinkingLabel(), null);
  } finally {
    engine.close();
  }
});
