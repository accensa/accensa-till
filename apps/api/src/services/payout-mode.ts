import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

import type { PayoutMode } from "./ledger.ts";

/**
 * The one place that answers "does this payment still need a payout sweep?", and it
 * has to be one place because three readers ask the question and a fourth now does:
 * E9's reconcile rules (so `PAYMENT_NOT_SWEPT` does not fire on a direct sale),
 * D8's ledger writer (so a direct settlement books its `payout_out` beside the
 * `payment_in`), and UI-6's overview (so an unpaid-looking USDC total is not
 * mistaken for money on its way out). A second copy of the rule is how one of them
 * starts disagreeing with the other two about the same row.
 *
 * The rule itself is PO-7's, and it is a *precedence*, not a lookup: a payment
 * keeps the terms it was opened under, so the route the payment carries
 * (`payments.route_id`, snapshotted at verify time by D5) answers first and the
 * endpoint's live, editable `payout_mode` (D9) only answers when there is no route
 * to read. Reading the endpoint for an old payment would let one edit of a
 * destination change the history of money already taken — the same drift D9 exists
 * to prevent, arriving in the reader.
 *
 * Both forms live here because they must not be able to drift: `payoutModeOf` for
 * rows already loaded into a loop, `intentsModeSql` for the same decision inside a
 * query. `apps/api/test/overview.test.ts` runs them against the same matrix of
 * column values and fails if the sentence and the SQL ever split.
 */

/**
 * `direct` paid the seller's own account, so no swap was ever owed for it, and
 * every other mode moved through a route. `mode_detail` is the payment's own
 * snapshot (D5 wrote it at verify time), so it answers before the endpoint does.
 */
export function payoutModeOf(
  routeMode: string | null,
  endpointMode: string,
): { readonly mode: PayoutMode; readonly fromEndpoint: boolean } {
  if (routeMode !== null) {
    return { mode: routeMode === "direct" ? "direct" : "intents", fromEndpoint: false };
  }
  // Only the word `direct` reads as direct, which is the rule
  // `services/endpoints.ts` already applies to the same column: a value neither
  // word describes did not come from Till's write path, and treating it as
  // `intents` keeps the swap rules looking rather than assuming the sale needed
  // no sweep.
  return { mode: endpointMode === "direct" ? "direct" : "intents", fromEndpoint: true };
}

/**
 * The same precedence as SQL, for a query that has to decide it per row rather than
 * load the rows.
 *
 * The columns are passed in rather than named from `db/schema.ts` because the
 * expression is about two values, not about which tables they were joined from —
 * and because the pin test feeds it a `values` list, which has no schema columns to
 * hand. It answers `true` for intents, matching `payoutModeOf(…).mode === "intents"`.
 */
export function intentsModeSql(routeMode: SQLWrapper, endpointMode: SQLWrapper): SQL {
  return sql`(case when ${routeMode} is not null then ${routeMode} <> 'direct' else ${endpointMode} <> 'direct' end)`;
}
