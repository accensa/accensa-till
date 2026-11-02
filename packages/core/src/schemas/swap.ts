import { z } from "zod";
import { SWAP_STATES } from "../states.ts";
import { baseUnitAmountSchema, uuidSchema } from "./common.ts";

/** A payout swap as the dashboard timeline shows it (UI-3, SwapTimeline.tsx). */
export const swapDtoSchema = z.object({
  id: uuidSchema,
  routeId: uuidSchema,
  /** Set when a payment was matched by transaction hash (LR-2); null is an orphan candidate. */
  paymentId: uuidSchema.nullable(),
  providerRef: z.string(),
  state: z.enum(SWAP_STATES),
  amountIn: baseUnitAmountSchema.nullable(),
  amountOut: baseUnitAmountSchema.nullable(),
  refundedAmount: baseUnitAmountSchema.nullable(),
  originTxHash: z.string().nullable(),
  destinationTxHash: z.string().nullable(),
  lastPolledAt: z.string().datetime().nullable(),
  terminalAt: z.string().datetime().nullable(),
});
export type SwapDto = z.infer<typeof swapDtoSchema>;
