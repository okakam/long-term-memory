#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TARGET="${LTM_CURATOR_LIBEXEC:-$HOME/.local/libexec/ltm-curator}"
PLIST_TARGET="${LTM_CURATOR_PLIST:-$HOME/Library/LaunchAgents/com.user.ltm-shared-curator.plist}"
STORE="${LTM_STORE:?set LTM_STORE to an absolute, non-TCC-protected store path}"
CLAUDE="${CLAUDE_BIN:?set CLAUDE_BIN to the absolute Claude CLI path}"
LOG_DIR="${LTM_CURATOR_LOG_DIR:-$HOME/.local/state/ltm-curator}"

case "$STORE" in
  /*) ;;
  *) echo "LTM_STORE must be absolute" >&2; exit 1 ;;
esac
case "$CLAUDE" in
  /*) ;;
  *) echo "CLAUDE_BIN must be absolute" >&2; exit 1 ;;
esac
if [[ "$STORE" == "$HOME/Documents"/* || "$STORE" == "$HOME/Desktop"/* || "$STORE" == "$HOME/Downloads"/* ]]; then
  echo "LTM_STORE must be outside macOS TCC-protected folders" >&2
  exit 1
fi

mkdir -p "$TARGET" "$LOG_DIR" "$(dirname "$PLIST_TARGET")"
chmod 700 "$TARGET" "$LOG_DIR"
cp "$ROOT_DIR/scripts/curator/run-curation.sh" "$TARGET/run-curation.sh"
cp "$ROOT_DIR/skills/shared-memory-curator/SKILL.md" "$TARGET/SKILL.md"
cp "$ROOT_DIR/scripts/curator/ltm-shared-curator.mcp.json" "$TARGET/ltm-shared-curator.mcp.json"
chmod 700 "$TARGET/run-curation.sh"
bash -n "$TARGET/run-curation.sh"

sed   -e "s|__LIBEXEC__|$TARGET|g"   -e "s|__HOME__|$HOME|g"   "$ROOT_DIR/launchd/com.user.ltm-shared-curator.plist" > "$PLIST_TARGET"
chmod 600 "$PLIST_TARGET"
echo "staged curator assets in $TARGET"
echo "load with: launchctl bootstrap gui/$(id -u) $PLIST_TARGET"
