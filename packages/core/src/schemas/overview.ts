import { z } from "zod";
import {
  baseUnitAmountSchema,
  boundedArray,
  nearAccountIdSchema,
  timestampSchema,
} from "./common.ts";
import { x402NetworkSchema } from "./payment.ts";

/**
 * Header state (UI-5, F5): the relayer balance and the last successful provider
 * poll, both warned about past a threshold. A stale poll is how a seller learns
 * the numbers on screen may be behind.
 *
 * Two rules shape both halves, and both are about not lying with an absence:
 *
 * - **A number is present exactly when it was read.** The old shape carried a
 *   required `relayerBalance` and a separate boolean warning, which forced a
 *   `0` into the field whenever the RPC did not answer — the reading a seller
 *   acts on ("my relayer is broke") when the truth is "nobody looked". Each
 *   half now names its own state and the state decides whether a value may ride
 *   with it, which the two `superRefine`s below are the enforcement of.
 * - **The threshold travels with the fact.** The sentence is the dashboard's
 *   decision (it is copy, not data) but the comparison is arithmetic, so the
 *   configured balance ceiling and the derived poll window are returned beside
 *   the values they judge. A dashboard that guessed either would warn on a
 *   number the operator never set.
 */

/** `ok` only with an amount; the two refusals never carry one. */
export const RELAYER_BALANCE_STATES = ["ok", "account_missing", "unreadable"] as const;

/** Which of the three a poll half is in is decided by the seller's own rows. */
export const PAYOUT_POLL_STATES = ["no_swaps", "never_polled", "polled"] as const;

export const relayerBalanceDtoSchema = z
  .object({
    /** An account name, not a secret (A10): it is what the balance is read from. */
    accountId: nearAccountIdSchema,
    network: x402NetworkSchema,
    state: z.enum(RELAYER_BALANCE_STATES),
    /** YoctoNEAR as a decimal string (hard rule 3), present exactly when `state === "ok"`. */
    amount: baseUnitAmountSchema.nullable(),
    /** `RELAYER_BALANCE_ALERT_BASE_UNITS`, in the same units as `amount`. */
    alertBelow: baseUnitAmountSchema,
  })
  .superRefine((value, ctx) => {
    if (value.state === "ok" && value.amount === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "a balance read that succeeded has to carry the balance",
      });
    }
    if (value.state !== "ok" && value.amount !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: `state ${value.state} must not carry a balance`,
      });
    }
    // A chain reports a balance as an unsigned integer, so a negative answer is a
    // node lying rather than a poor relayer, and it must not reach a screen.
    // Tested as text, not with `BigInt`: a refinement runs even when the regex
    // beneath it has already failed (common.ts says where that was learned).
    if (value.amount !== null && /^-/.test(String(value.amount))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "a balance cannot be negative",
      });
    }
  });
export type RelayerBalanceDto = z.infer<typeof relayerBalanceDtoSchema>;

export const payoutPollDtoSchema = z
  .object({
    provider: z.enum(["mock", "oneclick"]),
    state: z.enum(PAYOUT_POLL_STATES),
    /** The seller's own swap count, which is what separates "nothing yet" from "never asked". */
    swaps: z.number().int().nonnegative(),
    /** The last poll that *answered*, not the last that was tried (D6 writes `last_polled_at`). */
    lastPolledAt: timestampSchema.nullable(),
    /**
     * Age of that answer in whole seconds, counted by the database against its own
     * `now()` (hard rule 12). It travels as a number because it is a duration, not
     * money, and it is the only form that lets the dashboard compare staleness
     * without owning a clock.
     */
    ageSeconds: z.number().int().nonnegative().nullable(),
    /** Derived from `POLL_INTERVAL_SECONDS`, not configured: a second knob could drift. */
    staleAfterSeconds: z.number().int().positive(),
  })
  .superRefine((value, ctx) => {
    // `no_swaps` means zero rows and the other two mean at least one, so the state
    // cannot disagree with the count it was derived from.
    if (value.state === "no_swaps" && value.swaps !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["swaps"],
        message: "no_swaps is only true of a seller with no swaps",
      });
    }
    if (value.state !== "no_swaps" && value.swaps === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["swaps"],
        message: `state ${value.state} needs a swap to be about`,
      });
    }
    const hasTime = value.lastPolledAt !== null;
    const hasAge = value.ageSeconds !== null;
    // Each half checked on its own rather than as one `answered` pair: a seller whose
    // rows were never polled must carry neither the time nor the age, and a
    // conjunction would let an age with no timestamp through — which is exactly the
    // "how stale, since when?" half-sentence this state is supposed to refuse.
    if (value.state === "polled" && !(hasTime && hasAge)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastPolledAt"],
        message: "a polled swap has an answer time and an age",
      });
    }
    if (value.state !== "polled" && (hasTime || hasAge)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastPolledAt"],
        message: `state ${value.state} must not carry an answer time or an age`,
      });
    }
  });
export type PayoutPollDto = z.infer<typeof payoutPollDtoSchema>;

export const statusDtoSchema = z.object({
  relayer: relayerBalanceDtoSchema,
  payouts: payoutPollDtoSchema,
});
export type StatusDto = z.infer<typeof statusDtoSchema>;

/** `GET /api/status` (UI-5), behind the same session as every other dashboard read. */
export const statusResponseSchema = z.object({ status: statusDtoSchema });
export type StatusResponse = z.infer<typeof statusResponseSchema>;

/**
 * Seller overview totals by asset and state (UI-6, P1). These are computed by
 * query over the ledger and must equal the ledger rows they summarise.
 */
export const overviewDtoSchema = z.object({
  // One row per asset the seller has ever settled, and the asset set is small
  // (C15): 32 is above any real overview, not a guess at a limit.
  byAsset: boundedArray(
    z.object({
      asset: z.string(),
      settledAmount: baseUnitAmountSchema,
      inTransitAmount: baseUnitAmountSchema,
      paidOutAmount: baseUnitAmountSchema,
      refundedAmount: baseUnitAmountSchema,
    }),
    32,
  ),
  openDiscrepancies: z.number().int().nonnegative(),
  servedUnsettledCount: z.number().int().nonnegative(),
});
export type OverviewDto = z.infer<typeof overviewDtoSchema>;
