import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every database-backed suite shares one Postgres, and two of them are
    // global on purpose: C10's boot sweep classifies every stale `verified` row
    // in the table, while C8's guards suite inserts one such row to prove a dead
    // process's leftover is not a permanent ban. Run in parallel, the sweep can
    // consume that row between its insert and its delete, so both expectations
    // fail intermittently (observed 2026-11-04). Files run in sequence; the
    // non-database files lose nothing they were not already sharing a process
    // budget with.
    fileParallelism: false,
  },
});
