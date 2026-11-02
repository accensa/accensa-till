#!/bin/sh
# pnpm roadmap:check half one (task A9, DQ-5): any change that touches the
# repository but leaves ROADMAP.md untouched is not done. The rule is in
# AGENTS.md and docs/ARCHITECTURE_ESSENTIALS.md hard rule 14; this makes it
# machine-enforced so it survives a busy deadline.
#
# Base ref resolution: CI gives us the PR target; locally we fall back to the
# merge-base with main.
set -eu

cd "$(dirname "$0")/.."

if [ -n "${GITHUB_BASE_REF:-}" ]; then
  base="origin/$GITHUB_BASE_REF"
  git fetch --no-tags origin "$GITHUB_BASE_REF" >/dev/null 2>&1 || true
  # With a shallow checkout the base ref may not exist here. Saying so beats
  # `set -e` aborting on a git error, and the progress block check that ran
  # before this script still catches a stale ROADMAP.md.
  if ! git rev-parse --verify --quiet "$base" >/dev/null; then
    echo "roadmap check: $base is not in this checkout (ci.yml needs fetch-depth: 0); skipped"
    exit 0
  fi
  changed=$(git diff --name-only "$base"...HEAD)
else
  base=$(git rev-parse --verify origin/main 2>/dev/null || git rev-parse HEAD)
  # Agents are told to run this before committing (AGENTS.md rule 5), so the
  # working tree counts here. A commit-to-commit diff would report "nothing to
  # enforce" for exactly the change being checked, which is a false pass.
  changed=$(
    {
      git diff --name-only "$base"...HEAD 2>/dev/null || true
      git diff --name-only HEAD || true
      git ls-files --others --exclude-standard || true
    } | grep -v '^$' | sort -u
  )
fi

if [ -z "$changed" ]; then
  echo "roadmap check: no changed files against $base, nothing to enforce"
  exit 0
fi

# Docs-only edits to ROADMAP's own companions are still required to update the
# roadmap, so there is no exemption list here on purpose.
if printf '%s\n' "$changed" | grep -qx 'ROADMAP.md'; then
  echo "roadmap check: ok, ROADMAP.md is part of this change"
  exit 0
fi

echo "FAIL: this change touches files but not ROADMAP.md."
echo "      Update task status, Evidence and a changelog line, then run \`pnpm roadmap\`."
printf '%s\n' "$changed" | sed 's/^/        /' | head -20
total=$(printf '%s\n' "$changed" | wc -l | tr -d ' ')
[ "$total" -le 20 ] || echo "        … $((total - 20)) more"
exit 1
