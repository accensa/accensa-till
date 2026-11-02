/**
 * Read helpers for the swaps table (A7). Queries only: writes go through
 * services/, and anything touching the ledger goes through services/ledger.ts
 * (hard rule 4). Money comes back as numeric strings and is converted with
 * toBaseUnits from @till/core at the edge of this module.
 */
export const swaps = "swaps";
