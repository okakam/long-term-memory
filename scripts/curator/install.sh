#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TARGET="${LTM_CURATOR_LIBEXEC:-$HOME/.local/libexec/ltm-curator}"
PLIST_TARGET="${LTM_CURATOR_PLIST:-$HOME/Library/LaunchAgents/com.user.ltm-shared-curator.plist}"
SYSTEMD_TARGET="${LTM_CURATOR_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
case "${LTM_CURATOR_SCHEDULER:-$(uname -s)}" in
  Darwin|launchd) SCHEDULER=launchd ;;
  Linux|systemd) SCHEDULER=systemd ;;
  *) echo "unsupported curator scheduler" >&2; exit 1 ;;
esac
CLAUDE="${CLAUDE_BIN:?set CLAUDE_BIN to the absolute Claude CLI path}"
LOG_DIR="${LTM_CURATOR_LOG_DIR:-$HOME/.local/state/ltm-curator}"

case "$CLAUDE" in
  /*) ;;
  *) echo "CLAUDE_BIN must be absolute" >&2; exit 1 ;;
esac
if [[ ! -x "$ROOT_DIR/node_modules/.bin/tsx" ]]; then
  echo "install repository dependencies before staging the curator" >&2
  exit 1
fi

mkdir -p "$TARGET" "$LOG_DIR"
chmod 700 "$TARGET" "$LOG_DIR"
cp "$ROOT_DIR/scripts/curator/run-curation.sh" "$TARGET/run-curation.sh"
cp "$ROOT_DIR/skills/shared-memory-curator/SKILL.md" "$TARGET/SKILL.md"
chmod 700 "$TARGET/run-curation.sh"
bash -n "$TARGET/run-curation.sh"
echo "staged curator assets in $TARGET"

render() {
  sed -e "s|__LIBEXEC__|$TARGET|g" -e "s|__HOME__|$HOME|g" -e "s|__REPO_ROOT__|$ROOT_DIR|g" "$1" > "$2"
  chmod 600 "$2"
}

if [[ "$SCHEDULER" == "launchd" ]]; then
  mkdir -p "$(dirname "$PLIST_TARGET")"
  render "$ROOT_DIR/launchd/com.user.ltm-shared-curator.plist" "$PLIST_TARGET"
  echo "load with: launchctl bootstrap gui/$(id -u) $PLIST_TARGET"
else
  mkdir -p "$SYSTEMD_TARGET"
  render "$ROOT_DIR/systemd/ltm-curator.service" "$SYSTEMD_TARGET/ltm-curator.service"
  render "$ROOT_DIR/systemd/ltm-curator.timer" "$SYSTEMD_TARGET/ltm-curator.timer"
  echo "enable with: systemctl --user daemon-reload && systemctl --user enable --now ltm-curator.timer"
fi
