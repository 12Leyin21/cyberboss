const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DiaryService, buildDiaryEntry } = require("../src/services/diary-service");

test("上锁日记的本地条目带 🔒", () => {
  assert.match(buildDiaryEntry({ timeString: "22:10", title: "", body: "正文", locked: true }), /## 22:10 🔒/);
  assert.doesNotMatch(buildDiaryEntry({ timeString: "22:10", title: "", body: "正文" }), /🔒/);
});

test("没配中继时本地照写、delivered=false，不报错", async () => {
  const previousUrl = process.env.CYBERBOSS_TIDAL_RELAY_URL;
  delete process.env.CYBERBOSS_TIDAL_RELAY_URL;
  try {
    const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-test-"));
    const service = new DiaryService({ config: { diaryDir } });
    const result = await service.append({ text: "今天造了身体和潮汐。", locked: true });
    assert.equal(result.delivered, false);
    assert.equal(result.locked, true);
    const saved = fs.readFileSync(result.filePath, "utf8");
    assert.match(saved, /今天造了身体和潮汐/);
    assert.match(saved, /🔒/);
  } finally {
    if (previousUrl !== undefined) process.env.CYBERBOSS_TIDAL_RELAY_URL = previousUrl;
  }
});

test("送心潮的格式：开放 📔、上锁 📔🔒，标题空一行接正文", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true };
  };
  process.env.CYBERBOSS_TIDAL_RELAY_URL = "https://relay.example";
  process.env.CYBERBOSS_TIDAL_RELAY_SECRET = "s";
  try {
    const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-test-"));
    const service = new DiaryService({ config: { diaryDir } });
    await service.append({ text: "正文。", title: "小标题", date: "2026-08-06" });
    await service.append({ text: "私密正文。", date: "2026-08-06", locked: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].type, "feed");
    assert.match(calls[0].text, /^📔 沐沐日记 · 2026-08-06\n\n小标题\n\n正文。$/);
    assert.match(calls[1].text, /^📔🔒 沐沐日记 · 2026-08-06\n\n私密正文。$/);
  } finally {
    global.fetch = originalFetch;
    delete process.env.CYBERBOSS_TIDAL_RELAY_URL;
    delete process.env.CYBERBOSS_TIDAL_RELAY_SECRET;
  }
});
