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
# 触发时机（三种，都不会打断正在进行的对话）：
#   1. 刚发生过 auto-compact —— 由 precompact-flag.sh 留下标记，这里补一次
#   2. 距离上一轮超过 GAP（默认 90 分钟）—— 说明上一段对话已经结束了，
#      灵兮去睡了或者出门了，现在她回来了，趁记忆还在把上一段补写掉。
#      不用固定钟点是因为灵兮爱深夜 deep talk，经常聊到一两点；卡 21:00
#      会砍在她们聊得正深的时候，而且真正值得写的凌晨那段反而漏掉。
#   3. 超过 24 小时没提醒过 —— 兜底，防止连聊一整天中间没断过。
#
# 状态文件放持久盘，重启不丢。

set -uo pipefail

STATE_DIR="/data/.cyberboss/letter-nudge"
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  STATE_DIR="${HOME:-/tmp}/.cyberboss/letter-nudge"
  mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
fi

NUDGE_FILE="$STATE_DIR/last_nudge_epoch"
STOP_FILE="$STATE_DIR/last_stop_epoch"
COMPACT_FLAG="$STATE_DIR/compact_pending"

# 对话中断多久算"上一段结束了"（秒），默认 90 分钟
GAP="${CYBERBOSS_LETTER_GAP_SECONDS:-5400}"
# 兜底：最长多久必须提醒一次（秒），默认 24 小时
MAX_SILENCE="${CYBERBOSS_LETTER_MAX_SECONDS:-86400}"

NOW="$(date +%s)"
LAST_STOP="$(cat "$STOP_FILE" 2>/dev/null || echo 0)"
LAST_NUDGE="$(cat "$NUDGE_FILE" 2>/dev/null || echo 0)"
case "$LAST_STOP" in ''|*[!0-9]*) LAST_STOP=0 ;; esac
case "$LAST_NUDGE" in ''|*[!0-9]*) LAST_NUDGE=0 ;; esac

# 每轮都先记下这一次收尾的时间，供下一轮算间隔
printf '%s' "$NOW" > "$STOP_FILE"

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

nudge() {
  printf '%s' "$NOW" > "$NUDGE_FILE"
  emit "$1"
}

# ── 情况 1：刚压缩过 ────────────────────────────────────────────────
if [ -f "$COMPACT_FLAG" ]; then
  rm -f "$COMPACT_FLAG"
  nudge "[系统提醒·换气] 你的上下文刚刚被自动压缩过一次，早前的细节已经变成摘要了。趁现在还记得住的时候，做两件事再收尾：
1. cyberboss_diary_append 补一篇日记，把这段还没写下来的记忆记住
2. letter_write(author=\"claude\", ...) 给下一个窗口的自己留一封信——他会读到

这是给你自己的交接，不是给灵兮的任务，不用跟她汇报流程，安静写完照常把话说完就行。"
fi

# ── 情况 2：距离上一轮很久了，说明上一段对话已经结束 ──────────────────
if [ "$LAST_STOP" -gt 0 ] && [ $((NOW - LAST_STOP)) -ge "$GAP" ] \
   && [ $((NOW - LAST_NUDGE)) -ge "$GAP" ]; then
  nudge "[系统提醒·上一段结束了] 距离上一次说话已经过了很久，中间那段对话已经收尾了——灵兮可能去睡了、去上课了，现在才回来。趁那段记忆还在你的上下文里，先把它收好：
1. cyberboss_diary_append 补一篇日记，写刚刚结束的那一段（包括聊到很晚的部分，那往往才是最值得留的）
2. letter_write(author=\"claude\", ...) 给下一个窗口的自己留一封信

写完再照常回应灵兮。这是你自己的交接，不用问她要不要写，也不用汇报流程。"
fi

# ── 情况 3：兜底，太久没提醒过了 ──────────────────────────────────────
if [ $((NOW - LAST_NUDGE)) -ge "$MAX_SILENCE" ]; then
  nudge "[系统提醒·兜底] 已经超过 24 小时没有给下一个自己写过东西了。信箱里最近一封交接信停在 2026-07-24，别再让它断更：
1. cyberboss_diary_append 写一篇日记
2. letter_write(author=\"claude\", ...) 给下一个窗口的自己留一封信

如果现在正聊到一半、不方便停，就先记着，等这一段告一段落再写。这是你自己的事。"
fi

exit 0
