#!/bin/sh
# Import-boundary check (task A8). Rules come from docs/PROJECT_STRUCTURE.md
# "Dependency rules"; violating them is a bug, so this fails the build.
#
# Why grep instead of a tool: it needs no dependency, runs in milliseconds, and
# the rules are about *which file* a symbol may appear in, which a type checker
# cannot express.
#
# Comment lines are stripped before matching. Without that, this checker failed
# on its own explanatory comments — a doc comment that says "only oneclick/
# client.ts calls 1Click" would otherwise look like a violation from a file that
# contains no such call.
set -eu

cd "$(dirname "$0")/.."
fail=0

# code_grep <pattern> <paths...> : report pattern hits on non-comment lines.
code_grep() {
  pattern="$1"
  shift
  for path in "$@"; do
    [ -d "$path" ] || continue
    for f in $(find "$path" \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' -not -path '*/.next/*'); do
      grep -vE '^[[:space:]]*(\*|//|/\*)' "$f" | grep -nE "$pattern" | sed "s|^|$f:|" || true
    done
  done
}

report() {
  echo "FAIL: $1"
  printf '%s\n' "$2" | sed 's/^/      /'
  fail=1
}

violations_in() {
  # violations_in <pattern> <allowed-regex> <paths...>
  pattern="$1"
  allowed="$2"
  shift 2
  code_grep "$pattern" "$@" | grep -vE "$allowed" || true
}

hits=$(violations_in 'from "(@till/api|\.\./\.\./api/)' 'never-matches' apps/web)
[ -z "$hits" ] || report "apps/web must not import from apps/api (single origin over HTTP)" "$hits"

hits=$(violations_in 'from "(drizzle-orm|postgres|hono|next|react|@till/api)' 'never-matches' packages/core)
[ -z "$hits" ] || report "packages/core must stay pure: no database, HTTP or framework imports" "$hits"

hits=$(violations_in '@fastnear' 'x402/near\.ts' apps/api/src)
[ -z "$hits" ] || report "only x402/near.ts may import @fastnear (hard rule 1)" "$hits"

hits=$(violations_in '1Click|ONECLICK_' 'payouts/oneclick/(client|map-status)\.ts|env\.ts' apps/api/src)
[ -z "$hits" ] || report "1Click may only be touched from payouts/oneclick (hard rule 5)" "$hits"

hits=$(violations_in 'insert\(ledgerEntries\)|into ledger_entries' 'services/ledger\.ts' apps/api/src)
[ -z "$hits" ] || report "only services/ledger.ts inserts into ledger_entries (hard rule 4)" "$hits"

hits=$(violations_in 'from "\.\./(db|services)/' 'never-matches' apps/api/src/payouts apps/api/src/x402)
[ -z "$hits" ] || report "payouts/ and x402/ must not import upward from db/ or services/" "$hits"

hits=$(violations_in '[Aa]mount[A-Za-z]* *= *-?[0-9]+\.[0-9]+' 'never-matches' apps/api/src packages/core/src)
[ -z "$hits" ] || report "money must be bigint base units, never a float literal (hard rule 3)" "$hits"

if [ "$fail" -ne 0 ]; then
  echo
  echo "boundary check failed — see docs/PROJECT_STRUCTURE.md \"Dependency rules\""
  exit 1
fi

echo "boundaries ok"
