/**
 * Swap timeline (UI-3): payment_in on NEAR, the provider state sequence, then the
 * destination-chain tx. Sticky terminal states mean a refunded swap must read as
 * refunded even if a later poll disagrees (PO-4).
 */
export type SwapTimelineProps = { readonly swapId: string };
