/**
 * The ONLY module that may import @fastnear x402 packages (AGENTS.md hard rule
 * 1, C1). verify, settle and requirement helpers, with our own types from
 * x402/types.ts so library shapes never leak into services or routes.
 *
 * Dependency is deliberately absent from package.json: the published versions
 * are unconfirmed, and AGENTS.md requires asking before adding one.
 */
export const X402_SCHEME = "near-address";
