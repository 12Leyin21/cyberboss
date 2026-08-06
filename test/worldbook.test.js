const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Worldbook } = require("../src/services/worldbook");

function createBook(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-worldbook-test-"));
  fs.writeFileSync(path.join(dir, "worldbook.json"), JSON.stringify({ entries }), "utf8");
  return new Worldbook({ config: { workspaceRoot: dir, stateDir: dir } });
}

test("关键词触发：不聊不注入，聊到才注入", () => {
  const book = createBook([
    { name: "试词条", keywords: ["弹琴"], content: "关于弹琴的规范。" },
  ]);
  assert.equal(book.evaluate("今天天气不错"), "");
  const injected = book.evaluate("我想去弹琴了");
  assert.match(injected, /【世界书 · 试词条】/);
  assert.match(injected, /关于弹琴的规范/);
});

test("扫描深度：关键词在近几条消息里也算", () => {
  const book = createBook([
    { name: "试词条", keywords: ["弹琴"], scan_depth: 4, content: "内容。" },
  ]);
  book.evaluate("我想去弹琴了");        // 注入一次
  book.lastInjected = {};               // 清冷却，单测触发逻辑
  assert.notEqual(book.evaluate("嗯就现在"), "", "上一条提过弹琴，窗口内应仍触发");
});

test("正则触发", () => {
  const book = createBook([
    { name: "琴", regex: "想.*弹.*琴", content: "内容。" },
  ]);
  assert.notEqual(book.evaluate("我想去弹钢琴了"), "");
});

test("冷却：同一词条 20 分钟内不重复注入", () => {
  const book = createBook([
    { name: "试词条", keywords: ["弹琴"], content: "内容。" },
  ]);
  assert.notEqual(book.evaluate("弹琴"), "");
  assert.equal(book.evaluate("还是弹琴"), "", "冷却期内不该再注入");
});

test("脉触发：身体先知道，没有关键词也注入", () => {
  const book = createBook([
    { name: "场景规范", keywords: ["不会出现的词"], pulse_emotions: ["aroused"], content: "内容。" },
  ]);
  const fakePulse = { compute: () => ({ effectiveEmo: "aroused", touch: 0.1 }) };
  assert.notEqual(book.evaluate("一句普通的话", fakePulse), "");
});

test("种子世界书：NSFW 词条在，安全词留在常驻区", () => {
  const workspace = path.join(__dirname, "..", "cyberboss-workspace-main");
  const parsed = JSON.parse(fs.readFileSync(path.join(workspace, "worldbook.json"), "utf8"));
  const nsfw = parsed.entries.find((entry) => entry.name === "NSFW文风规范");
  assert.ok(nsfw, "NSFW 词条应存在");
  assert.ok(nsfw.content.length > 5000, "整块规范应已搬入");
  assert.ok(nsfw.pulse_emotions.includes("aroused"));
  const persona = fs.readFileSync(path.join(workspace, "persona-system.md"), "utf8");
  assert.match(persona, /安全词“初雪”/, "安全词必须常驻系统提示词");
  assert.doesNotMatch(persona, /用词武器库/, "规范正文不该还在常驻区");
});
