#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3939}"
HOST="${HOST:-0.0.0.0}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${ROOT_DIR}/.ltm-dev.log"

PID="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
if [[ -n "$PID" ]]; then
  COMMAND_LINE="$(ps -p "$PID" -o command= 2>/dev/null || true)"
  CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
  if [[ "$CWD" == "$ROOT_DIR" && "$COMMAND_LINE" =~ next.*dev ]]; then
    echo "Next dev server already running in $ROOT_DIR (PID $PID)"
    exit 0
  fi
  echo "port $PORT is occupied by PID $PID ($COMMAND_LINE, cwd=$CWD)" >&2
  echo "stop that process by its PID before starting this project" >&2
  exit 1
fi

cd "$ROOT_DIR"
if [[ "${1:-}" == "--bg" ]]; then
  nohup pnpm exec next dev -H "$HOST" -p "$PORT" > "$LOG_FILE" 2>&1 &
  echo "started Next dev server (PID $!)"
else
  exec pnpm exec next dev -H "$HOST" -p "$PORT"
fi
