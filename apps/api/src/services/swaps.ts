import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { endpoints, payments, payoutRoutes, swaps } from "../db/schema.ts";

/**
 * The only writer of the link between a payment and a swap (LR-2, D13).
 *
 * The join is the transaction hash and nothing else: `swaps.origin_tx_hash` is the
 * deposit the provider reported, `payments.near_tx_hash` is the settlement the
 * gateway stamped, and the receipt header carries the same string, so one value
 * links the two sides (ARCHITECTURE 4.2 step 9). Matching by amount and time is
 * forbidden — hard rule 5, risk B6 — because a heuristic that pairs the wrong two
 * makes a genuine shortfall or a genuine orphan look clean, which is the exact
 * failure the product exists to catch. An unmatched swap is therefore a fact to
 * report, with the reason, and never a gap to fill by guessing.
 *
 * Three things this deliberately does not filter on, all because the join's job is
 * identity and the rules' job is interpretation:
 *
 * - **payment state.** A `verified` row already carries its hash (C10 stamps it
 *   before the terminal move) and an `abandoned` row can keep one (C10's sweep
 *   leaves it when the chain says the transfer failed). Refusing either would hide
 *   precisely the pairs reconciliation has to see, and would make the link depend on
 *   which side settled first.
 * - **the route.** The candidate set is scoped to the swap's own *seller*, through
 *   the route the swap carries, and not to the route itself: PO-7 keeps an old
 *   payment on the route it was opened under while the swap that moves that money
 *   can be created after the destination moved, so a route-scoped join would drop
 *   the pairs that matter most. The seller scope is access control rather than
 *   matching — one hash is one chain transaction, so it cannot reject a true pair,
 *   but it stops one seller's swap being pointed at another seller's payment.
 * - **how many.** One hash, two payments is reported as ambiguous and links
 *   nothing, because picking one would hide the other.
 */

export type UnlinkedReason = "no_origin_hash" | "no_candidate" | "ambiguous";

export type SwapLink =
  /** This call wrote the link. */
  | { readonly kind: "linked"; readonly paymentId: string }
  /**
   * The swap points at a payment already, either because it did before this call or
   * because a writer that raced it committed first. A link is made once: re-matching
   * a matched swap would let a later poll move money onto a different payment.
   */
  | { readonly kind: "already_linked"; readonly paymentId: string }
  /**
   * No link, with the reason. `candidates` is empty except for `ambiguous`, where it
   * names the payments sharing one hash — which is what a caller logs, because that
   * choice is not Till's to make.
   */
  | {
      readonly kind: "unlinked";
      readonly reason: UnlinkedReason;
      readonly candidates: readonly string[];
    };

type SwapState = {
  readonly paymentId: string | null;
  readonly originTxHash: string | null;
  readonly sellerId: string;
};

/** The swap's own recorded hash, never a hash a caller passes in. */
async function swapState(db: Db, swapId: string): Promise<SwapState | null> {
  const rows = await db
    .select({
      paymentId: swaps.paymentId,
      originTxHash: swaps.originTxHash,
      sellerId: payoutRoutes.sellerId,
    })
    .from(swaps)
    .innerJoin(payoutRoutes, eq(payoutRoutes.id, swaps.routeId))
    .where(eq(swaps.id, swapId));
  return rows[0] ?? null;
}

async function candidateIds(db: Db, hash: string, sellerId: string): Promise<string[]> {
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(endpoints, eq(endpoints.id, payments.endpointId))
    .where(and(eq(payments.nearTxHash, hash), eq(endpoints.sellerId, sellerId)));
  return rows.map((row) => row.id);
}

/**
 * Point one swap at the payment whose settlement hash it carries, or say why it
 * cannot.
 *
 * The write is compare-and-set on `payment_id is null` rather than a lock, for the
 * same reason C7's reopen is: the invariant is "a swap is linked once", and a
 * predicate on the row states it where a reader can see it. A loop that claims its
 * swaps before polling them (D6, `FOR UPDATE SKIP LOCKED`) will rarely meet a
 * contested row; if it does, the loser reports the link that actually won instead of
 * writing its own or throwing at a caller who has nothing to decide.
 *
 * An empty or blank hash is treated as no hash at all, because a JSON field with no
 * value often arrives as `""`, and matching one would pair every such swap with
 * every such payment.
 */
export async function linkSwapByHash(db: Db, swapId: string): Promise<SwapLink> {
  const swap = await swapState(db, swapId);
  if (swap === null) {
    throw new Error(`no swap ${swapId}`);
  }
  if (swap.paymentId !== null) {
    return { kind: "already_linked", paymentId: swap.paymentId };
  }

  const hash = swap.originTxHash;
  if (hash === null || hash.trim() === "") {
    return { kind: "unlinked", reason: "no_origin_hash", candidates: [] };
  }

  const candidates = await candidateIds(db, hash, swap.sellerId);
  if (candidates.length === 0) {
    return { kind: "unlinked", reason: "no_candidate", candidates: [] };
  }
  if (candidates.length > 1) {
    return { kind: "unlinked", reason: "ambiguous", candidates };
  }

  const [paymentId] = candidates;
  if (paymentId === undefined) {
    // The two length branches above make this unreachable; the element read still
    // has to answer because the array is typed per element and not per length.
    throw new Error(`unreachable: ${candidates.length} candidates named none`);
  }
  const written = await db
    .update(swaps)
    .set({ paymentId })
    .where(and(eq(swaps.id, swapId), isNull(swaps.paymentId)))
    .returning({ id: swaps.id });

  // What is confirmed is that a row landed, not the value written: a link that matched
  // no row must not be reported as one that did.
  if (written.length === 1) {
    return { kind: "linked", paymentId };
  }

  // Someone linked it between the read and the write. Report the winner's link:
  // the caller asked what this swap points at, and that answer is true either way.
  const raced = await swapState(db, swapId);
  if (raced?.paymentId === undefined || raced.paymentId === null) {
    throw new Error(`linking ${swapId} wrote no row and left no link to report`);
  }
  return { kind: "already_linked", paymentId: raced.paymentId };
}
