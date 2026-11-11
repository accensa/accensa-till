import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type OverviewDto, dashboardErrorSchema, overviewResponseSchema } from "@till/core";

import type { Db } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import {
  discrepancies,
  endpoints,
  ledgerEntries,
  payments,
  payoutRoutes,
  sellers,
  swaps,
} from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import { createOverviewRoutes } from "../src/routes/overview.ts";
import {
  recordAdjustment,
  recordPayoutOut,
  recordRefundIn,
  recordSettlement,
} from "../src/services/ledger.ts";
import { readSellerOverview } from "../src/services/overview.ts";
import { intentsModeSql, payoutModeOf } from "../src/services/payout-mode.ts";

/**
 * UI-6 (F6): the seller's totals, and the one of them that is not a ledger sum.
 *
 * Four tests' worth of behaviour, and the split is the point:
 *
 * - **the ledger halves are checked against the ledger**, by re-running the same
 *   `sum … filter (where kind = …)` straight at the database and comparing it to
 *   what the service answers. That is the acceptance rule ("these totals equal the
 *   ledger rows they summarise"), and it is the only way to test it that is not the
 *   implementation testing itself.
 * - **the in-transit half is checked against the payout**, because 6.1's cross-asset
 *   rule makes it the one number that cannot be a ledger difference: a USDC sale
 *   whose payout landed on another chain has a `payment_in` in USDC and a
 *   `payout_out` in something else, and subtracting them per asset would report the
 *   money as still in flight after it arrived.
 * - **the payout-mode rule is pinned in both of its forms**, since the overview
 *   decides it inside SQL and E9 decides it in TypeScript about the same two
 *   columns.
 * - **the route** answers for the session's seller, and refuses rather than answer
 *   partly.
 *
 * Needs `DATABASE_URL`; without a reachable database the halves that need it skip.
 * Nothing here deletes what it wrote: `ledger_entries` refuses its own DELETE (A7)
 * and a payment with a ledger line is refused by the foreign key, so every fixture
 * mints a fresh seller and every assertion is scoped to it.
 */

type Handle = { readonly sql: postgres.Sql; readonly db: Db };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openDatabase(url: string): Promise<Handle> {
  const sqlClient = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 3 });
  try {
    await sqlClient`select 1`;
    const [present] = await sqlClient`select to_regclass('public.payments') as present`;
    if (present !== undefined && present.present === null) {
      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        await sqlClient.unsafe(await readFile(join(migrationsDir, file), "utf8"));
      }
    }
  } catch (error) {
    await sqlClient.end({ timeout: 1 }).catch(() => undefined);
    throw error;
  }
  return { sql: sqlClient, db: drizzle(sqlClient, { schema }) as unknown as Db };
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

const suite = describe.skipIf(handle === null);

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const run = randomUUID().slice(0, 8);
const USDC = "usdc.testnet";
/** The destination-chain stablecoin, deliberately not spelled the same as `USDC`. */
const DESTINATION = "usdc";
const OTHER = "pepe.testnet";
const AMOUNT = "2500000";

type Seller = {
  readonly id: string;
  readonly near: string;
  readonly endpointId: string;
  readonly intentsRouteId: string;
  readonly directRouteId: string;
};

/**
 * One seller, their endpoint, and the two routes a payment can carry.
 *
 * The endpoint's own mode is a parameter because PO-7's fallback is what the
 * precedence test needs to reach: a payment with no route answers from here.
 */
async function newSeller(endpointPayoutMode = "intents"): Promise<Seller> {
  const { db } = need();
  const tag = randomUUID().slice(0, 8);
  const [seller] = await db
    .insert(sellers)
    .values({ nearAccountId: `till-f6-${tag}-${run}.testnet`, displayName: `F6 ${tag}` })
    .returning({ id: sellers.id });
  if (seller === undefined) {
    throw new Error("seller insert returned no row");
  }

  const routeIds: string[] = [];
  for (const modeDetail of ["standing", "direct"]) {
    const [route] = await db
      .insert(payoutRoutes)
      .values({
        sellerId: seller.id,
        destinationChain: "near",
        destinationAsset: DESTINATION,
        destinationAddress: `dest-${tag}-${modeDetail}-${run}.testnet`,
        refundAddress: `refund-${tag}-${run}.testnet`,
        provider: "mock",
        modeDetail,
      })
      .returning({ id: payoutRoutes.id });
    if (route === undefined) {
      throw new Error("payoutRoute insert returned no row");
    }
    routeIds.push(route.id);
  }

  const [endpoint] = await db
    .insert(endpoints)
    .values({
      sellerId: seller.id,
      slug: `f6-${tag}-${run}`,
      upstreamUrl: "https://example.test/data",
      priceAmount: AMOUNT,
      assetContract: USDC,
      network: "near:testnet",
      payoutMode: endpointPayoutMode,
    })
    .returning({ id: endpoints.id });
  if (endpoint === undefined) {
    throw new Error("endpoint insert returned no row");
  }

  const intentsRouteId = routeIds[0];
  const directRouteId = routeIds[1];
  if (intentsRouteId === undefined || directRouteId === undefined) {
    throw new Error("expected two routes inserted");
  }

  return {
    id: seller.id,
    near: `till-f6-${tag}-${run}.testnet`,
    endpointId: endpoint.id,
    intentsRouteId,
    directRouteId,
  };
}

type PaymentSeed = {
  readonly amount?: string;
  readonly asset?: string;
  readonly state?: string;
  readonly nearTxHash?: string | null;
  /** `"none"` leaves `route_id` null, which is the case the endpoint answers. */
  readonly route?: "intents" | "direct" | "none";
};

/** A payment, and the ledger line a correct settlement would have written for it. */
async function newSettledPayment(seller: Seller, seed: PaymentSeed = {}): Promise<string> {
  const { db } = need();
  const amount = seed.amount ?? AMOUNT;
  const asset = seed.asset ?? USDC;
  const route = seed.route ?? "intents";
  const [row] = await db
    .insert(payments)
    .values({
      endpointId: seller.endpointId,
      routeId:
        route === "none" ? null : route === "direct" ? seller.directRouteId : seller.intentsRouteId,
      payerAccountId: `buyer-${randomUUID().slice(0, 8)}.testnet`,
      amount,
      assetContract: asset,
      replayKey: `f6-${randomUUID()}`,
      state: seed.state ?? "settled",
      verifiedAt: new Date(),
      settledAt: seed.state === "served_unsettled" ? null : new Date(),
      nearTxHash: seed.nearTxHash ?? null,
    })
    .returning({ id: payments.id });
  if (row === undefined) {
    throw new Error("payment insert returned no row");
  }
  return row.id;
}

/** The settlement write the gateway would have made, so the ledger is Till's own. */
async function book(
  seller: Seller,
  paymentId: string,
  amount: string,
  asset: string,
  mode: "direct" | "intents",
): Promise<void> {
  await recordSettlement(
    need().db,
    { sellerId: seller.id, amount: BigInt(amount), asset, paymentId },
    mode,
  );
}

/** A swap for this seller's intents route, terminal unless told otherwise. */
async function newSwap(
  seller: Seller,
  originTxHash: string,
  options: { readonly terminal?: boolean; readonly state?: string } = {},
): Promise<string> {
  const { db } = need();
  const terminal = options.terminal ?? true;
  const [row] = await db
    .insert(swaps)
    .values({
      routeId: seller.intentsRouteId,
      providerRef: `f6-ref-${randomUUID()}`,
      state: options.state ?? (terminal ? "succeeded" : "processing"),
      originTxHash,
      terminalAt: terminal ? new Date() : null,
      raw: { simulated: true },
    })
    .returning({ id: swaps.id });
  if (row === undefined) {
    throw new Error("swap insert returned no row");
  }
  return row.id;
}

/** One row of the DTO, by asset, so a test can name what it expects. */
function rowFor(overview: OverviewDto, asset: string) {
  const row = overview.byAsset.find((candidate) => candidate.asset === asset);
  if (row === undefined) {
    throw new Error(
      `no overview row for ${asset}; got ${overview.byAsset.map((r) => r.asset).join(", ")}`,
    );
  }
  return row;
}

async function overview(sellerId: string): Promise<OverviewDto> {
  return readSellerOverview(need().db, sellerId);
}

suite("the overview totals equal the ledger rows they summarise (UI-6)", () => {
  let seller: Seller;
  let usdcPayment: string;
  let otherPayment: string;
  let hash: string;

  beforeAll(async () => {
    seller = await newSeller();
    hash = `tx-${run}-1`;
    usdcPayment = await newSettledPayment(seller, { nearTxHash: hash });
    otherPayment = await newSettledPayment(seller, { amount: "1000000", asset: OTHER });

    await book(seller, usdcPayment, AMOUNT, USDC, "intents");
    await book(seller, otherPayment, "1000000", OTHER, "intents");
    // The payout leg of the first sale: money *out* in the destination asset, which
    // is the whole reason in-transit is not a subtraction of one ledger kind from
    // another.
    const swapId = await newSwap(seller, hash);
    await recordPayoutOut(need().db, {
      sellerId: seller.id,
      amount: 2_400_000n,
      asset: DESTINATION,
      paymentId: usdcPayment,
      swapId,
    });
    await recordRefundIn(need().db, {
      sellerId: seller.id,
      amount: 100_000n,
      asset: USDC,
      paymentId: usdcPayment,
      swapId,
    });
    await recordAdjustment(
      need().db,
      { sellerId: seller.id, amount: -50_000n, asset: USDC, paymentId: usdcPayment },
      "f6 fixture correction",
    );
  });

  it("answers each of the four kind totals with the same sum the ledger holds", async () => {
    const read = await overview(seller.id);
    const settled = rowFor(read, USDC);

    // The independent recompute: the same four aggregates, asked of the database
    // outside the service, on the row the service is claiming to summarise.
    const [raw] = await need().sql`
      select
        coalesce(sum(amount) filter (where kind = 'payment_in'), 0)::text as settled,
        coalesce(sum(amount) filter (where kind = 'payout_out'), 0)::text as paid_out,
        coalesce(sum(amount) filter (where kind = 'refund_in'), 0)::text as refunded,
        coalesce(sum(amount) filter (where kind = 'adjustment'), 0)::text as adjusted
      from ledger_entries
      where seller_id = ${seller.id} and asset = ${USDC}
    `;

    if (raw === undefined) {
      throw new Error("recompute query returned no row");
    }

    expect([
      settled.settledAmount,
      settled.paidOutAmount,
      settled.refundedAmount,
      settled.adjustedAmount,
    ]).toEqual([raw.settled, raw.paid_out, raw.refunded, raw.adjusted]);

    // …and against the fixture's own arithmetic, so the equality above cannot be
    // satisfied by two readings of a number nobody put there.
    expect([settled.settledAmount, settled.refundedAmount, settled.adjustedAmount]).toEqual([
      AMOUNT,
      "100000",
      "-50000",
    ]);
  });

  it("keeps the cross-asset payout out of the asset it was paid from", async () => {
    const read = await overview(seller.id);
    // The USDC sale's payout landed: `payout_out` sits on its own asset row, so the
    // USDC row shows no payout and no in-transit money. A difference of the two
    // ledger kinds *within* USDC would have said 2 500 000 was still on its way.
    expect([rowFor(read, USDC).paidOutAmount, rowFor(read, USDC).inTransitAmount]).toEqual([
      "0",
      "0",
    ]);
    expect([
      rowFor(read, DESTINATION).settledAmount,
      rowFor(read, DESTINATION).paidOutAmount,
    ]).toEqual(["0", "2400000"]);
  });

  it("orders the asset rows the same way twice, whatever the two reads' plans returned", async () => {
    const first = (await overview(seller.id)).byAsset.map((row) => row.asset);
    const second = (await overview(seller.id)).byAsset.map((row) => row.asset);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });

  it("counts a second asset's settled money on its own row", async () => {
    const read = await overview(seller.id);
    // No swap and no payout for the OTHER sale, so it is in transit in full.
    expect([
      rowFor(read, OTHER).settledAmount,
      rowFor(read, OTHER).inTransitAmount,
      rowFor(read, OTHER).paidOutAmount,
    ]).toEqual(["1000000", "1000000", "0"]);
  });
});

suite("in transit is the payout that has not finished (UI-6)", () => {
  it("moves the number when the provider reports the swap terminal", async () => {
    const seller = await newSeller();
    const hash = `tx-${run}-stale`;
    const paymentId = await newSettledPayment(seller, { amount: "3000000", nearTxHash: hash });
    await book(seller, paymentId, "3000000", USDC, "intents");
    const swapId = await newSwap(seller, hash, { terminal: false });

    expect((await overview(seller.id)).byAsset[0]?.inTransitAmount).toBe("3000000");

    // The same row, now answered by the poller (D6 stamps `terminal_at` beside the
    // state), and the money has stopped being in flight.
    await need()
      .db.update(swaps)
      .set({ terminalAt: new Date(), state: "succeeded" })
      .where(eq(swaps.id, swapId));
    expect((await overview(seller.id)).byAsset[0]?.inTransitAmount).toBe("0");
  });

  it("never counts a direct sale, whose payout was booked at settlement", async () => {
    const seller = await newSeller();
    const paymentId = await newSettledPayment(seller, { amount: "4000000", route: "direct" });
    await book(seller, paymentId, "4000000", USDC, "direct");
    const read = await overview(seller.id);
    expect([rowFor(read, USDC).settledAmount, rowFor(read, USDC).inTransitAmount]).toEqual([
      "4000000",
      "0",
    ]);
    // D8's own shape, restated here because it is what makes the two halves agree:
    // a direct payment has its `payout_out` in the asset it was paid in.
    expect(rowFor(read, USDC).paidOutAmount).toBe("4000000");
  });

  it("counts a settled payment whose hash is missing, because nothing proves it left", async () => {
    const seller = await newSeller();
    const paymentId = await newSettledPayment(seller, { amount: "700000", nearTxHash: null });
    await book(seller, paymentId, "700000", USDC, "intents");
    expect((await overview(seller.id)).byAsset[0]?.inTransitAmount).toBe("700000");
  });

  it("leaves an unbooked settlement as in-transit money beside a settled total of zero", async () => {
    // G6·2's row, seen from the other side: the ledger never heard about this
    // payment, so a screen that derived its asset list from the ledger would drop
    // the asset and the seller would read "no USDC on the way" about money that is.
    const seller = await newSeller();
    const paymentId = await newSettledPayment(seller, {
      amount: "9000000",
      nearTxHash: `tx-${run}-unbooked`,
    });
    const read = await overview(seller.id);
    expect([rowFor(read, USDC).settledAmount, rowFor(read, USDC).inTransitAmount]).toEqual([
      "0",
      "9000000",
    ]);
  });

  it("ignores payments that are not settled, whichever state they are in", async () => {
    const seller = await newSeller();
    for (const state of ["verified", "abandoned", "served_unsettled"]) {
      await newSettledPayment(seller, {
        amount: "5000000",
        state,
        nearTxHash: `tx-${run}-${state}`,
      });
    }
    const read = await overview(seller.id);
    expect(read.byAsset).toEqual([]);
    expect(read.servedUnsettledCount).toBe(1);
  });

  it("answers from the route the payment carries, and from the endpoint only when it has none", async () => {
    // PO-7 as a read: editing an endpoint's terms (D9) must not change what the
    // seller is told about money already taken, and a payment with no route still
    // needs an answer.
    const intentsEndpoint = await newSeller("intents");
    await newSettledPayment(intentsEndpoint, { amount: "1000000", route: "direct" });
    await newSettledPayment(intentsEndpoint, { amount: "2000000", route: "intents" });
    await newSettledPayment(intentsEndpoint, { amount: "3000000", route: "none" });
    // direct + intents + no-route-on-an-intents-endpoint
    expect((await overview(intentsEndpoint.id)).byAsset[0]?.inTransitAmount).toBe("5000000");

    const directEndpoint = await newSeller("direct");
    await newSettledPayment(directEndpoint, { amount: "1000000", route: "intents" });
    await newSettledPayment(directEndpoint, { amount: "2000000", route: "none" });
    // The route the payment carries wins over the endpoint below it, so the sale opened
    // on the intents route is still on its way even though the endpoint now says
    // direct; only the routeless one takes the endpoint's answer, and direct is not in
    // transit.
    expect((await overview(directEndpoint.id)).byAsset[0]?.inTransitAmount).toBe("1000000");
  });

  it("keeps another seller's money out of these totals", async () => {
    const mine = await newSeller();
    const theirs = await newSeller();
    const theirsPayment = await newSettledPayment(theirs, { amount: "8000000" });
    await book(theirs, theirsPayment, "8000000", USDC, "intents");
    const minePayment = await newSettledPayment(mine, { amount: "1000000" });
    await book(mine, minePayment, "1000000", USDC, "intents");

    const read = await overview(mine.id);
    expect(read.byAsset).toHaveLength(1);
    expect([rowFor(read, USDC).settledAmount, rowFor(read, USDC).inTransitAmount]).toEqual([
      "1000000",
      "1000000",
    ]);
  });
});

suite("the two counts (UI-6)", () => {
  it("counts open work only, and the sales served without settling", async () => {
    const { db, sql } = need();
    const seller = await newSeller();
    for (const [code, resolved] of [
      ["PAYMENT_NOT_SWEPT", false],
      ["PAYMENT_UNBOOKED", false],
      ["PAYOUT_FAILED", true],
    ] as const) {
      await db.insert(discrepancies).values({
        sellerId: seller.id,
        code,
        severity: "high",
        dedupeKey: `f6-${code}-${randomUUID()}`,
        explanation: "fixture",
        suggestedAction: "fixture",
        resolvedAt: resolved ? new Date() : null,
      });
    }
    await newSettledPayment(seller, { state: "served_unsettled", amount: "10" });
    await newSettledPayment(seller, { state: "served_unsettled", amount: "20" });

    const read = await overview(seller.id);
    expect([read.openDiscrepancies, read.servedUnsettledCount]).toEqual([2, 2]);

    // And a resolve takes the count down, because the number is the worklist's own
    // predicate rather than a copy of it kept somewhere else.
    await sql`update discrepancies set resolved_at = now() where seller_id = ${seller.id} and resolved_at is null and code = ${"PAYMENT_NOT_SWEPT"}`;
    expect((await overview(seller.id)).openDiscrepancies).toBe(1);
  });
});

suite("the payout mode answers the same in both forms (PO-7)", () => {
  /**
   * The overview decides the mode inside SQL and E9 decides it in TypeScript, from
   * the same two columns. Two forms of one rule are one rule only while they agree,
   * so the precedence is run against every pair of column values a row can hold —
   * including the words neither column should ever contain, which is where a
   * default in one form and a default in the other would part company.
   */
  const cases: readonly [string | null, string][] = [
    ["direct", "direct"],
    ["direct", "intents"],
    ["standing", "direct"],
    ["standing", "intents"],
    ["per_payment", "direct"],
    [null, "direct"],
    [null, "intents"],
    [null, "not-a-mode"],
    ["not-a-mode", "direct"],
  ];

  it("agrees row for row with payoutModeOf", async () => {
    const values = cases
      .map(([routeMode, endpointMode]) => {
        const rm = routeMode === null ? "null" : `'${routeMode}'::text`;
        return `(${rm}, '${endpointMode}'::text)`;
      })
      .join(", ");
    const rows = await need().db.execute(
      sql`select t.rm, t.em, ${intentsModeSql(
        sql`t.rm`,
        sql`t.em`,
      )} as intents from (values ${sql.raw(values)}) as t(rm, em)`,
    );
    const answered = rows as unknown as { rm: string | null; em: string; intents: boolean }[];
    expect(answered).toHaveLength(cases.length);

    for (const [index, row] of answered.entries()) {
      const currentCase = cases[index];
      if (currentCase === undefined) {
        throw new Error(`missing case at index ${index}`);
      }
      const [routeMode, endpointMode] = currentCase;
      expect({
        routeMode,
        endpointMode,
        sql: row.intents,
        ts: payoutModeOf(row.rm, row.em).mode === "intents",
      }).toEqual({
        routeMode,
        endpointMode,
        sql: payoutModeOf(routeMode, endpointMode).mode === "intents",
        ts: payoutModeOf(routeMode, endpointMode).mode === "intents",
      });
    }
  });
});

// --- the route ------------------------------------------------------------------------

let env: Env;
const sessionOf = (seller: Seller): SessionClaims => ({
  sellerId: seller.id,
  nearAccountId: seller.near,
});

function envWith(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: "x".repeat(32),
    GATEWAY_PUBLIC_URL: "https://gateway.test",
    ...overrides,
  });
}

function route(session: SessionClaims | null) {
  return createOverviewRoutes({
    db: need().db,
    env,
    log: quiet,
    session: async () => session,
  });
}

suite("GET /api/overview (UI-6, F6)", () => {
  let seller: Seller;
  let session: SessionClaims;

  beforeAll(async () => {
    env = envWith();
    seller = await newSeller();
    session = sessionOf(seller);
    const paymentId = await newSettledPayment(seller, { amount: "6000000" });
    await book(seller, paymentId, "6000000", USDC, "intents");
  });

  it("refuses a request with no session, in the shape the dashboard parses", async () => {
    const response = await route(null).request("/overview");
    expect(response.status).toBe(401);
    expect(dashboardErrorSchema.parse(await response.json()).code).toBe("unauthenticated");
  });

  it("answers a body its own contract describes, with no number invented on the way", async () => {
    const response = await route(session).request("/overview");
    expect(response.status).toBe(200);
    const parsed = overviewResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`the route answered outside its own contract: ${parsed.error.message}`);
    }
    expect(parsed.data.overview.byAsset).toEqual([
      {
        asset: USDC,
        settledAmount: "6000000",
        inTransitAmount: "6000000",
        paidOutAmount: "0",
        refundedAmount: "0",
        adjustedAmount: "0",
      },
    ]);
  });

  it("answers for the session's seller and for nobody else", async () => {
    const theirs = await newSeller();
    const theirsPayment = await newSettledPayment(theirs, { amount: "12000000" });
    await book(theirs, theirsPayment, "12000000", USDC, "intents");

    const asTheirs = await route(sessionOf(theirs)).request("/overview");
    const body = overviewResponseSchema.parse(await asTheirs.json());
    expect(body.overview.byAsset).toHaveLength(1);
    expect(rowFor(body.overview, USDC).settledAmount).toBe("12000000");

    const asMine = overviewResponseSchema.parse(
      await (await route(session).request("/overview")).json(),
    );
    expect(rowFor(asMine.overview, USDC).settledAmount).toBe("6000000");
  });

  it("refuses to answer partly when there is more to show than the contract holds", async () => {
    // 33 assets is past `byAsset`'s cap (C15). The route cannot describe them, so it
    // says so with a code rather than returning 32 of them: an omitted asset reads
    // as a token the seller has no money in.
    const crowd = await newSeller();
    for (let index = 0; index < 33; index += 1) {
      await newSettledPayment(crowd, { amount: "1000", asset: `asset-${index}-${run}.testnet` });
    }
    const response = await route(sessionOf(crowd)).request("/overview");
    expect(response.status).toBe(500);
    expect(dashboardErrorSchema.parse(await response.json()).code).toBe("overview_unreadable");
  });
});

suite("createApp mounts the overview", () => {
  it("answers /api/overview from the same app as the rest of the dashboard", async () => {
    const seller = await newSeller();
    const paymentId = await newSettledPayment(seller, { amount: "1500000" });
    await book(seller, paymentId, "1500000", USDC, "intents");

    const { createApp } = await import("../src/app.ts");
    const app = createApp({
      env,
      log: quiet,
      db: need().db,
      x402: (await import("../src/x402/near.ts")).createX402Near({
        network: "near:testnet",
        maxSponsoredGas: 30_000_000_000_000n,
      }),
      overview: { session: async () => sessionOf(seller) },
    });

    const response = await app.request("/api/overview");
    expect(response.status).toBe(200);
    const body = overviewResponseSchema.parse(await response.json());
    expect(rowFor(body.overview, USDC).settledAmount).toBe("1500000");
  });
});

afterAll(async () => {
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});
