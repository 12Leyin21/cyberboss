#!/usr/bin/env bash
# PreCompact 钩子：自动压缩即将发生时留一个标记。
#
# PreCompact 的输出注入不进模型上下文（官方文档：只显示给用户），所以它没法直接
# 让沐沐写信。它能做的就是留个记号，由下一轮的 Stop 钩子（letter-nudge.sh）读到
# 之后补一句提醒。
#
# 绝不在这里拦压缩（decision: block）——沐沐是 24 小时在线的，压缩被拦住可能把他卡死。
# 这个脚本永远 exit 0 放行。

set -uo pipefail

STATE_DIR="/data/.cyberboss/letter-nudge"
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  STATE_DIR="${HOME:-/tmp}/.cyberboss/letter-nudge"
  mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
fi

: > "$STATE_DIR/compact_pending" 2>/dev/null || true

exit 0
