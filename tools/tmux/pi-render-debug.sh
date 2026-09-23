#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SESSION="${PI_DEBUG_TMUX_SESSION:-pi-render-debug}"
LOG="${PI_DEBUG_LOG:-$ROOT/.pi/render-debug.log}"
PI_ARGS=("$@")
if ((${#PI_ARGS[@]} == 0)); then PI_ARGS=(-c); fi

mkdir -p "$(dirname "$LOG")"
: > "$LOG"

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 160 -y 48 -c "$ROOT" \
  "cd $(printf '%q' "$ROOT") && export SWARM_HOOK_TRACE=1 && exec pi ${PI_ARGS[*]@Q} 2>>$(printf '%q' "$LOG")"
tmux split-window -t "$SESSION" -h -l 60 -c "$ROOT" \
  "tail -n 100 -F $(printf '%q' "$LOG")"
tmux select-pane -t "$SESSION".0

echo "Started TUI debug session: $SESSION"
echo "Attach: tmux attach -t $SESSION"
echo "Log:    $LOG"
echo "The left pane runs Pi; the right pane tails renderer diagnostics."
