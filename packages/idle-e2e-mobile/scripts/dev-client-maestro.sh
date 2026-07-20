#!/usr/bin/env bash
# Run the unauthenticated mobile suite against an installed iOS development
# client served by a local Expo Metro process.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
APP_DIR="$REPO_ROOT/packages/idle-app"
E2E_DIR="$REPO_ROOT/packages/idle-e2e-mobile"
RUNTIME_BASE="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
RUNTIME_DIR="${IDLE_METRO_RUNTIME_DIR:-${RUNTIME_BASE%/}/idle-maestro-$(id -u)}"
METRO_LOG="$RUNTIME_DIR/metro.log"
METRO_PID_FILE="$RUNTIME_DIR/metro.pid"
SIM_UDID="${IDLE_SIM_UDID:-booted}"
DEV_APP_ID="${IDLE_APP_ID:-com.northglass.idle.dev}"
METRO_PORT="${METRO_PORT:-8081}"
PUBLIC_FLOWS=(
    "00-smoke.yaml"
    "01-auth.yaml"
)

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: required command not found: $1" >&2
        return 1
    fi
}

validate_configuration() {
    if [[ ! "$DEV_APP_ID" =~ ^[A-Za-z0-9.-]+$ ]]; then
        echo "error: IDLE_APP_ID is not a valid bundle identifier" >&2
        return 1
    fi
    if [[ ! "$METRO_PORT" =~ ^[0-9]+$ ]] || ((METRO_PORT < 1 || METRO_PORT > 65535)); then
        echo "error: METRO_PORT must be an integer from 1 through 65535" >&2
        return 1
    fi
    if [[ "$RUNTIME_DIR" != /* ]]; then
        echo "error: IDLE_METRO_RUNTIME_DIR must be an absolute path" >&2
        return 1
    fi
}

prepare_runtime_dir() {
    local current_uid owner mode
    current_uid="$(id -u)"
    umask 077

    if [[ -L "$RUNTIME_DIR" ]]; then
        echo "error: refusing symlinked Metro runtime directory" >&2
        return 1
    fi
    mkdir -p "$RUNTIME_DIR"
    if [[ -L "$RUNTIME_DIR" || ! -d "$RUNTIME_DIR" ]]; then
        echo "error: Metro runtime path is not a directory" >&2
        return 1
    fi

    owner="$(stat -f '%u' "$RUNTIME_DIR" 2>/dev/null || stat -c '%u' "$RUNTIME_DIR")"
    if [[ "$owner" != "$current_uid" ]]; then
        echo "error: Metro runtime directory is not owned by the current user" >&2
        return 1
    fi
    chmod 700 "$RUNTIME_DIR"
    mode="$(stat -f '%Lp' "$RUNTIME_DIR" 2>/dev/null || stat -c '%a' "$RUNTIME_DIR")"
    if [[ "$mode" != "700" ]]; then
        echo "error: Metro runtime directory permissions must be 0700" >&2
        return 1
    fi

    if [[ -L "$METRO_LOG" || -L "$METRO_PID_FILE" ]]; then
        echo "error: refusing symlinked Metro runtime files" >&2
        return 1
    fi
}

configure_java() {
    if command -v java >/dev/null 2>&1; then
        return 0
    fi
    if [[ -x /usr/libexec/java_home ]]; then
        JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || true)}"
        if [[ -n "$JAVA_HOME" ]]; then
            export JAVA_HOME
            export PATH="$JAVA_HOME/bin:$PATH"
        fi
    fi
    require_command java
}

metro_is_up() {
    command -v curl >/dev/null 2>&1 || return 1
    curl -fsSL -m 2 "http://127.0.0.1:${METRO_PORT}/status" 2>/dev/null |
        grep -q "packager-status:running"
}

validate_metro_pid() {
    local pid="$1" current_uid process_uid process_command port_flag port_equals
    if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
        echo "error: Metro PID file is invalid" >&2
        return 1
    fi

    current_uid="$(id -u)"
    process_uid="$(ps -p "$pid" -o uid= 2>/dev/null | tr -d '[:space:]')"
    process_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    port_flag="--port $METRO_PORT"
    port_equals="--port=$METRO_PORT"

    if [[ "$process_uid" != "$current_uid" ]]; then
        echo "error: refusing to signal a Metro PID not owned by the current user" >&2
        return 1
    fi
    if [[ "$process_command" != *"expo start"* ]]; then
        echo "error: refusing to signal a PID that is not Expo Metro" >&2
        return 1
    fi
    if [[ "$process_command" != *"$port_flag"* && "$process_command" != *"$port_equals"* ]]; then
        echo "error: refusing to signal an Expo process for another port" >&2
        return 1
    fi
}

metro_start() {
    require_command curl
    require_command npx
    if metro_is_up; then
        echo "Metro is running on port $METRO_PORT"
        return 0
    fi

    local key_path="${EXPO_UPDATE_PRIVATE_KEY:-}"
    if [[ -z "$key_path" || ! -f "$key_path" ]]; then
        echo "error: EXPO_UPDATE_PRIVATE_KEY must name a readable local OTA signing key" >&2
        return 1
    fi

    local metro_pid pid_temp
    rm -f "$METRO_LOG"
    (
        cd "$APP_DIR"
        exec nohup npx expo start \
            --dev-client \
            --port "$METRO_PORT" \
            --private-key-path "$key_path" \
            >"$METRO_LOG" 2>&1
    ) &
    metro_pid="$!"
    pid_temp="$(mktemp "$RUNTIME_DIR/metro.pid.XXXXXX")"
    printf '%s\n' "$metro_pid" >"$pid_temp"
    mv -f "$pid_temp" "$METRO_PID_FILE"

    for _ in $(seq 1 30); do
        sleep 1
        if metro_is_up; then
            echo "Metro is ready on port $METRO_PORT"
            return 0
        fi
    done
    echo "error: Metro did not become ready; inspect $METRO_LOG" >&2
    metro_stop || true
    return 1
}

metro_stop() {
    if [[ ! -f "$METRO_PID_FILE" ]]; then
        echo "Metro PID file is absent"
        return 0
    fi

    local pid
    pid="$(<"$METRO_PID_FILE")"
    if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
        echo "error: Metro PID file is invalid" >&2
        return 1
    fi
    if ! kill -0 -- "$pid" 2>/dev/null; then
        rm -f "$METRO_PID_FILE"
        return 0
    fi
    validate_metro_pid "$pid"
    kill -- "$pid"
    rm -f "$METRO_PID_FILE"
}

app_launch_with_metro() {
    require_command xcrun
    if ! xcrun simctl get_app_container "$SIM_UDID" "$DEV_APP_ID" app >/dev/null 2>&1; then
        echo "error: install a development-simulator build for $DEV_APP_ID on $SIM_UDID" >&2
        echo "Set IDLE_APP_ID when the installed development bundle uses another identifier." >&2
        return 1
    fi

    # Maestro owns launchApp; terminating here gives each flow one launch owner.
    xcrun simctl terminate "$SIM_UDID" "$DEV_APP_ID" 2>/dev/null || true
}

run_flow() {
    local flow="$1"
    configure_java
    require_command maestro
    metro_start
    app_launch_with_metro
    (
        cd "$E2E_DIR"
        maestro test "flows/$flow" -e APP_ID="$DEV_APP_ID"
    )
}

run_public_suite() {
    local failed=0
    for flow in "${PUBLIC_FLOWS[@]}"; do
        if ! run_flow "$flow"; then
            failed=$((failed + 1))
        fi
    done
    return "$failed"
}

validate_configuration

command_name="${1:-help}"
shift || true
case "$command_name" in
    smoke)
        prepare_runtime_dir
        run_flow "${1:-00-smoke.yaml}"
        ;;
    all-public)
        prepare_runtime_dir
        run_public_suite
        ;;
    metro-status)
        prepare_runtime_dir
        if metro_is_up; then
            echo "Metro is running on port $METRO_PORT"
        else
            echo "Metro is not running on port $METRO_PORT"
            exit 1
        fi
        ;;
    metro-start)
        prepare_runtime_dir
        metro_start
        ;;
    metro-stop)
        prepare_runtime_dir
        metro_stop
        ;;
    metro-restart)
        prepare_runtime_dir
        metro_stop
        metro_start
        ;;
    help|*)
        echo "usage: $0 {smoke [flow.yaml] | all-public | metro-status | metro-start | metro-stop | metro-restart}" >&2
        exit 64
        ;;
esac
