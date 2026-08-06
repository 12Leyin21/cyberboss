const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { TideKeeper, THRESHOLD_TOKENS, COMPACT_INSTRUCTION } = require("../src/services/tide");

function createKeeper(overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tide-test-"));
  return new TideKeeper({
    config: { stateDir, claudeCommand: "claude" },
    runtimeAdapter: overrides.runtimeAdapter || {},
    systemMessageQueue: overrides.systemMessageQueue || { enqueue: () => {} },
    resolveTarget: overrides.resolveTarget || (() => ({ accountId: "a", senderId: "s", workspaceRoot: "/tmp" })),
  });
}

test("压缩指令是事实清单版，不让原生压缩碰情感", () => {
  assert.match(COMPACT_INSTRUCTION, /只罗列事实/);
  assert.match(COMPACT_INSTRUCTION, /不要写情感氛围/);
});

test("水位记录 + 状态快照落盘", () => {
  const keeper = createKeeper();
  keeper.onEvent({ type: "runtime.context.updated", payload: { threadId: "t1", currentTokens: 42_000 } });
  assert.equal(keeper.levelByThread.get("t1"), 42_000);
  const status = JSON.parse(fs.readFileSync(keeper.statusFile, "utf8"));
  assert.equal(status.context_tokens, 42_000);
  assert.equal(status.threshold, THRESHOLD_TOKENS);
});

test("水位不到阈值不动手；没接中继不动手", async () => {
  const keeper = createKeeper();
  keeper.levelByThread.set("t1", THRESHOLD_TOKENS - 1);
  await keeper.evaluate("t1");
  assert.equal(keeper.inFlight, false);
  assert.equal(keeper.compactWatch, null);
});

test("滚动摘要：没有新对话时账本原样保留", async () => {
  const keeper = createKeeper();
  const result = await keeper.rollSummary("旧账本内容在此", []);
  assert.equal(result, "旧账本内容在此");
});

test("注回三层：带摘要、带尾注、走系统消息队列", async () => {
  const enqueued = [];
  const keeper = createKeeper({
    systemMessageQueue: { enqueue: (message) => enqueued.push(message) },
  });
  fs.writeFileSync(keeper.summaryFile, "他们今天造了身体、书房和潮汐。", "utf8");
  await keeper.injectRestore();
  assert.equal(enqueued.length, 1);
  const text = enqueued[0].text;
  assert.match(text, /潮汐 · 上下文已原地整理/);
  assert.match(text, /他们今天造了身体、书房和潮汐/);
  assert.match(text, /session 没有换，她一直在/);
  assert.match(text, /不要提压缩这件事/);
  // 一轮潮汐后进入静默期
  assert.ok(keeper.state.cooldownUntil > Date.now());
});

test("压缩完成的那个轮次触发注回，而不是水位判定", () => {
  const enqueued = [];
  const keeper = createKeeper({
    systemMessageQueue: { enqueue: (message) => enqueued.push(message) },
  });
  keeper.compactWatch = { threadId: "t9", since: Date.now() };
  keeper.onEvent({ type: "runtime.turn.completed", payload: { threadId: "t9" } });
  assert.equal(keeper.compactWatch, null, "注回后放下 watch");
});
