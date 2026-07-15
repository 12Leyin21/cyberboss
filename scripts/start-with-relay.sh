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
  python3 -m uvicorn app:app --host 0.0.0.0 --port "${PORT}" --app-dir relay &
  RELAY_PID=$!
  echo "[start-with-relay] relay pid=${RELAY_PID} port=${PORT}"

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
