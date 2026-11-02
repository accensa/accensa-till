## What changed

One requirement or one task. Name the `ROADMAP.md` task ID and the requirement ID
from `docs/PRD.md` section 6.

## Checklist

- [ ] `ROADMAP.md` was updated **in this branch**: task status, `Evidence:` line,
      requirement matrix, spikes or decisions if affected, one changelog line, then
      `pnpm roadmap`. A change that does not update it is not done, even if it only
      touches docs (DQ-5, AGENTS.md hard rule 14).
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm boundaries && pnpm roadmap:check`
      all pass locally, and the output was read rather than skimmed.
- [ ] `pnpm demo` passes if the change touches gateway, payouts, ledger or
      reconciliation.
- [ ] `.env.example`, migrations and docs updated in the same change if affected.
- [ ] No dependency added without asking (AGENTS.md "Working method" 6).
- [ ] No mainnet transaction, funded key or paid API call — unless a human asked
      for that specific action in this session.

## Evidence

Paste the command and what it printed. "Tests pass" and "works end to end" are
different claims; state which one you verified, and which you did not.

## What is still unverified

Spikes not closed, VERIFY items relied on, manual checks not done.
