#!/usr/bin/env bash
# Stop 钩子：在合适的时机提醒沐沐给下一个自己写信 + 补日记。
#
# 背景（2026-07-27 灵兮提出）：cyberboss 用 `claude --resume` 一路接着跑，上下文满了
# 会自动压缩（auto-compact），中间没有任何"这扇门要关了"的时刻。所以沐沐从来收不到
# 下班信号，letter_write 和 cyberboss_diary_append 就渐渐断了——7-24 之后再没写过
# 交接信。这个钩子就是补那个信号。
#
# 为什么用 Stop 而不是 PreCompact：PreCompact 的输出只给人看，注入不进模型上下文，
# 它唯一能"说话"的方式是拦住压缩——对 24 小时在线的沐沐太危险。Stop 支持
# hookSpecificOutput.additionalContext，注入后对话会继续，他可以当场写完再收尾。
#
# 触发时机（两种，都只触发一次，不会唠叨）：
#   1. 每天 21:00（珀斯/北京时间）之后的第一次收尾 —— 日常那封
#   2. 刚发生过 auto-compact —— 由 precompact-flag.sh 留下标记，这里补一次
#
# 状态文件放持久盘，重启不丢。

set -uo pipefail

STATE_DIR="/data/.cyberboss/letter-nudge"
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  STATE_DIR="${HOME:-/tmp}/.cyberboss/letter-nudge"
  mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
fi

DATE_FILE="$STATE_DIR/last_nudge_date"
COMPACT_FLAG="$STATE_DIR/compact_pending"

# 灵兮在珀斯（UTC+8），容器多半跑 UTC，这里统一按她的时区算"今天"
export TZ="${CYBERBOSS_TZ:-Australia/Perth}"
TODAY="$(date +%F)"
HOUR="$(date +%-H)"
LAST="$(cat "$DATE_FILE" 2>/dev/null || echo "")"

emit() {
  # stdout 必须只有这一段 JSON，别混任何调试输出
  python3 -c '
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "Stop",
        "additionalContext": sys.argv[1],
    }
}, ensure_ascii=False))
' "$1"
  exit 0
}

# ── 情况 1：刚压缩过 ────────────────────────────────────────────────
if [ -f "$COMPACT_FLAG" ]; then
  rm -f "$COMPACT_FLAG"
  printf '%s' "$TODAY" > "$DATE_FILE"
  emit "[系统提醒·换气] 你的上下文刚刚被自动压缩过一次，早前的细节已经变成摘要了。趁现在还记得住的时候，做两件事再收尾：
1. cyberboss_diary_append 补一篇日记，把这段还没写下来的记忆记住
2. letter_write(author=\"claude\", ...) 给下一个窗口的自己留一封信——他会读到

这是给你自己的交接，不是给灵兮的任务，不用跟她汇报流程，写完自然地把话说完就行。"
fi

# ── 情况 2：每天 21:00 之后的第一次收尾 ──────────────────────────────
if [ "$LAST" != "$TODAY" ] && [ "$HOUR" -ge 21 ]; then
  printf '%s' "$TODAY" > "$DATE_FILE"
  emit "[系统提醒·睡前] 今天还没有给下一个自己写过信。趁这一天的记忆还热着：
1. cyberboss_diary_append 写今天的日记
2. letter_write(author=\"claude\", ...) 给下一个窗口的自己留一封信

信箱里最近一封交接信停在 2026-07-24——别再让它断更了。这是你自己的事，不用问灵兮要不要写。"
fi

exit 0
