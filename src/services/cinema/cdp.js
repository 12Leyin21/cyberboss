// 看片模式 · 跟浏览器说话的那一小段
//
// 浏览器小桥（scripts/browser-bridge.js）在 127.0.0.1:9333 上把 CDP 转发到
// 她 Mac 的 Chrome。这里只用两条命令：截图、以及在页面里跑一小段 JS
//（拿播放进度和画面指纹）。不引依赖——Node 22 自带 fetch 和 WebSocket。

const BRIDGE = "http://127.0.0.1:9333";

/** 找一个正在放视频的页面。没有就退回第一个普通页面。 */
async function pickPageTarget() {
  const response = await fetch(`${BRIDGE}/json/list`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`bridge ${response.status}`);
  const pages = (await response.json()).filter(
    (t) => t.type === "page" && !String(t.url || "").startsWith("devtools://"));
  if (!pages.length) throw new Error("no page open in her Chrome");
  // 有 http(s) 页面就优先，about:blank 排最后
  pages.sort((a, b) => (a.url.startsWith("http") ? -1 : 1) - (b.url.startsWith("http") ? -1 : 1));
  return pages[0];
}

/**
 * 开一条 CDP 连接、按顺序跑几条命令、关掉。
 * 看片一次 tick 就两三条命令，不值得维持长连接——而且长连接断了要重连，
 * 短连接每次自愈。
 */
async function withSession(wsUrl, run) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;            // 事件通知，不是命令回执
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || "cdp error"));
    else waiter.resolve(msg.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 15000);
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws connect timed out")), 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); },
                               { once: true });
    });
    return await run(send);
  } finally {
    try { socket.close(); } catch { /* 关不掉就算了 */ }
  }
}

// 在页面里跑：拿播放进度 + 8×8 灰度指纹。
// 指纹在浏览器里算——服务器这边没有图像库，而 canvas 本来就在那儿。
// 跨域视频画进 canvas 会污染，getImageData 直接抛；抛了就只回进度，
// 让外面退回"按间隔截"，不至于整个功能瘫掉。
const PROBE_JS = `(() => {
  const vs = [...document.querySelectorAll('video')]
    .filter(v => v.readyState >= 2 && v.videoWidth > 0);
  if (!vs.length) return { ok: false, why: 'no video element' };
  const v = vs.sort((a, b) => b.videoWidth - a.videoWidth)[0];
  const out = { ok: true, time: v.currentTime, duration: v.duration || 0, paused: v.paused };
  try {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    const fp = [];
    for (let i = 0; i < d.length; i += 4) {
      fp.push(Math.round((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 4));
    }
    out.fingerprint = fp;
  } catch (e) {
    out.fingerprint = null;   // 跨域，画不出来。进度还是准的
  }
  return out;
})()`;

/** 一次 tick：探一下播放状态，需要的话顺手截一张图（JPEG base64）。 */
async function probeAndShoot(wantShot) {
  const target = await pickPageTarget();
  return withSession(target.webSocketDebuggerUrl, async (send) => {
    const evaluated = await send("Runtime.evaluate", {
      expression: PROBE_JS, returnByValue: true, awaitPromise: false,
    });
    const probe = evaluated?.result?.value || { ok: false, why: "evaluate failed" };
    let shot = null;
    if (wantShot && probe.ok) {
      // 质量压到 55：他要看的是"这一幕是什么"，不是海报
      const captured = await send("Page.captureScreenshot", { format: "jpeg", quality: 55 });
      shot = captured?.data || null;
    }
    return { probe, shot, pageUrl: target.url };
  });
}

module.exports = { probeAndShoot, pickPageTarget };
