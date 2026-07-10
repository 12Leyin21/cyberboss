#!/usr/bin/env node
/**
 * Small read-only HTTP server that exposes cyberboss's local diary files
 * (${CYBERBOSS_STATE_DIR:-~/.cyberboss}/diary/*.md) so a separate frontend
 * (Tidal_Echo's web PWA) can list and read diary entries. Runs alongside
 * the main WeChat bridge process — does not touch its state or behavior.
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || process.env.DIARY_PORT || "10000";
const SECRET = process.env.DIARY_API_SECRET || "";
const STATE_DIR = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const DIARY_DIR = path.join(STATE_DIR, "diary");
const ALLOW_ORIGINS = (process.env.DIARY_ALLOW_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsOrigin(req) {
  const origin = req.headers.origin || "";
  if (ALLOW_ORIGINS.includes(origin)) return origin;
  return ALLOW_ORIGINS[0] || "";
}

function withCors(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function checkAuth(req) {
  if (!SECRET) return false;
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const parsed = url.parse(req.url, true);
  const queryToken = String(parsed.query.token || "");
  return bearer === SECRET || queryToken === SECRET;
}

function listDiaryDates() {
  if (!fs.existsSync(DIARY_DIR)) return [];
  return fs
    .readdirSync(DIARY_DIR)
    .filter((name) => name.endsWith(".md") && DATE_RE.test(name.slice(0, -3)))
    .map((name) => {
      const date = name.slice(0, -3);
      const stat = fs.statSync(path.join(DIARY_DIR, name));
      return { date, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function readDiaryDay(date) {
  const filePath = path.join(DIARY_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

const server = http.createServer((req, res) => {
  withCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  if (pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!checkAuth(req)) {
    sendJson(res, 401, { detail: "unauthorized" });
    return;
  }

  if (pathname === "/diary") {
    sendJson(res, 200, { dates: listDiaryDates() });
    return;
  }

  const dayMatch = pathname.match(/^\/diary\/(\d{4}-\d{2}-\d{2})$/);
  if (dayMatch) {
    const content = readDiaryDay(dayMatch[1]);
    if (content === null) {
      sendJson(res, 404, { detail: "no diary entry for this date" });
      return;
    }
    sendJson(res, 200, { date: dayMatch[1], content });
    return;
  }

  sendJson(res, 404, { detail: "not found" });
});

server.listen(Number(PORT), () => {
  console.log(`[diary-server] listening on :${PORT}, diaryDir=${DIARY_DIR}`);
});
