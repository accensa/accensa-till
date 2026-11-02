import { z } from "zod";
import { baseUnitAmountSchema } from "./common.ts";

/**
 * Header state (UI-5): the relayer balance and the last successful provider
 * poll, both warned about below configured thresholds. A stale poll is how a
 * seller learns the numbers on screen may be behind.
 */
export const healthDtoSchema = z.object({
  relayerBalance: baseUnitAmountSchema,
  relayerBalanceWarning: z.boolean(),
  lastSuccessfulPollAt: z.string().datetime().nullable(),
  provider: z.enum(["oneclick", "mock"]),
  network: z.string(),
});
export type HealthDto = z.infer<typeof healthDtoSchema>;

/**
 * Seller overview totals by asset and state (UI-6, P1). These are computed by
 * query over the ledger and must equal the ledger rows they summarise.
 */
export const overviewDtoSchema = z.object({
  byAsset: z.array(
    z.object({
      asset: z.string(),
      settledAmount: baseUnitAmountSchema,
      inTransitAmount: baseUnitAmountSchema,
      paidOutAmount: baseUnitAmountSchema,
      refundedAmount: baseUnitAmountSchema,
    }),
  ),
  openDiscrepancies: z.number().int().nonnegative(),
  servedUnsettledCount: z.number().int().nonnegative(),
});
export type OverviewDto = z.infer<typeof overviewDtoSchema>;
