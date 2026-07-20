#!/usr/bin/env bash
# Public wrapper retained for hooks and existing automation.

set -euo pipefail

git rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo 'upstream boundary check requires a Git worktree' >&2
  exit 2
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/check-upstream-cruft.mjs" "$@"
