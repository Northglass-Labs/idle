#!/usr/bin/env bash
# Run the live-provider simulator release sequence after the app and an
# isolated CLI profile have been paired through the normal protocol.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${IDLE_RELEASE_LIVE_TEST:-}" != "1" ]]; then
    echo "error: set IDLE_RELEASE_LIVE_TEST=1 to acknowledge that this creates real provider sessions" >&2
    exit 64
fi

"$SCRIPT_DIR/run-authed.sh" flows/14-live-codex-session.yaml
"$SCRIPT_DIR/run-authed.sh" flows/15-live-claude-session.yaml
"$SCRIPT_DIR/run-authed.sh" flows/16-live-session-relaunch.yaml
