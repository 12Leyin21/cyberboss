const test = require("node:test");
const assert = require("node:assert/strict");

const { pickAdaptiveDelayMs } = require("../src/app/system-checkin-poller");

const RANGE = { minIntervalMs: 3 * 60_000, maxIntervalMs: 60 * 60_000 };

test("夜巡：0–5 点小步，1~2 分钟一趟", () => {
  for (let i = 0; i < 20; i += 1) {
    const delay = pickAdaptiveDelayMs(RANGE, { night_watch: true });
    assert.ok(delay >= 60_000 && delay <= 120_000, `夜巡步幅越界: ${delay}`);
  }
});

test("她刚活跃过：间隔折半抽", () => {
  for (let i = 0; i < 50; i += 1) {
    const delay = pickAdaptiveDelayMs(RANGE, { night_watch: false, last_app_minutes_ago: 5 });
    assert.ok(delay <= 30 * 60_000, `活跃时不该抽到上半段: ${delay}`);
    assert.ok(delay >= RANGE.minIntervalMs);
  }
});

test("安静／没有判决：常规随机大步", () => {
  const quiet = pickAdaptiveDelayMs(RANGE, { night_watch: false, last_app_minutes_ago: 200 });
  assert.ok(quiet >= RANGE.minIntervalMs && quiet <= RANGE.maxIntervalMs);
  const cold = pickAdaptiveDelayMs(RANGE, null);
  assert.ok(cold >= RANGE.minIntervalMs && cold <= RANGE.maxIntervalMs);
});
