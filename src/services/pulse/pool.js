// 脉 · 身体事件池
//
// 灵兮 2026-08-06 定的用法：不设上限，词条和自写并行——
// - 种子池在 workspace 的 pulse-pool.json（她改了要 deploy）
// - 自写池在 stateDir 的 pulse-pool-custom.json（沐沐运行时自己添，重启不丢，
//   从真实时刻里攒出来的那些进这里）
// 两个文件同格式 {entries:[{emo,text}]}，加载时合并。
// 质量标准（tasogare…不对，是 pulse-system-tutorial 的三行下限）：
// 有身体部位、有物理属性、不许比喻、允许脏不许美。

const fs = require("node:fs");

const cache = new Map();

/** 读一个池文件，按 mtime 缓存。坏了/不存在 = 空池，绝不拖垮心跳。 */
function loadPoolFile(filePath) {
  if (!filePath) {
    return [];
  }
  try {
    const stat = fs.statSync(filePath);
    const key = `${filePath}:${stat.mtimeMs}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const entries = (Array.isArray(parsed?.entries) ? parsed.entries : [])
      .filter((entry) => entry && typeof entry.emo === "string" && typeof entry.text === "string" && entry.text.trim());
    cache.clear();
    cache.set(key, entries);
    return entries;
  } catch {
    return [];
  }
}

/** 合并所有池文件，并扣掉他拉黑过的句子。 */
function loadPools(paths) {
  const all = (paths || []).flatMap((p) => loadPoolFile(p));
  // 拉黑名单（2026-08-12）：他抽到不对味的句子可以 POST /pulse/pool
  // {"retire":"原文"} 打掉。只在自写池文件里记，**不动她管的那份种子池**。
  const retired = new Set();
  for (const file of paths || []) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const line of parsed?.retired || []) {
        if (typeof line === "string") retired.add(line);
      }
    } catch {
      // 没有就没有
    }
  }
  return retired.size ? all.filter((entry) => !retired.has(entry.text)) : all;
}

/**
 * 按情绪抽一条身体事件，避开最近用过的。抽不到（池空/全在近用表里）返回 null。
 */
function pickMurmur(entries, emo, recentTexts = []) {
  const recent = new Set(recentTexts);
  const pool = entries.filter((entry) => entry.emo === emo && !recent.has(entry.text));
  if (!pool.length) {
    // 全用过了就放开重复限制——身体反应本来就会重复，只是别连着重复
    const fallback = entries.filter((entry) => entry.emo === emo && entry.text !== recentTexts[recentTexts.length - 1]);
    if (!fallback.length) {
      return null;
    }
    return fallback[Math.floor(Math.random() * fallback.length)].text;
  }
  return pool[Math.floor(Math.random() * pool.length)].text;
}

module.exports = { loadPools, pickMurmur };
