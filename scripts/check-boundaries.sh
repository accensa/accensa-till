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

# The barrel is not browser-safe: packages/core/src/index.ts re-exports ids.ts and
# auth/nep413.ts, both of which import node:crypto, and webpack cannot put a node:
# specifier in a client bundle. `next build` failed on exactly that (`@till/core` ->
# ids.ts -> node:crypto) the first time a client component read a schema. The
# dashboard takes the subtrees that are pure instead: ./schemas, ./money, ./states.
hits=$(violations_in 'from "@till/core"' 'never-matches' apps/web)
[ -z "$hits" ] || report "apps/web must import the browser-safe subtrees (@till/core/schemas, @till/core/money), not the barrel (it reaches node:crypto)" "$hits"

# The rule above is a string match and can only see the specifier a file writes. The
# invariant is about the bundle: everything apps/web imports has to be buildable for a
# browser. A core subtree that re-exports `ids.ts` breaks that without naming
# `@till/core` anywhere — observed 2026-11-05 with `pnpm boundaries` printing `ok`
# while `next build` failed on `UnhandledSchemeError: Reading from "node:crypto"`. So
# the check is the bundler itself. Cost: ~16s, and `env -u` because pnpm sets
# npm_config_node_link_workspace_packages, which makes webpack resolve to a path that
# starts `../`.
if [ -x apps/web/node_modules/.bin/next ]; then
  web_log=$(mktemp)
  if ! (cd apps/web && env -u npm_config_node_link_workspace_packages ./node_modules/.bin/next build) >"$web_log" 2>&1; then
    report "apps/web does not build, so what it imports cannot become a browser bundle" "$(grep -E 'UnhandledSchemeError|Module not found|Module build failed|^node:' "$web_log" | sort -u | head -8)"
  fi
  rm -f "$web_log"
fi

hits=$(violations_in 'from "(drizzle-orm|postgres|hono|next|react|@till/api)' 'never-matches' packages/core)
[ -z "$hits" ] || report "packages/core must stay pure: no database, HTTP or framework imports" "$hits"

hits=$(violations_in '@fastnear' 'x402/near\.ts' apps/api/src)
[ -z "$hits" ] || report "only x402/near.ts may import @fastnear (hard rule 1)" "$hits"

hits=$(violations_in '1Click|ONECLICK_' 'payouts/oneclick/(client|map-status)\.ts|env\.ts' apps/api/src)
[ -z "$hits" ] || report "1Click may only be touched from payouts/oneclick (hard rule 5)" "$hits"

hits=$(violations_in 'insert\(ledgerEntries\)|into ledger_entries' 'services/ledger\.ts' apps/api/src)
[ -z "$hits" ] || report "only services/ledger.ts inserts into ledger_entries (hard rule 4)" "$hits"

# D5 (PO-1, PO-7): a payout route is written once, by one module, and never again.
# Migration 0007 puts a trigger behind the UPDATE, but a trigger only fires on a row
# that exists in a real database at runtime; these greps are the version that fails a
# `pnpm boundaries` run instead of a seller's payout.
hits=$(violations_in 'insert\(payoutRoutes\)' 'services/payout-routes\.ts' apps/api/src)
[ -z "$hits" ] || report "only services/payout-routes.ts inserts into payout_routes (D5, PO-1)" "$hits"

hits=$(violations_in 'update\(payoutRoutes\)|delete\(payoutRoutes\)|into payout_routes|payout_routes set' 'never-matches' apps/api/src)
[ -z "$hits" ] || report "payout_routes is never rewritten from application code: insert a new route (D5, PO-7)" "$hits"

hits=$(violations_in 'from "\.\./(db|services)/' 'never-matches' apps/api/src/payouts apps/api/src/x402)
[ -z "$hits" ] || report "payouts/ and x402/ must not import upward from db/ or services/" "$hits"

hits=$(violations_in '[Aa]mount[A-Za-z]* *= *-?[0-9]+\.[0-9]+' 'never-matches' apps/api/src packages/core/src)
[ -z "$hits" ] || report "money must be bigint base units, never a float literal (hard rule 3)" "$hits"

# C15: zod v3 accumulates one issue object per failing array element, so an
# uncapped array at the JSON boundary turns a large payload into megabytes of
# error. boundedArray() is the only way to write one, and it lives in common.ts.
hits=$(violations_in '\.array\(' 'schemas/common\.ts' packages/core/src/schemas)
[ -z "$hits" ] || report "array schemas must use boundedArray() from schemas/common.ts (C15)" "$hits"

if [ "$fail" -ne 0 ]; then
  echo
  echo "boundary check failed — see docs/PROJECT_STRUCTURE.md \"Dependency rules\""
  exit 1
fi

echo "boundaries ok"
