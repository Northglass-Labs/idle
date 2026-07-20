#!/usr/bin/env bash
# Run one or all authenticated Maestro flows against an installed iOS
# simulator build. Pair the app through the normal Idle account-linking flow
# before invoking this script.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_ID="${IDLE_APP_ID:-com.northglass.idle.preview}"
SIMULATOR_UDID="${IDLE_SIMULATOR_UDID:-}"
ARTIFACT_ROOT="${IDLE_MAESTRO_ARTIFACT_ROOT:-}"
INFRA_RETRIES="${IDLE_MAESTRO_INFRA_RETRIES:-1}"
AUTHENTICATED_FLOWS=(
    "02-open-session.yaml"
    "03-compose-message.yaml"
    "04-long-press-menu.yaml"
    "05-effort-picker.yaml"
    "06-think-autocomplete.yaml"
    "07-timestamp-display.yaml"
    "08-context-indicator.yaml"
    "09-open-links-in-toggle.yaml"
    "10-ultrathink-strip.yaml"
    "11-connection-status-sheet.yaml"
    "13-lab-subscreen.yaml"
)

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: required command not found: $1" >&2
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

normalize_flow() {
    local requested="$1"
    requested="${requested#flows/}"
    if [[ ! "$requested" =~ ^[0-9]{2}-[a-z0-9-]+\.yaml$ ]]; then
        echo "error: unsupported flow name" >&2
        return 1
    fi
    if [[ ! -f "$E2E_DIR/flows/$requested" ]]; then
        echo "error: flow file not found: flows/$requested" >&2
        return 1
    fi
    printf '%s\n' "$requested"
}

simulator_ready() {
    xcrun simctl spawn "$SIMULATOR_UDID" \
        launchctl print user/foreground/com.apple.SpringBoard >/dev/null 2>&1
}

recover_simulator() {
    echo "Recovering simulator $SIMULATOR_UDID after a Maestro infrastructure failure" >&2
    xcrun simctl shutdown "$SIMULATOR_UDID" >/dev/null 2>&1 || true
    xcrun simctl boot "$SIMULATOR_UDID" >/dev/null
    xcrun simctl bootstatus "$SIMULATOR_UDID" -b >/dev/null
    simulator_ready
}

ensure_simulator_ready() {
    if simulator_ready; then
        return 0
    fi
    recover_simulator
}

is_infrastructure_only_failure() {
    local output_log="$1"
    if grep -Eqi 'Assertion is false|Assertion .* failed' "$output_log"; then
        return 1
    fi
    grep -Eqi \
        'Simulator device failed|system shell .*probably crashed|failed to connect.*xctest|xctrunner.*(failed|crashed)|NSPOSIXErrorDomain, code=64' \
        "$output_log"
}

run_maestro_attempt() {
    local flow="$1"
    local attempt_dir="$2"
    local flow_debug_dir="$attempt_dir/debug"
    local flow_test_dir="$attempt_dir/tests"
    local output_log="$attempt_dir/maestro-output.log"
    local pipeline_status

    mkdir -p "$flow_debug_dir" "$flow_test_dir"
    (
        cd "$E2E_DIR"
        maestro --device "$SIMULATOR_UDID" test "flows/$flow" \
            --no-ansi \
            --debug-output "$flow_debug_dir" \
            --test-output-dir "$flow_test_dir" \
            -e APP_ID="$APP_ID"
    ) 2>&1 | tee "$output_log"
    pipeline_status=("${PIPESTATUS[@]}")
    if ((pipeline_status[1] != 0)); then
        return "${pipeline_status[1]}"
    fi
    return "${pipeline_status[0]}"
}

if [[ ! "$APP_ID" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "error: IDLE_APP_ID is not a valid bundle identifier" >&2
    exit 64
fi

require_command xcrun
require_command maestro
require_command tee
configure_java

if [[ ! "$INFRA_RETRIES" =~ ^[01]$ ]]; then
    echo "error: IDLE_MAESTRO_INFRA_RETRIES must be 0 or 1" >&2
    exit 64
fi

if [[ -n "$SIMULATOR_UDID" && ! "$SIMULATOR_UDID" =~ ^[A-Fa-f0-9-]{36}$ ]]; then
    echo "error: IDLE_SIMULATOR_UDID is not a valid simulator identifier" >&2
    exit 64
fi
if [[ -z "$SIMULATOR_UDID" ]]; then
    booted_simulators=()
    while IFS= read -r udid; do
        [[ -n "$udid" ]] && booted_simulators+=("$udid")
    done < <(xcrun simctl list devices booted 2>/dev/null \
        | sed -nE 's/.*\(([A-Fa-f0-9-]{36})\) \(Booted\).*/\1/p')
    if ((${#booted_simulators[@]} == 0)); then
        echo "error: no iOS simulator is booted" >&2
        exit 1
    fi
    if ((${#booted_simulators[@]} != 1)); then
        echo "error: multiple iOS simulators are booted; set IDLE_SIMULATOR_UDID" >&2
        exit 64
    fi
    SIMULATOR_UDID="${booted_simulators[0]}"
elif ! xcrun simctl list devices booted 2>/dev/null \
    | grep -Fq "($SIMULATOR_UDID) (Booted)"; then
    echo "error: IDLE_SIMULATOR_UDID is not booted" >&2
    exit 1
fi

ensure_simulator_ready

if ! xcrun simctl get_app_container "$SIMULATOR_UDID" "$APP_ID" app >/dev/null 2>&1; then
    echo "error: $APP_ID is not installed on the booted simulator" >&2
    echo "Install a simulator build and set IDLE_APP_ID when its bundle identifier differs." >&2
    exit 1
fi

if [[ -z "$ARTIFACT_ROOT" ]]; then
    ARTIFACT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/idle-maestro-release.XXXXXX")"
elif [[ "$ARTIFACT_ROOT" != /* ]]; then
    echo "error: IDLE_MAESTRO_ARTIFACT_ROOT must be an absolute path" >&2
    exit 64
else
    mkdir -p "$ARTIFACT_ROOT"
fi
if [[ -L "$ARTIFACT_ROOT" || ! -d "$ARTIFACT_ROOT" ]]; then
    echo "error: Maestro artifact root must be a real directory" >&2
    exit 64
fi
chmod 700 "$ARTIFACT_ROOT"
RUN_DIR="$ARTIFACT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$RUN_DIR"
echo "Private Maestro artifacts: $RUN_DIR"

if (($# == 0)); then
    requested_flows=("${AUTHENTICATED_FLOWS[@]}")
else
    requested_flows=("$@")
fi

for requested in "${requested_flows[@]}"; do
    flow="$(normalize_flow "$requested")"
    if [[ "$flow" =~ ^1[456]- && "${IDLE_RELEASE_LIVE_TEST:-}" != "1" ]]; then
        echo "error: set IDLE_RELEASE_LIVE_TEST=1 to run live-provider release flows" >&2
        exit 64
    fi
    flow_stem="${flow%.yaml}"
    attempt=0
    while true; do
        attempt=$((attempt + 1))
        attempt_dir="$RUN_DIR/$flow_stem/attempt-$attempt"
        echo "Running flows/$flow against $APP_ID (attempt $attempt)"
        ensure_simulator_ready
        if run_maestro_attempt "$flow" "$attempt_dir"; then
            break
        else
            status=$?
        fi
        output_log="$attempt_dir/maestro-output.log"
        if ((attempt > INFRA_RETRIES)) || ! is_infrastructure_only_failure "$output_log"; then
            exit "$status"
        fi
        recover_simulator
    done
done
