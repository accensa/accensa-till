/**
 * `pnpm seed` (DQ-1): one demo seller, one endpoint and one payout route, so a
 * fresh clone has something to point the agent at. Idempotent — rerunning it on
 * a seeded database must not create a second copy of the demo endpoint.
 */
async function main(): Promise<never> {
  throw new Error("not implemented (D4, DQ-1)");
}

await main();
