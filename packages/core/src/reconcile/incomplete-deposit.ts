import type { Finding, ReconcileRule } from "./types.ts";

/**
 * INCOMPLETE_DEPOSIT (LR-6, P1, Medium): a deposit landed smaller than the
 * price it was meant to cover.
 *
 * BLOCKED ON S2 — this rule needs the deposit listing shape. Whether a standing
 * deposit address reports deposits, and whether those records carry an amount
 * and an origin hash, is unknown until `docs/spikes/S2.md` exists
 * (ARCHITECTURE.md hard rule 13: do not build on a VERIFY item). It returns no
 * findings rather than guessing at a shape, and B8 decides whether this rule
 * survives at all.
 */
export const incompleteDeposit: ReconcileRule = (_snapshot): readonly Finding[] => {
  return [];
};
