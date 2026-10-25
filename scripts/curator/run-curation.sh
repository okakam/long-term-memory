#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="${LTM_CURATOR_REPO_ROOT:-$(cd -- "$SCRIPT_DIR/../.." && pwd -P)}"
ENV_FILE="${LTM_CURATOR_ENV:-$HOME/.config/ltm-curator/env}"

readonly DRY_RUN_WAS_SET="${DRY_RUN+x}"
readonly DRY_RUN_VALUE="${DRY_RUN-}"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "curator env file is missing" >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

if [[ "$DRY_RUN_WAS_SET" == "x" ]]; then
  RUN_DRY_RUN="$DRY_RUN_VALUE"
else
  RUN_DRY_RUN="${DRY_RUN:-0}"
fi
if [[ "$RUN_DRY_RUN" != "0" && "$RUN_DRY_RUN" != "1" ]]; then
  echo "DRY_RUN must be 0 or 1" >&2
  exit 1
fi

MODE="${LTM_MODE:-local}"
if [[ "$MODE" != "local" && "$MODE" != "remote" ]]; then
  echo "LTM_MODE must be local or remote" >&2
  exit 1
fi

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
if [[ -f "$SCRIPT_DIR/SKILL.md" ]]; then
  case "$CLAUDE_BIN" in
    /*) ;;
    *) echo "staged curator requires an absolute CLAUDE_BIN" >&2; exit 1 ;;
  esac
fi

if [[ "$MODE" == "remote" ]]; then
  for name in MCP_PUBLIC_URL LTM_MCP_TOKEN LTM_MAINTENANCE_TOKEN; do
    if [[ -z "${!name:-}" ]]; then
      echo "remote curator configuration is incomplete" >&2
      exit 1
    fi
  done
else
  MCP_PUBLIC_URL="${MCP_PUBLIC_URL:-http://localhost:3939}"
  LTM_MCP_TOKEN="${LTM_MCP_TOKEN:-ltm_local_curator}"
fi

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "curator runner dependencies are missing from the repository" >&2
  exit 1
fi

LOG_DIR="${LTM_CURATOR_LOG_DIR:-$HOME/.local/state/ltm-curator}"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
# Serialize runs (timer and manual) without relying on flock, which macOS lacks.
LOCK_DIR="$LOG_DIR/run.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another curator run is in progress" >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR"' EXIT
export PATH="${LTM_CURATOR_PATH:-$PATH}"
cd "$REPO_ROOT"
umask 077

# Normal-project maintenance uses only its dedicated token; shared curation
# never receives it. A maintenance failure does not skip shared curation.
MAINTENANCE_STATUS=0
if [[ -n "${LTM_AUTO_MAINTENANCE_TOKEN:-}" ]]; then
  env -u LTM_MCP_TOKEN -u LTM_MAINTENANCE_TOKEN \
    DRY_RUN="$RUN_DRY_RUN" \
    MCP_PUBLIC_URL="$MCP_PUBLIC_URL" \
    CLAUDE_BIN="$CLAUDE_BIN" \
    pnpm exec tsx scripts/curator/run-maintenance.ts || MAINTENANCE_STATUS=$?
elif [[ "$MODE" == "remote" ]]; then
  echo "remote maintenance configuration is incomplete" >&2
  MAINTENANCE_STATUS=1
else
  echo "LTM_AUTO_MAINTENANCE_TOKEN is empty: project maintenance skipped"
fi

CURATION_STATUS=0
env -u LTM_AUTO_MAINTENANCE_TOKEN \
  DRY_RUN="$RUN_DRY_RUN" \
  LTM_MODE="$MODE" \
  MCP_PUBLIC_URL="$MCP_PUBLIC_URL" \
  LTM_MCP_TOKEN="$LTM_MCP_TOKEN" \
  FROM_DATE="${FROM_DATE:-}" \
  TO_DATE="${TO_DATE:-}" \
  GITHUB_EVENT_NAME="${GITHUB_EVENT_NAME:-schedule}" \
  CLAUDE_BIN="$CLAUDE_BIN" \
  pnpm exec tsx scripts/curator/run-dated-curation.ts || CURATION_STATUS=$?

if [[ "$MAINTENANCE_STATUS" != "0" || "$CURATION_STATUS" != "0" ]]; then
  echo "curator run failed: maintenance=$MAINTENANCE_STATUS curation=$CURATION_STATUS" >&2
  exit 1
fi

if [[ "$RUN_DRY_RUN" == "0" ]]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  echo "$STAMP" > "$LOG_DIR/last-success"
  chmod 600 "$LOG_DIR/last-success"
  echo "last-success updated"
else
  echo "DRY_RUN=1: last-success was not updated"
fi
