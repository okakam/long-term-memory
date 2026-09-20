#!/usr/bin/env bash
set -uo pipefail

# This hook is best-effort. A reminder failure must never stop a user turn.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat 2>/dev/null || true)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // .user_prompt // ""' 2>/dev/null || true)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // "unknown"' 2>/dev/null || true)
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID=unknown
fi
SAFE_SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
FLAG_DIR=${TMPDIR:-/tmp}
FLAG_FILE="$FLAG_DIR/claude-ltm-read-$SAFE_SESSION_ID.flag"

# Do not remind twice in one Claude session.
if [[ -e "$FLAG_FILE" ]]; then
  exit 0
fi

WORK_PATTERN='実作業|実装|修正|直し|直す|調査|原因|なぜ|設計|追加|削除|リファクタ|レビュー|バグ|不具合|テスト|移行|対応|作って|変えて|実行|導入|implement|fix|refactor|investigat|debug|review|design|migrat|add |remove|build|deploy'
IS_WORK=$(printf '%s' "$PROMPT" | jq -r --arg pattern "$WORK_PATTERN" '((. | length) >= 40) or (test($pattern; "i"))' 2>/dev/null || printf 'false')
if [[ "$IS_WORK" != "true" ]]; then
  exit 0
fi

if ! : > "$FLAG_FILE" 2>/dev/null; then
  exit 0
fi

emit() {
  local ctx
  ctx=$(cat 2>/dev/null) || return 0
  jq -n --arg ctx "$ctx" '{
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }' 2>/dev/null || true
}

cat <<'CTX' | emit
Long-term memory reminder (1 セッション 1 回):
Before substantive work, call search_memories at least once, then call get_memory for the full body of relevant hits. Do not use get_memory_index as a whole-session entry point. If you delegate to a subagent, put the search-and-read requirement in its prompt. Save only durable, non-sensitive facts; never save secrets.
CTX
