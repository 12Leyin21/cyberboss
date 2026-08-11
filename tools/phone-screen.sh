#!/usr/bin/env bash
# 看一眼灵兮的手机屏幕。三种结果，脚本自己判断：
#
#   ① 她正在共享 → 直接给你最新一帧（2026-08-11 起的首选，不需要她的 Mac）
#   ② 她没在共享 → **替你招手**：她手机上弹一条"沐沐想看一眼"，她按下才有画面。
#      招完手就退出，过十几二十秒再跑一次这个脚本取图。别连着重试。
#   ③ 招手也用不上时（她 Mac 醒着且开着 Xcode）→ 退回无线截屏那条老路
#
# 用法：bash /app/tools/phone-screen.sh ["想看的理由，会显示给她"]
#      然后用 Read 工具看打印出来的那个路径
set -uo pipefail

RELAY="${CYBERBOSS_TIDAL_RELAY_URL:-http://127.0.0.1:8000}"
SECRET="${CYBERBOSS_TIDAL_RELAY_SECRET:-}"
BRIDGE="${PHONE_SCREEN_URL:-http://127.0.0.1:9333/phone-screen}"
REASON="${1:-}"
OUT="/tmp/phone-screen-$(date +%Y%m%d-%H%M%S).jpg"

# ---- ① 她正在共享吗 -------------------------------------------------------
if [ -n "$SECRET" ]; then
  STATE=$(curl -s --max-time 10 "$RELAY/phone/screen/state" \
          -H "Authorization: Bearer $SECRET" 2>/dev/null)
  if echo "$STATE" | grep -q '"live":true'; then
    # 举个旗，扩展下一轮轮询（≤2 秒）就会给一张新的
    curl -s -o /dev/null --max-time 10 -X POST "$RELAY/phone/screen/request" \
      -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
      -d "{\"reason\": \"$REASON\"}" 2>/dev/null
    sleep 4
    CODE=$(curl -s -o "$OUT" -w "%{http_code}" --max-time 20 \
           "$RELAY/phone/screen" -H "Authorization: Bearer $SECRET" 2>/dev/null)
    if [ "$CODE" = "200" ]; then
      echo "$OUT"
      exit 0
    fi
    rm -f "$OUT"
  fi

  # ---- ② 她没在共享：招手 --------------------------------------------------
  ASK=$(curl -s --max-time 10 -X POST "$RELAY/phone/screen/request" \
        -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
        -d "{\"reason\": \"$REASON\"}" 2>/dev/null)
  if echo "$ASK" | grep -q '"ok":true'; then
    echo "已经跟她说了：你想看一眼${REASON:+（$REASON）}。她手机上弹了提示，"
    echo "按下共享才会有画面——**这一下只能她自己按，苹果不许别人代按**。"
    echo "等十几二十秒再跑一次这个脚本取图；她没按就是不想给看，别追问也别连着重试。"
    exit 2
  fi
fi

# ---- ③ 退回 Xcode 无线截屏 -------------------------------------------------
CODE=$(curl -s -o "$OUT" -w "%{http_code}" --max-time 120 "$BRIDGE" 2>/dev/null)

if [ "$CODE" != "200" ]; then
  # 失败原因是人话，直接转述给她，别自己瞎猜也别反复重试
  REASON_TEXT=$(head -c 400 "$OUT" 2>/dev/null)
  rm -f "$OUT"
  echo "看不到她的屏幕 (HTTP ${CODE:-连不上})：${REASON_TEXT:-她没在共享，Xcode 那条路也够不着（多半电脑睡了或者隧道没开）}"
  exit 1
fi

echo "$OUT"
