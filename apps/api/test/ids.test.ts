import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import { recordPaymentSettled } from "../src/services/ledger.ts";

/**
 * A20 against a real insert. `packages/core/src/__tests__/ids.test.ts` proves the
 * generator; this proves the *wiring*, which is the part a reader cannot check by
 * reading: `id()` carries `$defaultFn(newId)`, and `services/ledger.ts` no longer
 * mints its own, so a row written without an id arrives with a v7 one that sorts
 * with its insertion. Mocked, the default could be missing and this suite would
 * still be green.
 *
 * Needs `DATABASE_URL`; without it the file skips, so a green run without a
 * database is never read as A20 evidence.
 */

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function msOf(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

function createTestDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openDatabase(url: string) {
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 3 });
  try {
    await sql`select 1`;
    const [present] = await sql`select to_regclass('public.ledger_entries') as present`;
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

type Handle = Awaited<ReturnType<typeof openDatabase>>;

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

const sellerId = randomUUID();

// `describe.skipIf` rather than an early return inside each test: a skipped suite
// is honest about needing a database, where a passing test that asserted nothing
// would not be.
const suite = describe.skipIf(handle === null);

afterAll(async () => {
  if (handle !== null) {
    // Nothing is deleted. The ledger is append-only at the trigger level (A7), so
    // a fixture row is permanent by design, and the seller it points at cannot
    // leave without it. Each run mints its own random seller, which is what keeps
    // the rows of one run from being read as another's.
    await handle.sql.end({ timeout: 5 });
  }
});

/** Each call gets its own note prefix, so a test never reads another's rows. */
let batches = 0;

/**
 * Write `count` ledger rows with no id and read their ids back twice: once sorted
 * by id, once by `ctid`. Because the ledger is append-only (the trigger refuses
 * UPDATE, so no row is ever rewritten to a new page), `ctid` order is the
 * database's own record of insertion order — an independent yardstick for the
 * claim A20 makes, rather than a second way of reading the same column.
 */
async function writeBatch(count: number): Promise<{ byId: string[]; byInsertion: string[] }> {
  const { db, sql } = need();
  batches += 1;
  const tag = `a20-${batches}`;
  for (let i = 0; i < count; i += 1) {
    // No id passed: this is the whole point, the column default has to supply it.
    await recordPaymentSettled(db, {
      sellerId,
      kind: "payment_in",
      amount: 2_500_000n,
      asset: "usdc.testnet",
      note: `${tag}-${i}`,
    });
  }
  const pattern = `${tag}-%`;
  const byId = await sql<{ id: string }[]>`select id from ledger_entries
    where seller_id = ${sellerId} and note like ${pattern} order by id asc`;
  const byInsertion = await sql<{ id: string }[]>`select id from ledger_entries
    where seller_id = ${sellerId} and note like ${pattern} order by ctid asc`;
  return { byId: byId.map((row) => row.id), byInsertion: byInsertion.map((row) => row.id) };
}

function only(rows: string[]): string {
  const [first] = rows;
  if (rows.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return first;
}

suite("row ids come from the column default (A20)", () => {
  beforeAll(async () => {
    const { sql } = need();
    await sql`insert into sellers (id, near_account_id, display_name)
      values (${sellerId}, ${`till-a20-${randomUUID().slice(0, 8)}.testnet`}, 'A20 fixture')
      on conflict (id) do nothing`;
  });

  it("mints a v7 id for a ledger row that asked for none", async () => {
    const { byId } = await writeBatch(1);
    expect(only(byId)).toMatch(V7);
  });

  it("orders rows the way the database inserted them", async () => {
    const { byId, byInsertion } = await writeBatch(8);
    expect(byId.length).toBe(8);
    expect(byId.every((id) => V7.test(id))).toBe(true);
    expect(byId).toEqual(byInsertion);
  });

  it("stamps the id with the insert's own millisecond, not a constant", async () => {
    const before = Date.now();
    const id = only((await writeBatch(1)).byId);
    const after = Date.now();
    expect([before <= msOf(id), msOf(id) <= after]).toEqual([true, true]);
  });

  it("says plainly what this suite cannot prove", async () => {
    // Read with the mutation log in the roadmap: four awaited inserts land in four
    // different milliseconds, because one round trip already costs more than a
    // millisecond. So nothing here reaches the sub-millisecond counter, and
    // replacing that counter with random bits still passes this whole file. That
    // case belongs to the frozen-clock tests in
    // `packages/core/src/__tests__/ids.test.ts`, which do fail when the counter
    // goes. Pinned as an assertion so the day inserts get fast enough to share a
    // millisecond, this test notices rather than quietly becoming the proof.
    const { byId } = await writeBatch(4);
    expect(new Set(byId.map((row) => msOf(row))).size).toBe(4);
  });
});
