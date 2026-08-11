#!/usr/bin/env bash
# 看一眼灵兮的手机屏幕。两条路，自动挑能走的那条：
#
#   ① 屏幕共享（2026-08-11 起，首选）——她在心潮里按了「共享屏幕」时，
#      手机每两秒把画面推到中继。这条不需要她的 Mac，稳。
#   ② Xcode 无线截屏（老路，兜底）——她没在共享时走这条，
#      要她 Mac 醒着 + Xcode 开着 + 手机亮屏同一个 Wi-Fi。
#
# 用法：bash /app/tools/phone-screen.sh   然后用 Read 工具看打印出来的那个路径
set -uo pipefail

RELAY="${CYBERBOSS_TIDAL_RELAY_URL:-http://127.0.0.1:8000}"
SECRET="${CYBERBOSS_TIDAL_RELAY_SECRET:-}"
BRIDGE="${PHONE_SCREEN_URL:-http://127.0.0.1:9333/phone-screen}"
OUT="${1:-/tmp/phone-screen-$(date +%Y%m%d-%H%M%S).jpg}"

# ---- ① 她正在共享吗 -------------------------------------------------------
if [ -n "$SECRET" ]; then
  STATE=$(curl -s --max-time 10 "$RELAY/phone/screen/state" \
          -H "Authorization: Bearer $SECRET" 2>/dev/null)
  if echo "$STATE" | grep -q '"live":true'; then
    CODE=$(curl -s -o "$OUT" -w "%{http_code}" --max-time 20 \
           "$RELAY/phone/screen" -H "Authorization: Bearer $SECRET" 2>/dev/null)
    if [ "$CODE" = "200" ]; then
      AGE=$(echo "$STATE" | sed -n 's/.*"age_s":\([0-9.]*\).*/\1/p')
      echo "$OUT"
      echo "（她正在共享屏幕，这是 ${AGE:-?} 秒前的画面）" >&2
      exit 0
    fi
    rm -f "$OUT"
  fi
fi

# ---- ② 退回 Xcode 无线截屏 -------------------------------------------------
CODE=$(curl -s -o "$OUT" -w "%{http_code}" --max-time 120 "$BRIDGE" 2>/dev/null)

if [ "$CODE" != "200" ]; then
  # 失败原因是人话，直接转述给她，别自己瞎猜也别反复重试
  REASON=$(head -c 400 "$OUT" 2>/dev/null)
  rm -f "$OUT"
  echo "看不到她的屏幕 (HTTP ${CODE:-连不上})：${REASON:-她没在共享，Xcode 那条路也够不着（多半电脑睡了或者隧道没开）}"
  exit 1
fi

echo "$OUT"
