/**
 * `pnpm demo` (DQ-1, D2). Orchestrates: seed -> start upstream -> agent pays ->
 * assert payment and ledger -> simulate refund -> assert PAYOUT_REFUNDED ->
 * simulate empty-account payer served once then blocked -> assert
 * SERVED_NOT_SETTLED. Must exit non-zero on any failed assertion, and runs
 * entirely against PAYOUT_PROVIDER=mock with no keys.
 *
 * The last two cases are the demo's distinctive moment (PRD section 8), so this
 * script failing is a product problem, not a test problem.
 */
async function main(): Promise<never> {
  throw new Error("not implemented (D2, C11, DQ-1)");
}

await main();
