#!/usr/bin/env bash
# 合并部署：同一个容器里跑 Tidal 中继（uvicorn，对外服务手机 App/PWA）
# 和 cyberboss 大脑（微信 + Tidal）。
#
# 监督策略：
# - 中继是容器的生命线（web 健康检查打它）：它退出 → 容器退出 → 平台重启
# - 大脑失败不拖垮容器，每 60 秒自动重试——首次部署先在 Render Shell 里
#   完成 `claude` 登录和 `npm run login`（微信扫码），下一轮重试即自愈
# - 没有 PORT / RELAY_SECRET 时不起中继，行为等同旧版纯 worker
set -uo pipefail

start_bridge_loop() {
  while true; do
    npm run shared:start
    echo "[start-with-relay] bridge exited; retrying in 60s (first deploy: run 'claude' login + 'npm run login' in Shell)"
    sleep 60
  done
}

if [[ -n "${PORT:-}" && -n "${RELAY_SECRET:-}" ]]; then
  mkdir -p "$(dirname "${RELAY_DB:-/data/relay/relay.db}")" "${RELAY_UPLOAD_DIR:-/data/relay/uploads}"
  # 大脑的 Tidal 适配器直接连本机中继，不走公网
  export CYBERBOSS_TIDAL_RELAY_URL="${CYBERBOSS_TIDAL_RELAY_URL:-http://127.0.0.1:${PORT}}"
  export CYBERBOSS_TIDAL_RELAY_SECRET="${CYBERBOSS_TIDAL_RELAY_SECRET:-${RELAY_SECRET}}"

  # 记忆库密钥在运行时注入 .mcp.json，绝不写进 mcp-seed.json（那个仓库是公开的）。
  # 没设 OMBRE_MCP_TOKEN 就原样不加头——所以先改这边还是先改 Render 都不会把沐沐搞失忆。
  #
  # 2026-07-27：cotj 打开 OAuth 后，ombre-brain 改走 claude.ai 账号级连接器（容器里的
  # claude 登的是灵兮自己的账号，那条已授权），seed 里的裸连接条目已删除。所以这段
  # 现在是空转的退路——真要改回 token 模式，得先把 ombre-brain 条目加回 mcp-seed.json。
  if [[ -n "${OMBRE_MCP_TOKEN:-}" ]]; then
    SEED="${CYBERBOSS_WORKSPACE_ROOT:-/app/cyberboss-workspace-main}/mcp-seed.json"
    LIVE="${CYBERBOSS_WORKSPACE_ROOT:-/app/cyberboss-workspace-main}/.mcp.json"
    if python3 - "$SEED" "$LIVE" <<'PY'
import json, os, sys
seed, live = sys.argv[1], sys.argv[2]
cfg = json.load(open(seed, encoding="utf-8"))
servers = cfg.get("mcpServers", cfg)
entry = servers.get("ombre-brain")
if not entry:
    raise SystemExit("no ombre-brain entry in seed")
entry.setdefault("headers", {})["Authorization"] = "Bearer " + os.environ["OMBRE_MCP_TOKEN"]
json.dump(cfg, open(live, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
    then
      echo "[start-with-relay] ombre-brain 已注入鉴权头"
    else
      echo "[start-with-relay] ⚠️ 注入失败，保留构建时的 .mcp.json（记忆库可能连不上）"
    fi
  fi
  python3 -m uvicorn app:app --host 0.0.0.0 --port "${PORT}" --app-dir relay &
  RELAY_PID=$!
  echo "[start-with-relay] relay pid=${RELAY_PID} port=${PORT}"

  # 浏览器小桥：大脑用固定地址 127.0.0.1:9333 操作她 Mac 上的隧道浏览器
  node scripts/browser-bridge.js &
  echo "[start-with-relay] browser-bridge pid=$!"

  start_bridge_loop &
  BRIDGE_LOOP_PID=$!
  echo "[start-with-relay] bridge loop pid=${BRIDGE_LOOP_PID}"

  trap 'kill -TERM ${RELAY_PID} ${BRIDGE_LOOP_PID} 2>/dev/null || true' TERM INT
  wait "${RELAY_PID}"
  EXIT_CODE=$?
  echo "[start-with-relay] relay exited (code=${EXIT_CODE}); shutting down container"
  kill -TERM "${BRIDGE_LOOP_PID}" 2>/dev/null || true
  exit "${EXIT_CODE}"
else
  echo "[start-with-relay] relay disabled (PORT or RELAY_SECRET missing); bridge only"
  exec npm run shared:start
fi
