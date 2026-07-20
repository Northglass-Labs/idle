#!/usr/bin/env bash
# Enforce the publication boundary for this public repository.

set -euo pipefail

defer_upstream_baseline=0
if [[ "$#" -eq 1 && "$1" == "--defer-upstream-baseline" ]]; then
  # A candidate import is still checked by the exact staged-delta guard. The
  # full-tree occurrence baseline is enforced after its isolated final policy
  # commit, so a newly reviewed compatibility symbol can be staged safely.
  defer_upstream_baseline=1
elif [[ "$#" -ne 0 ]]; then
  echo 'usage: check-docs-hygiene.sh [--defer-upstream-baseline]' >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/idle-public-hygiene.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

fail=0
report() {
  printf 'PUBLIC-HYGIENE  %s\n' "$1" >&2
  fail=1
}

while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  [[ -e "$file" || -L "$file" ]] || continue
  case "$file" in
    docs/adr/*|docs/plans/*|docs/superpowers/*|docs/research/*|docs/app-store/*|docs/legal/*)
      report "$file is an internal documentation path" ;;
    docs/INVENTORY.md|docs/AUDIT-*|docs/*-audit-*.md|docs/*-sprint-*.md|docs/*-handoff*.md)
      report "$file is dated operator state" ;;
    docs/3dparty.md)
      report "$file is an internal service inventory" ;;
    docs/[0-9][0-9][0-9][0-9]-[0-9][0-9]-*|docs/*/[0-9][0-9][0-9][0-9]-[0-9][0-9]-*)
      report "$file is a dated internal document" ;;
    AGENTS.md|*/AGENTS.md|*/**/AGENTS.md|CLAUDE.md|*/CLAUDE.md|*/**/CLAUDE.md|.agents/*|*/.agents/*|.claude/*|*/.claude/*|.codex/*|*/.codex/*|.mcp.json|*/.mcp.json|.cursorrules|*/.cursorrules|*/**/.cursorrules)
      report "$file is maintainer-local agent/tool configuration" ;;
    scripts/check-testflight.sh|scripts/fix-codesign-keychain.sh|scripts/patch-eas-keychain.cjs|scripts/refresh-local-idle.sh|scripts/release-build-local.sh|scripts/release-build.sh|scripts/release.cjs|scripts/setup-local-signing.sh|packages/idle-app/.eas/workflows/*|packages/idle-app/release-dev.sh|packages/idle-app/release-production.sh|packages/idle-app/release.cjs)
      report "$file is production release automation" ;;
    packages/idle-app-logs/*|scripts/clean-slate.sh|scripts/_generate-social-card.ts|scripts/generate-brand-pngs.ts|packages/idle-cli/experiments/*|packages/idle-cli/demo-project/*|packages/idle-cli/scripts/test-continue-fix.sh|packages/idle-cli/scripts/download-tools.sh|packages/idle-cli/scripts/unpack-tools.cjs|packages/idle-cli/src/modules/difftastic/*|packages/idle-cli/tools/*)
      report "$file is a retired maintainer-only utility" ;;
    packages/idle-app/sources/docs/autocomplete-text-manipulation.md|packages/idle-cli/experiments/NOTES.md|packages/idle-cli/agents.md|environments/lab-rat-todo-project/exercise-flow.md)
      report "$file is an internal research or test-strategy note" ;;
    packages/idle-server/sources/recipes/*)
      report "$file is an internal operator recipe" ;;
    packages/idle-app/sources/app/\(app\)/dev/*|packages/idle-app/sources/dev/*|packages/idle-app/sources/hooks/useDemoMessages.ts|packages/idle-app/sources/*.appspec.ts|packages/idle-app/sources/**/*.appspec.ts)
      report "$file is a production-bundled app development fixture" ;;
    packages/idle-app/sources/app/test-auth.tsx|packages/idle-server/sources/app/api/routes/testRoutes.ts|packages/idle-server/sources/app/api/routes/testRoutes.spec.ts|packages/idle-e2e-mobile/scripts/run-auth-flow.sh)
      report "$file is a credential-injection harness outside the public boundary" ;;
    packages/idle-app/sources/app/\(app\)/friends/*|packages/idle-app/sources/app/\(app\)/inbox/*|packages/idle-app/sources/app/\(app\)/user/*)
      report "$file is a production-bundled social-network route" ;;
    packages/idle-server/sources/app/api/routes/feedRoutes.ts|packages/idle-server/sources/app/api/routes/userRoutes.ts|packages/idle-server/sources/app/feed/*|packages/idle-server/sources/app/social/*)
      report "$file is a dormant server social-network surface" ;;
  esac
done < <({ git ls-files; git ls-files --others --exclude-standard; } | sort -u)

if git grep --untracked -lI -E 'docs/adr/|\bADR-[0-9]{3}\b' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/adr-hits" 2>/dev/null; then
  report 'public files still reference private decision records'
  sed 's/^/  /' "$tmp_dir/adr-hits" >&2
fi

gmail_hits="$(git grep --untracked -lI -i '@gmail\.com' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' 2>/dev/null || true)"
if [[ -n "$gmail_hits" ]]; then
  report 'personal Gmail-shaped content is not allowed'
  printf '%s\n' "$gmail_hits" | sed 's/^/  /' >&2
fi

northglass_mail_hits="$(git grep --untracked -nI -i -E '[A-Z0-9._%+-]+@northglass\.io' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' 2>/dev/null \
  | grep -vi 'hello@northglass\.io' \
  | cut -d: -f1 \
  | sort -u || true)"
if [[ -n "$northglass_mail_hits" ]]; then
  report 'Northglass contact surfaces must use hello@northglass.io'
  printf '%s\n' "$northglass_mail_hits" | sed 's/^/  /' >&2
fi

if git grep --untracked -lI -i -E 'Apple ID email|email address for the TestFlight' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/intake-hits" 2>/dev/null; then
  report 'public files must not solicit an Apple account email'
  sed 's/^/  /' "$tmp_dir/intake-hits" >&2
fi

if git grep --untracked -lI -E 'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING|logs-combined-from-cli-and-mobile-for-simple-ai-debugging' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/remote-log-hits" 2>/dev/null; then
  report 'public builds must not contain the internal remote-log collection path'
  sed 's/^/  /' "$tmp_dir/remote-log-hits" >&2
fi

if git grep --untracked -lI -E 'EXPO_PUBLIC_LOG_SERVER_URL|log-server-url|getLogServerUrl|setLogServerUrl' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/app-log-egress-hits" 2>/dev/null; then
  report 'public app builds must not contain configurable console-log egress'
  sed 's/^/  /' "$tmp_dir/app-log-egress-hits" >&2
fi

if git grep --untracked -lI -F 'fetchVoiceCredentials response' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/voice-token-log-hits" 2>/dev/null; then
  report 'voice conversation credentials must never be written to console output'
  sed 's/^/  /' "$tmp_dir/voice-token-log-hits" >&2
fi

if git grep --untracked -lI -E '\bdebugMode\b|devModeEnabled|voiceUpsellOverride|consoleLoggingEnabled|consoleLoggingDefault|verboseLogging|developerTools|rawJsonDevMode|developerModeEnabled|developerModeDisabled' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/app-dev-setting-hits" 2>/dev/null; then
  report 'public app builds must not persist internal diagnostic switches'
  sed 's/^/  /' "$tmp_dir/app-dev-setting-hits" >&2
fi

if git grep --untracked -lI -E 'EXPO_PUBLIC_E2E_TEST_AUTH|IDLE_ENABLE_TEST_ENDPOINTS|IDLE_TEST_ENDPOINTS_SECRET|/v1/test/|idle://test-auth|EXPO_PUBLIC_DEV_TOKEN|EXPO_PUBLIC_DEV_SECRET|dev_token|dev_secret|authenticatedWebUrl|Auth URL:' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/test-auth-injection-hits" 2>/dev/null; then
  report 'public code must not contain dormant credential-injection routes'
  sed 's/^/  /' "$tmp_dir/test-auth-injection-hits" >&2
fi

if git grep --untracked -lI -E '/v1/friends|/v1/feed|/v1/user/(search|:id)|relationship-updated|new-feed-post|friends_(search|profile_view|connect)' -- . \
  ':(exclude)scripts/check-docs-hygiene.sh' >"$tmp_dir/social-endpoint-hits" 2>/dev/null; then
  report 'public code must not expose the retired social-network API or update protocol'
  sed 's/^/  /' "$tmp_dir/social-endpoint-hits" >&2
fi

if git grep --untracked -lI -E 'session_id|conversation_id|initial_url|captureAppLifecycleEvents:[[:space:]]*true|enableSessionReplay:[[:space:]]*true' -- \
  packages/idle-app/sources/track \
  packages/idle-app/sources/-session/SessionView.tsx \
  ':(exclude)**/*.test.ts' >"$tmp_dir/analytics-sensitive-hits" 2>/dev/null; then
  report 'analytics capture surfaces must not contain session/conversation IDs, initial URLs, lifecycle capture, or session replay'
  sed 's/^/  /' "$tmp_dir/analytics-sensitive-hits" >&2
fi

if git grep --untracked -lI -E 'tracking\??\.capture\(' -- \
  packages/idle-app/sources \
  ':(exclude)packages/idle-app/sources/track/index.ts' \
  ':(exclude)**/*.test.ts' >"$tmp_dir/direct-analytics-hits" 2>/dev/null; then
  report 'analytics events must pass through the explicit privacy-shaping module'
  sed 's/^/  /' "$tmp_dir/direct-analytics-hits" >&2
fi

if ! node scripts/opsec-boundary.mjs; then
  fail=1
fi

if [[ "$defer_upstream_baseline" -eq 0 ]] && ! scripts/check-upstream-cruft.sh; then
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo 'public repository hygiene check passed'
