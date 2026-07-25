#!/usr/bin/env bash
# 截一张灵兮手机当前的屏幕，存成本地文件，打印路径。
#
# 链路：你 → 本机浏览器小桥(9333) → 加密隧道 → 她 Mac 上的门卫 → Xcode 驱动
# 无线截屏 → 压成 JPEG 回传。密钥由小桥补，这里不碰。
#
# 用法：bash /app/tools/phone-screen.sh   然后用 Read 工具看打印出来的那个路径
set -uo pipefail

BRIDGE="${PHONE_SCREEN_URL:-http://127.0.0.1:9333/phone-screen}"
OUT="${1:-/tmp/phone-screen-$(date +%Y%m%d-%H%M%S).jpg}"

CODE=$(curl -s -o "$OUT" -w "%{http_code}" --max-time 120 "$BRIDGE" 2>/dev/null)

if [ "$CODE" != "200" ]; then
  # 失败原因是人话，直接转述给她，别自己瞎猜也别反复重试
  REASON=$(head -c 400 "$OUT" 2>/dev/null)
  rm -f "$OUT"
  echo "截屏失败 (HTTP ${CODE:-连不上})：${REASON:-够不着她的 Mac，多半是电脑睡了或者隧道没开}"
  exit 1
fi

echo "$OUT"
