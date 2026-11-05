import type { PaymentState } from "@till/core/states";

/**
 * The rules behind the payments table (UI-3, F3), as plain functions so they are
 * testable without a browser — the same split `endpoint-form.ts` makes.
 */

/** The explorer Till links, named once so the label and the URL cannot disagree. */
export const EXPLORER_LABEL = "NearBlocks";

const EXPLORER_BY_NETWORK: Readonly<Record<string, string>> = {
  "near:testnet": "https://testnet.nearblocks.io/txns/",
  "near:mainnet": "https://nearblocks.io/txns/",
};

/**
 * The link UI-3's Done-when asks for, or `null` when Till would be guessing.
 *
 * The network comes on the row rather than from a dashboard setting because a
 * hash is only findable on the chain it was written to, and a payment row is
 * forever tied to the endpoint it came from. A network Till has no explorer for
 * gets no link: a wrong one reads as evidence, which is worse than none.
 */
export function paymentTxLink(network: string, nearTxHash: string | null): string | null {
  if (nearTxHash === null || nearTxHash === "") {
    return null;
  }
  const base = EXPLORER_BY_NETWORK[network];
  return base === undefined ? null : `${base}${nearTxHash}`;
}

/**
 * One word per state, in the seller's terms.
 *
 * The states themselves are core's (`states.ts`) and this record is typed by that
 * list, so a state added to the machine is a compile error here rather than a row
 * the table renders blank. What the word says is display copy for UI-3 and lives
 * with the table, unlike a creation check's sentence, which the API's rule writes.
 */
export function paymentStateWords(): Readonly<Record<PaymentState, string>> {
  return {
    verified: "Paid for, not served yet",
    abandoned: "Verified and given up on — nothing was settled, nothing was charged",
    settled: "Settled — the payer's transfer is on chain",
    served_unsettled:
      "Served without settling — the seller kept the answer, Till never got the money",
  };
}

/** Why the flag exists: a seller testing with their own wallet must not read it as income. */
export const SELF_PAYMENT_NOTE = "Paid by your own wallet — a test, not revenue";

/** The empty table's sentence: nothing has bought a call, which is not a failure. */
export const NO_PAYMENTS_COPY = "No payments yet — nothing has bought a call from this account.";
