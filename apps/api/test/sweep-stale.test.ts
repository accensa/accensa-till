import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import { type SettlementProbe, sweepStaleOnBoot } from "../src/jobs/sweep-stale.ts";
import { advancePayment } from "../src/services/payments.ts";

/**
 * C10 acceptance tests (GW-2): a process that dies mid-flight leaves a
 * `verified` row behind, and the boot sweep's job is to give every one of them
 * the state the evidence supports.
 *
 * "A restart" is simulated by inserting the rows the dead process would have
 * left -- old `verified_at`, with or without the settlement hash the route now
 * writes before booking -- and running the sweep once. The chain is a scripted
 * probe, because the question the sweep asks is about a decision, not about
 * NEAR: `settlementStatus` itself is tested against a loopback JSON-RPC stub in
 * `x402.test.ts`.
 *
 * Needs `DATABASE_URL`; without a reachable database the file skips.
 */

type Handle = { readonly sql: postgres.Sql; readonly db: ReturnType<typeof createTestDb> };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function createTestDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openDatabase(url: string): Promise<Handle> {
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 3 });
  try {
    await sql`select 1`;
    const [present] = await sql`select to_regclass('public.payments') as present`;
    if (present !== undefined && present.present === null) {
      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
      }
    }
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    throw error;
  }
  return { sql, db: createTestDb(sql) };
}

let handle: Handle | null = null;
let skipReason = "DATABASE_URL is not set";
const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl !== "") {
  try {
    handle = await openDatabase(databaseUrl);
  } catch (error) {
    skipReason = `database from DATABASE_URL is unusable: ${message(error)}`;
  }
}

function need(): Handle {
  if (handle === null) {
    throw new Error(`unreachable: the suite should have skipped for "${skipReason}"`);
  }
  return handle;
}

const run = randomUUID().slice(0, 8);
const sellerId = randomUUID();
const endpointId = randomUUID();
const WINDOW_SECONDS = 60;
const AMOUNT = "10000";
const ASSET = "usdc.testnet";

async function seed(): Promise<void> {
  const { sql } = need();
  await sql`insert into sellers (id, near_account_id, display_name)
    values (${sellerId}, ${`till-c10-${run}.testnet`}, 'C10 fixture')
    on conflict (id) do nothing`;
  await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
      asset_contract, network, payout_mode)
    values (${endpointId}, ${sellerId}, ${`c10-${run}`}, 'https://example.test/data',
      ${AMOUNT}, ${ASSET}, 'near:testnet', 'direct')
    on conflict (id) do nothing`;

  // The sweep is global by design. Two kinds of `verified` row cannot belong to
  // a live test: one already past the window (the dead-process row this job
  // exists for, left by an earlier session) and one this suite left on a
  // previous run. The margin is five minutes rather than an hour because any
  // `verified` row past `WINDOW_SECONDS` is precisely what the sweep is meant
  // to consume, and a sibling suite's fixture is seconds old when it runs.
  // Clearing both makes each case's count the rows that case inserted.
  await sql`delete from payments where state = 'verified'
    and (verified_at < now() - interval '5 minutes'
      or endpoint_id in (select id from endpoints where slug like 'c10-%'))`;
}

type StaleInput = {
  readonly state?: string;
  /** Whole seconds before now. Defaults to well past the window. */
  readonly ageSeconds?: number;
  readonly nearTxHash?: string | null;
};

async function insertPayment(input: StaleInput = {}): Promise<string> {
  const { sql } = need();
  const id = randomUUID();
  await sql`insert into payments (id, endpoint_id, payer_account_id, amount, asset_contract,
      replay_key, state, near_tx_hash, verified_at)
    values (${id}, ${endpointId}, ${`c10-payer-${randomUUID()}.testnet`}, ${AMOUNT}, ${ASSET},
      ${`c10-${randomUUID()}`}, ${input.state ?? "verified"}, ${input.nearTxHash ?? null},
      now() - make_interval(secs => ${input.ageSeconds ?? 120}::int))`;
  return id;
}

async function paymentById(id: string): Promise<{
  state: string;
  near_tx_hash: string | null;
  settled_at: Date | null;
}> {
  const [row] = await need().sql<
    { state: string; near_tx_hash: string | null; settled_at: Date | null }[]
  >`select state, near_tx_hash, settled_at from payments where id = ${id}`;
  if (row === undefined) {
    throw new Error(`no payment ${id}`);
  }
  return row;
}

async function ledgerFor(
  paymentId: string,
): Promise<{ kind: string; amount: string; asset: string }[]> {
  return need().sql`select kind, amount::text as amount, asset from ledger_entries
    where payment_id = ${paymentId} order by created_at, id`;
}

function probeOf(verdicts: Record<string, "settled" | "failed" | "unknown">): {
  readonly probe: SettlementProbe;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    probe: async (hash) => {
      calls.push(hash);
      return verdicts[hash] ?? "unknown";
    },
  };
}

const sweep = (probe: SettlementProbe) =>
  sweepStaleOnBoot({ db: need().db, windowSeconds: WINDOW_SECONDS, probe });

const suite = describe.skipIf(handle === null);

suite("boot sweep of stale payments (C10, GW-2)", () => {
  beforeAll(seed);

  // Each case owns the rows it inserts. Unproven/inside-window rows are left
  // `verified` on purpose (that is the assertion), and a later sweep sees the
  // whole table, so the leftovers are cleared here rather than counted twice.
  // A `verified` row has no ledger entry, so this delete is not history.
  beforeEach(async () => {
    await need().sql`delete from payments where endpoint_id = ${endpointId} and state = 'verified'`;
  });

  it("abandons a stale verified row that carries no settlement evidence", async () => {
    const id = await insertPayment();
    const { probe, calls } = probeOf({});

    expect(await sweep(probe)).toEqual({ abandoned: 1, recovered: 0, unproven: 0 });
    expect(calls).toEqual([]);
    expect(await paymentById(id)).toMatchObject({ state: "abandoned", near_tx_hash: null });
  });

  it("recovers a stale row the chain confirms, and books the payment_in the route never wrote", async () => {
    const hash = `c10-ok-${randomUUID()}`;
    const id = await insertPayment({ nearTxHash: hash });
    const { probe, calls } = probeOf({ [hash]: "settled" });

    expect(await sweep(probe)).toEqual({ abandoned: 0, recovered: 1, unproven: 0 });
    expect(calls).toEqual([hash]);

    const row = await paymentById(id);
    expect(row.state).toBe("settled");
    expect(row.near_tx_hash).toBe(hash);
    expect(row.settled_at).not.toBeNull();
    expect(await ledgerFor(id)).toEqual([{ kind: "payment_in", amount: AMOUNT, asset: ASSET }]);
  });

  it("abandons a stale row whose settle the chain reports failed, and keeps the hash", async () => {
    const hash = `c10-failed-${randomUUID()}`;
    const id = await insertPayment({ nearTxHash: hash });
    const { probe } = probeOf({ [hash]: "failed" });

    expect(await sweep(probe)).toEqual({ abandoned: 1, recovered: 0, unproven: 0 });
    expect(await paymentById(id)).toMatchObject({ state: "abandoned", near_tx_hash: hash });
    expect(await ledgerFor(id)).toEqual([]);
  });

  it("leaves a row the chain cannot answer for, and reports it unproven", async () => {
    const hash = `c10-unknown-${randomUUID()}`;
    const id = await insertPayment({ nearTxHash: hash });
    const { probe } = probeOf({ [hash]: "unknown" });

    expect(await sweep(probe)).toEqual({ abandoned: 0, recovered: 0, unproven: 1 });
    expect(await paymentById(id)).toMatchObject({ state: "verified", near_tx_hash: hash });
  });

  it("treats a probe that throws as unproven rather than as a crash or a verdict", async () => {
    const hash = `c10-throw-${randomUUID()}`;
    const id = await insertPayment({ nearTxHash: hash });
    const probe: SettlementProbe = async () => {
      throw new Error("rpc did not answer");
    };

    expect(await sweep(probe)).toEqual({ abandoned: 0, recovered: 0, unproven: 1 });
    expect(await paymentById(id)).toMatchObject({ state: "verified" });
  });

  it("does not touch a row inside the in-flight window, because it may still be served", async () => {
    const id = await insertPayment({ ageSeconds: WINDOW_SECONDS - 10 });
    const { probe, calls } = probeOf({});

    expect(await sweep(probe)).toEqual({ abandoned: 0, recovered: 0, unproven: 0 });
    expect(calls).toEqual([]);
    expect((await paymentById(id)).state).toBe("verified");
  });

  it("sweeps only verified rows, leaving every finished state alone", async () => {
    for (const state of ["abandoned", "settled", "served_unsettled"]) {
      await insertPayment({
        state,
        ageSeconds: WINDOW_SECONDS * 10,
        nearTxHash: `c10-${state}-${randomUUID()}`,
      });
    }
    const { probe, calls } = probeOf({});
    expect(await sweep(probe)).toEqual({ abandoned: 0, recovered: 0, unproven: 0 });
    // Not even the chain is asked: a finished row is not the sweep's business.
    expect(calls).toEqual([]);
  });

  it("simulates a restart mid-flight: one pass sorts the three evidence shapes", async () => {
    const settledHash = `c10-mix-ok-${randomUUID()}`;
    const unknownHash = `c10-mix-unknown-${randomUUID()}`;
    const noEvidence = await insertPayment();
    const settled = await insertPayment({ nearTxHash: settledHash });
    const unknown = await insertPayment({ nearTxHash: unknownHash });
    const { probe, calls } = probeOf({ [settledHash]: "settled", [unknownHash]: "unknown" });

    expect(await sweep(probe)).toEqual({ abandoned: 1, recovered: 1, unproven: 1 });
    expect(calls.sort()).toEqual([settledHash, unknownHash].sort());
    expect((await paymentById(noEvidence)).state).toBe("abandoned");
    expect((await paymentById(settled)).state).toBe("settled");
    expect((await paymentById(unknown)).state).toBe("verified");
    expect(await ledgerFor(settled)).toHaveLength(1);
  });

  it("does not double-book a row another instance settled while the probe was out", async () => {
    const hash = `c10-race-${randomUUID()}`;
    const id = await insertPayment({ nearTxHash: hash });
    const probe: SettlementProbe = async () => {
      // A second process finishes the row between the sweep's select and its move.
      await advancePayment(need().db, id, "settled", { nearTxHash: hash });
      return "settled";
    };

    expect(await sweep(probe)).toEqual({ abandoned: 0, recovered: 0, unproven: 0 });
    expect((await paymentById(id)).state).toBe("settled");
    expect(await ledgerFor(id)).toEqual([]);
  });
});

afterAll(async () => {
  await handle?.sql.end({ timeout: 1 }).catch(() => undefined);
});
