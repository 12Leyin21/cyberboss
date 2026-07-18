// 浏览器小桥：给大脑一个永远不变的本地地址 127.0.0.1:9333，
// 背后自动转发到灵兮 Mac 上报的 Cloudflare 隧道（读 browser_target.json）。
// - 每个请求自动附上认证密钥（密钥只存在服务器上，不进大脑的配置）
// - /json* 响应体里把隧道地址改写回 127.0.0.1:9333，chrome-devtools-mcp 无感
// - WebSocket 升级走 TLS 直通
// 纯内置模块。隧道地址变了不用重启：每个请求现读文件。
const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const PORT = 9333;
const TARGET_FILE = process.env.BROWSER_TARGET_FILE
  || path.join(path.dirname(process.env.RELAY_DB || "/data/relay/relay.db"), "browser_target.json");

function readTarget() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TARGET_FILE, "utf8"));
    if (!parsed?.url) return null;
    const url = new URL(parsed.url);
    return { host: url.hostname, token: parsed.token || "" };
  } catch {
    return null;
  }
}

function withToken(reqPath, token) {
  return reqPath + (reqPath.includes("?") ? "&" : "?") + "token=" + token;
}

const server = http.createServer((req, res) => {
  const target = readTarget();
  if (!target) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("browser offline: her Mac has not reported a tunnel yet");
    return;
  }
  const forward = https.request(
    {
      host: target.host,
      port: 443,
      path: withToken(req.url, target.token),
      method: req.method,
      headers: { ...req.headers, host: target.host, "accept-encoding": "identity" },
    },
    (upstream) => {
      const chunks = [];
      upstream.on("data", (chunk) => chunks.push(chunk));
      upstream.on("end", () => {
        let body = Buffer.concat(chunks);
        const contentType = String(upstream.headers["content-type"] || "");
        if (req.url.startsWith("/json") || contentType.includes("json")) {
          // Chrome 汇报的调试地址改写回小桥地址
          let text = body.toString("utf8");
          text = text
            .replace(/wss?:\/\/[^/"']+/g, `ws://127.0.0.1:${PORT}`)
            .replace(/127\.0\.0\.1:\d+/g, `127.0.0.1:${PORT}`)
            .replace(new RegExp(target.host.replace(/\./g, "\\."), "g"), `127.0.0.1:${PORT}`);
          body = Buffer.from(text, "utf8");
        }
        const headers = { ...upstream.headers };
        delete headers["content-length"];
        delete headers["content-encoding"];
        res.writeHead(upstream.statusCode, headers);
        res.end(body);
      });
    }
  );
  req.pipe(forward);
  forward.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("browser bridge upstream error");
  });
});

server.on("upgrade", (req, clientSocket, head) => {
  const target = readTarget();
  if (!target) {
    clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  const upstream = tls.connect(443, target.host, { servername: target.host }, () => {
    const lines = [`${req.method} ${withToken(req.url, target.token)} HTTP/1.1`];
    const headers = { ...req.headers, host: target.host };
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`${key}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[browser-bridge] 127.0.0.1:${PORT} -> tunnel from ${TARGET_FILE}`);
});
