/**
 * One payment row (UI-3). Renders paymentDto from @till/core; the NEAR tx hash is
 * a link, never bare text, because "follow one payment end to end in under a
 * minute" is a success criterion (PRD section 9).
 */
export type PaymentRowProps = { readonly paymentId: string };
