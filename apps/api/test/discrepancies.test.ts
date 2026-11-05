import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type DiscrepancyCode, type Finding, dedupeKeyFor } from "@till/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import { persistFindings, resolveManually } from "../src/services/discrepancies.ts";

/**
 * E8 acceptance tests (LR-4, LR-5) against a real Postgres: the partial unique
 * index is the dedupe mechanism, so a fake would test the fake. Every finding
 * here has a null payment and swap id, which is the case LR-5 names — a plain
 * uniqueness rule over the columns would let these duplicate.
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
    const [present] = await sql`select to_regclass('public.discrepancies') as present`;
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
const otherSellerId = randomUUID();

const EXPLANATION = "The payout did not arrive where it was asked to go.";
const ACTION = "Check the destination and re-route the payout.";

function finding(overrides: Partial<Finding> & { code: DiscrepancyCode }): Finding {
  return {
    severity: "high",
    paymentId: null,
    swapId: null,
    dedupeKey: dedupeKeyFor(overrides.code, null, null),
    explanation: EXPLANATION,
    suggestedAction: ACTION,
    ...overrides,
  };
}

type Row = {
  id: string;
  seller_id: string;
  code: string;
  severity: string;
  payment_id: string | null;
  swap_id: string | null;
  dedupe_key: string;
  explanation: string;
  suggested_action: string;
  details: Record<string, string> | null;
  opened_at: Date | null;
  resolved_at: Date | null;
  resolution: string | null;
};

async function openRows(seller: string): Promise<Row[]> {
  return need().sql<Row[]>`select * from discrepancies
    where seller_id = ${seller} and resolved_at is null order by dedupe_key`;
}

async function rowById(id: string): Promise<Row> {
  const [row] = await need().sql<Row[]>`select * from discrepancies where id = ${id}`;
  if (row === undefined) {
    throw new Error(`no discrepancy ${id}`);
  }
  return row;
}

beforeAll(async () => {
  if (handle === null) {
    return;
  }
  const { sql } = handle;
  for (const [id, account] of [
    [sellerId, `till-e8-a-${run}.testnet`],
    [otherSellerId, `till-e8-b-${run}.testnet`],
  ] as const) {
    await sql`insert into sellers (id, near_account_id, display_name)
      values (${id}, ${account}, 'E8 fixture') on conflict (id) do nothing`;
  }
});

beforeEach(async () => {
  if (handle === null) {
    return;
  }
  // Only this suite's sellers are touched; the temp ids make that true across runs.
  await handle.sql`delete from discrepancies where seller_id in (${sellerId}, ${otherSellerId})`;
});

afterAll(async () => {
  await handle?.sql.end({ timeout: 5 }).catch(() => undefined);
});

describe.skipIf(handle === null)("E8 discrepancies", () => {
  it("persists the finding's copy, subjects and database-stamped open time", async () => {
    const { db, sql } = need();
    const [before] = await sql<{ now: Date }[]>`select now() as now`;

    const result = await persistFindings(db, sellerId, [
      finding({
        code: "PAYOUT_REFUNDED",
        severity: "high",
        details: { refundedAmount: "0.25" },
      }),
    ]);

    expect(result).toEqual({ opened: 1, closed: 0 });
    const [row] = await openRows(sellerId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      seller_id: sellerId,
      code: "PAYOUT_REFUNDED",
      severity: "high",
      payment_id: null,
      swap_id: null,
      dedupe_key: "PAYOUT_REFUNDED:none:none",
      explanation: EXPLANATION,
      suggested_action: ACTION,
      details: { refundedAmount: "0.25" },
      resolution: null,
    });
    // The open time is the database's, not the process's: it falls inside a
    // window read from the same clock rather than being compared to a wall clock.
    const [after] = await sql<{ now: Date }[]>`select now() as now`;
    const stamped = new Date(row?.opened_at ?? 0).getTime();
    expect(row?.opened_at).not.toBeNull();
    expect(stamped).toBeGreaterThanOrEqual(new Date(before?.now ?? 0).getTime());
    expect(stamped).toBeLessThanOrEqual(new Date(after?.now ?? 0).getTime());
  });

  it("leaves details absent when the rule supplied none", async () => {
    await persistFindings(need().db, sellerId, [finding({ code: "PAYOUT_FAILED" })]);
    const [row] = await openRows(sellerId);
    expect(row?.details).toBeNull();
  });

  it("the same cause twice yields one open row and keeps the first observation", async () => {
    const { db } = need();
    const first = await persistFindings(db, sellerId, [finding({ code: "PAYOUT_STUCK" })]);
    const [opened] = await openRows(sellerId);

    const second = await persistFindings(db, sellerId, [
      finding({ code: "PAYOUT_STUCK", explanation: "A later wording of the same cause." }),
    ]);

    expect(first).toEqual({ opened: 1, closed: 0 });
    expect(second).toEqual({ opened: 0, closed: 0 });
    const rows = await openRows(sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(opened?.id);
    expect(rows[0]?.explanation).toBe(EXPLANATION);
  });

  it("keeps two causes with no payment or swap id apart", async () => {
    await persistFindings(need().db, sellerId, [
      finding({ code: "PAYOUT_STUCK" }),
      finding({ code: "PAYMENT_NOT_SWEPT" }),
    ]);
    const rows = await openRows(sellerId);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      "PAYMENT_NOT_SWEPT:none:none",
      "PAYOUT_STUCK:none:none",
    ]);
  });

  it("keeps the same null-subject cause open for two sellers", async () => {
    // The cause key carries no seller id, so the index must: a global key would
    // let one seller's orphan deposit block every other seller's.
    const { db } = need();
    await persistFindings(db, sellerId, [finding({ code: "ORPHAN_DEPOSIT" })]);

    const second = await persistFindings(db, otherSellerId, [finding({ code: "ORPHAN_DEPOSIT" })]);

    expect(second).toEqual({ opened: 1, closed: 0 });
    expect((await openRows(sellerId)).map((row) => row.code)).toEqual(["ORPHAN_DEPOSIT"]);
    expect((await openRows(otherSellerId)).map((row) => row.code)).toEqual(["ORPHAN_DEPOSIT"]);
  });

  it("auto-resolves only the cause that is no longer reported", async () => {
    const { db } = need();
    const kept = finding({ code: "SERVED_NOT_SETTLED", severity: "critical" });
    const cleared = finding({ code: "PAYOUT_FAILED" });
    await persistFindings(db, sellerId, [kept, cleared]);
    const clearedId = (await openRows(sellerId)).find((row) => row.code === "PAYOUT_FAILED")?.id;

    const result = await persistFindings(db, sellerId, [kept]);

    expect(result).toEqual({ opened: 0, closed: 1 });
    expect((await openRows(sellerId)).map((row) => row.code)).toEqual(["SERVED_NOT_SETTLED"]);
    const closed = await rowById(clearedId ?? "");
    expect(closed.resolution).toBe("auto");
    expect(closed.resolved_at).not.toBeNull();
  });

  it("closes every open cause for the seller when the rules report nothing", async () => {
    const { db } = need();
    await persistFindings(db, sellerId, [
      finding({ code: "PAYOUT_FAILED" }),
      finding({ code: "PAYOUT_STUCK" }),
    ]);

    const result = await persistFindings(db, sellerId, []);

    expect(result).toEqual({ opened: 0, closed: 2 });
    expect(await openRows(sellerId)).toEqual([]);
  });

  it("does not auto-resolve another seller's rows", async () => {
    const { db } = need();
    await persistFindings(db, otherSellerId, [finding({ code: "PAYOUT_STUCK" })]);

    await persistFindings(db, sellerId, []);

    expect((await openRows(otherSellerId)).map((row) => row.code)).toEqual(["PAYOUT_STUCK"]);
  });

  it("manual resolution closes the row once and refuses a second close", async () => {
    const { db } = need();
    await persistFindings(db, sellerId, [finding({ code: "PAYOUT_FAILED" })]);
    const [open] = await openRows(sellerId);

    expect(await resolveManually(db, sellerId, open?.id ?? "")).toBe(true);
    expect(await resolveManually(db, sellerId, open?.id ?? "")).toBe(false);

    const row = await rowById(open?.id ?? "");
    expect(row.resolution).toBe("manual");
    expect(row.resolved_at).not.toBeNull();
    expect(await openRows(sellerId)).toEqual([]);
  });

  it("refuses to resolve another seller's row", async () => {
    const { db } = need();
    await persistFindings(db, otherSellerId, [finding({ code: "PAYOUT_FAILED" })]);
    const [open] = await openRows(otherSellerId);

    expect(await resolveManually(db, sellerId, open?.id ?? "")).toBe(false);
    expect((await openRows(otherSellerId)).map((row) => row.code)).toEqual(["PAYOUT_FAILED"]);
  });

  it("reopens a manually closed cause that the rules still report", async () => {
    const { db } = need();
    const live = finding({ code: "PAYMENT_NOT_SWEPT" });
    await persistFindings(db, sellerId, [live]);
    const [first] = await openRows(sellerId);
    await resolveManually(db, sellerId, first?.id ?? "");

    const result = await persistFindings(db, sellerId, [live]);

    // LR-5: a resolved row does not block reopening. Manual resolution closes an
    // occurrence, not the cause — silence here would hide a condition that is
    // still true on chain.
    expect(result).toEqual({ opened: 1, closed: 0 });
    const rows = await openRows(sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(first?.id);
    expect((await rowById(first?.id ?? "")).resolution).toBe("manual");
  });
});
