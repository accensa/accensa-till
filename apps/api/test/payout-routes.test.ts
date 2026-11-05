import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type EndpointCreateInput, endpointCreateSchema } from "@till/core";

import * as schema from "../src/db/schema.ts";
import { payoutRoutes } from "../src/db/schema.ts";
import type { PayoutRoute } from "../src/db/schema.ts";
import type { PrepareRouteInput, PreparedRoute } from "../src/payouts/provider.ts";
import { type RoutePreparer, routeForDestination } from "../src/services/payout-routes.ts";

/**
 * D5 acceptance tests: the route one destination gets, and what the database itself
 * refuses to do to a route it already has (PO-1, PO-7).
 *
 * Both halves need real Postgres. The dedupe is a `select` and an insert that must
 * collide with a partial unique index, and the immutability is a trigger — a mock
 * would pass either way while the migration stayed missing, which is exactly how
 * B9 ("edits rewrite history") survived on paper long enough to need red-teaming.
 *
 * Needs `DATABASE_URL`; without one the file skips, so a run without a database
 * never reads as D5 evidence.
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
  const sql = postgres(url, { max: 4, idle_timeout: 5, connect_timeout: 3 });
  try {
    await sql`select 1`;
    const [present] = await sql`select to_regclass('public.payout_routes') as present`;
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

/** One seller per test, so a count of routes is a count of this test's routes. */
async function newSeller(): Promise<string> {
  const sellerId = randomUUID();
  const { sql } = need();
  await sql`insert into sellers (id, near_account_id, display_name)
    values (${sellerId}, ${`d5-${run}-${sellerId.slice(0, 8)}.testnet`}, 'D5 fixture')`;
  return sellerId;
}

function destination(
  overrides: Partial<Record<keyof EndpointCreateInput, unknown>> = {},
): EndpointCreateInput {
  return endpointCreateSchema.parse({
    upstreamUrl: "https://data.seller.test/prices",
    priceAmount: "10000",
    assetContract: "usdc.testnet",
    network: "near:testnet",
    payoutMode: "intents",
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: `dest-${run}.testnet`,
    refundAddress: `refund-${run}.testnet`,
    ...overrides,
  });
}

/** What a standing quote looks like, and what the preparer was asked for. */
function standing(input: PrepareRouteInput): PreparedRoute {
  return {
    depositAddress: `dep-${run}-${input.destinationAddress}`,
    depositMemo: null,
    quoteRef: `quote-${run}-${input.destinationAddress}`,
    minAmountOut: null,
    deadlineAt: null,
    modeDetail: "standing",
  };
}

type Spy = RoutePreparer & { readonly asked: PrepareRouteInput[] };

function preparer(answer?: (input: PrepareRouteInput) => PreparedRoute): Spy {
  const asked: PrepareRouteInput[] = [];
  return {
    asked,
    async prepareRoute(input) {
      asked.push(input);
      return (answer ?? standing)(input);
    },
  };
}

function resolve(
  sellerId: string,
  prep: RoutePreparer,
  input = destination(),
  providerName: "mock" | "oneclick" = "mock",
) {
  return routeForDestination(need().db, { providerName, preparer: prep }, sellerId, input);
}

async function routesOf(sellerId: string): Promise<PayoutRoute[]> {
  const rows = await need()
    .db.select()
    .from(payoutRoutes)
    .where(eq(payoutRoutes.sellerId, sellerId));
  return rows;
}

/**
 * Waits for something the event loop will not order for us. Bounded, and it throws
 * rather than passing: a race that never happened would otherwise leave the
 * collision path untested and the run green.
 */
async function settle(condition: () => boolean | Promise<boolean>, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((sleep) => setTimeout(sleep, 5));
  }
  throw new Error("the second creation never reached the first: the gate in this test is wrong");
}

function hasRouteCount(sellerId: string, count: number): () => Promise<boolean> {
  return async () => (await routesOf(sellerId)).length === count;
}

const suite = describe.skipIf(handle === null);

suite("the route one destination gets (D5, PO-1)", () => {
  it("writes a direct destination without asking a provider for a quote", async () => {
    const sellerId = await newSeller();
    const prep = preparer();

    const resolved = await resolve(
      sellerId,
      prep,
      destination({ payoutMode: "direct", destinationAddress: `${run}-seller.testnet` }),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(prep.asked).toEqual([]);
    expect(resolved.route.modeDetail).toBe("direct");
    expect(resolved.route.depositAddress).toBeNull();
    expect(resolved.route.quoteRef).toBeNull();
    expect(resolved.route.deadlineAt).toBeNull();
    expect(await routesOf(sellerId)).toHaveLength(1);
  });

  it("asks the provider for a standing quote and stores what it answered", async () => {
    const sellerId = await newSeller();
    const prep = preparer();

    const resolved = await resolve(sellerId, prep);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    // A standing route is asked for with no amount: a per-payment quote needs the
    // payment's price, which does not exist yet at endpoint creation (4.5, B12).
    expect(prep.asked).toEqual([
      {
        destinationChain: "near",
        destinationAsset: "usdc",
        destinationAddress: `dest-${run}.testnet`,
        refundAddress: `refund-${run}.testnet`,
        amount: null,
      },
    ]);
    const [route] = await routesOf(sellerId);
    expect(route).toMatchObject({
      destinationChain: "near",
      destinationAsset: "usdc",
      destinationAddress: `dest-${run}.testnet`,
      refundAddress: `refund-${run}.testnet`,
      provider: "mock",
      modeDetail: "standing",
      depositAddress: `dep-${run}-dest-${run}.testnet`,
      quoteRef: `quote-${run}-dest-${run}.testnet`,
    });
  });

  it("keeps the memo and the deadline the provider answered with", async () => {
    const sellerId = await newSeller();
    const deadlineAt = new Date("2026-11-05T00:00:00.000Z");
    const prep = preparer((input) => ({
      ...standing(input),
      depositMemo: "memo-77",
      deadlineAt,
      modeDetail: "per_payment",
    }));

    const resolved = await resolve(sellerId, prep);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    const [route] = await routesOf(sellerId);
    expect(route?.depositMemo).toBe("memo-77");
    expect(route?.modeDetail).toBe("per_payment");
    // The driver hands a timestamptz back as a Date; comparing the instant keeps
    // this off the wall clock (hard rule 12).
    expect(route?.deadlineAt?.toISOString()).toBe(deadlineAt.toISOString());
  });

  it("reuses the standing route for a second endpoint on the same destination", async () => {
    const sellerId = await newSeller();
    const prep = preparer();

    const first = await resolve(sellerId, prep);
    const second = await resolve(sellerId, prep);

    expect([first.ok, second.ok]).toEqual([true, true]);
    if (!first.ok || !second.ok) {
      return;
    }
    // One quote per destination is B12's defence, and it is the provider call that
    // costs, not the row: the second endpoint must not have asked again.
    expect(prep.asked).toHaveLength(1);
    expect(second.route.id).toBe(first.route.id);
    expect(second.reused).toBe(true);
    expect(await routesOf(sellerId)).toHaveLength(1);
  });

  it("counts the same destination typed differently as one destination", async () => {
    const sellerId = await newSeller();
    const prep = preparer();

    await resolve(sellerId, prep, destination({ destinationChain: "NEAR" }));
    const second = await resolve(sellerId, prep, destination({ destinationChain: "near" }));

    expect(prep.asked).toHaveLength(1);
    if (second.ok) {
      expect(second.route.destinationChain).toBe("near");
    }
    expect(await routesOf(sellerId)).toHaveLength(1);
  });

  it("a new destination is a new row, and the first route still reads the first destination", async () => {
    const sellerId = await newSeller();
    const prep = preparer();

    const first = await resolve(sellerId, prep, destination({ destinationAddress: `one-${run}` }));
    const second = await resolve(
      sellerId,
      prep,
      destination({ destinationAddress: `two-${run}.testnet` }),
    );

    expect([first.ok, second.ok]).toEqual([true, true]);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(prep.asked).toHaveLength(2);
    expect(second.route.id).not.toBe(first.route.id);

    const rows = await routesOf(sellerId);
    expect(rows).toHaveLength(2);
    const storedFirst = rows.find((row) => row.id === first.route.id);
    expect(storedFirst?.destinationAddress).toBe(`one-${run}`);
    expect(storedFirst?.depositAddress).toBe(`dep-${run}-one-${run}`);
  });

  it("treats a different refund account as a different destination", async () => {
    const sellerId = await newSeller();
    const prep = preparer();

    await resolve(sellerId, prep);
    const second = await resolve(
      sellerId,
      prep,
      destination({ refundAddress: `else-${run}.testnet` }),
    );

    expect(prep.asked).toHaveLength(2);
    expect(second.ok).toBe(true);
    expect(await routesOf(sellerId)).toHaveLength(2);
  });

  it("does not hand a route prepared by one provider to another", async () => {
    const sellerId = await newSeller();
    const mock = preparer();
    const oneclick = preparer();

    const first = await resolve(sellerId, mock);
    const second = await resolve(sellerId, oneclick, destination(), "oneclick");

    expect([first.ok, second.ok]).toEqual([true, true]);
    if (!first.ok || !second.ok) {
      return;
    }
    // A `mock-deposit-*` address reused under `oneclick` would advertise a fake
    // account as a real one, so the provider is part of what a route is keyed by.
    expect(second.route.id).not.toBe(first.route.id);
    expect([first.route.provider, second.route.provider]).toEqual(["mock", "oneclick"]);
    expect(mock.asked).toHaveLength(1);
    expect(oneclick.asked).toHaveLength(1);
  });

  it("does not hand a direct destination's route to an intents creation", async () => {
    const sellerId = await newSeller();
    const prep = preparer();

    const direct = await resolve(sellerId, prep, destination({ payoutMode: "direct" }));
    const intents = await resolve(sellerId, prep);

    expect([direct.ok, intents.ok]).toEqual([true, true]);
    if (!direct.ok || !intents.ok) {
      return;
    }
    // A direct route's deposit address is null by definition (PO-6), so reusing one
    // for an intents endpoint would advertise an empty pay-to and hand the gateway a
    // `pay_to_unresolved` refusal on a row the seller was told was active. Each mode
    // keeps its own row for the same tuple.
    expect(direct.route.modeDetail).toBe("direct");
    expect(direct.route.depositAddress).toBeNull();
    expect(intents.route.id).not.toBe(direct.route.id);
    expect(intents.route.modeDetail).toBe("standing");
    expect(intents.route.depositAddress).toBe(`dep-${run}-dest-${run}.testnet`);
    expect(prep.asked).toHaveLength(1);
    expect(await routesOf(sellerId)).toHaveLength(2);
  });

  it("refuses when the provider refuses, and writes no route", async () => {
    const sellerId = await newSeller();
    const prep: RoutePreparer = {
      async prepareRoute() {
        throw new Error("1Click: the quote window closed");
      },
    };

    const resolved = await resolve(sellerId, prep);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.detail).toContain("the quote window closed");
    expect(await routesOf(sellerId)).toEqual([]);
  });

  it("refuses an intents route the provider answered with no deposit address", async () => {
    const sellerId = await newSeller();
    const prep = preparer((input) => ({ ...standing(input), depositAddress: null }));

    const resolved = await resolve(sellerId, prep);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.detail).toMatch(/no deposit address/);
    expect(await routesOf(sellerId)).toEqual([]);
  });

  it("lands two racing creations for one destination on one row", async () => {
    const sellerId = await newSeller();
    // Two quotes for one destination, which is what two parallel creations get: the
    // first is held inside `prepareRoute` until the second has written its row, so
    // the loser really does collide with `payout_routes_destination_key` rather than
    // reading the winner through an ordinary lookup. The event loop decides the
    // unforced version of this, and an unforced race proves nothing.
    const asked: PrepareRouteInput[] = [];
    let quote = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prep: RoutePreparer = {
      async prepareRoute(input) {
        asked.push(input);
        quote += 1;
        if (quote === 1) {
          await gate;
        }
        return { ...standing(input), depositAddress: `dep-${run}-race-${quote}` };
      },
    };

    const first = routeForDestination(
      need().db,
      { providerName: "mock", preparer: prep },
      sellerId,
      destination(),
    );
    await settle(() => asked.length === 1);
    const second = routeForDestination(
      need().db,
      { providerName: "mock", preparer: prep },
      sellerId,
      destination(),
    );
    await settle(hasRouteCount(sellerId, 1));
    release();

    const both = await Promise.all([first, second]);
    expect(both.map((result) => result.ok)).toEqual([true, true]);
    const [a, b] = both as [{ ok: true; route: PayoutRoute }, { ok: true; route: PayoutRoute }];
    expect(asked).toHaveLength(2);
    expect(a.route.id).toBe(b.route.id);
    expect(await routesOf(sellerId)).toHaveLength(1);
    // The row that stands is the one that was written, not the one the loser was
    // holding: both callers read the committed quote.
    const [row] = await routesOf(sellerId);
    expect(row?.depositAddress).toBe(`dep-${run}-race-2`);
    expect(a.route.depositAddress).toBe(`dep-${run}-race-2`);
    expect(b.route.depositAddress).toBe(`dep-${run}-race-2`);
  });
});

suite("what the database refuses about a route it already has (D5, PO-7)", () => {
  let sellerId = "";
  let route: PayoutRoute | null = null;

  beforeAll(async () => {
    sellerId = await newSeller();
    const resolved = await resolve(sellerId, preparer(), destination());
    if (!resolved.ok) {
      throw new Error(`the fixture route was not written: ${resolved.detail}`);
    }
    route = resolved.route;
  });

  function routeId(): string {
    if (route === null) {
      throw new Error("the fixture route is missing");
    }
    return route.id;
  }

  it("refuses to rewrite a route, through drizzle or through raw SQL", async () => {
    const { db, sql } = need();

    await expect(
      db
        .update(payoutRoutes)
        .set({ destinationAddress: `moved-${run}.testnet` })
        .where(eq(payoutRoutes.id, routeId())),
    ).rejects.toThrow(/payout_routes is immutable \(UPDATE is forbidden\)/);

    await expect(
      sql`update payout_routes set deposit_address = ${`late-${run}`} where id = ${routeId()}`,
    ).rejects.toThrow(/payout_routes is immutable/);

    const [row] = await routesOf(sellerId);
    expect(row?.destinationAddress).toBe(`dest-${run}.testnet`);
  });

  it("refuses to delete a route a payment points at", async () => {
    const { sql } = need();
    const endpointId = randomUUID();
    const paymentId = randomUUID();

    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode, route_id)
      values (${endpointId}, ${sellerId}, ${`d5-${endpointId}`}, 'https://data.seller.test/prices',
        '10000', 'usdc.testnet', 'near:testnet', 'intents', ${routeId()})`;
    await sql`insert into payments (id, endpoint_id, route_id, payer_account_id, amount,
        asset_contract, replay_key, state, verified_at)
      values (${paymentId}, ${endpointId}, ${routeId()}, ${`buyer-${run}.testnet`}, '10000',
        'usdc.testnet', ${`d5-${paymentId}`}, 'settled', now())`;

    await expect(sql`delete from payout_routes where id = ${routeId()}`).rejects.toThrow(
      /violates foreign key constraint/,
    );
    await expect(sql`delete from endpoints where id = ${endpointId}`).rejects.toThrow(
      /violates foreign key constraint/,
    );

    // The history the trigger protects: the payment is still on the route it paid
    // out to, and that route still says where the money was going.
    const [payment] = await sql`select route_id, deposit_address from payments
        join payout_routes on payout_routes.id = payments.route_id
        where payments.id = ${paymentId}`;
    expect(payment?.route_id).toBe(routeId());
    expect(payment?.deposit_address).toBe(`dep-${run}-dest-${run}.testnet`);

    await sql`delete from payments where id = ${paymentId}`;
    await sql`delete from endpoints where id = ${endpointId}`;
  });

  it("keeps an earlier payment on its own route when the destination changes", async () => {
    const { sql } = need();
    const prep = preparer();

    const earlier = await resolve(sellerId, prep, destination());
    const later = await resolve(
      sellerId,
      prep,
      destination({ destinationAddress: `moved-${run}.testnet` }),
    );
    expect([earlier.ok, later.ok]).toEqual([true, true]);
    if (!earlier.ok || !later.ok) {
      return;
    }

    const endpointId = randomUUID();
    const paymentId = randomUUID();
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode, route_id)
      values (${endpointId}, ${sellerId}, ${`d5-${endpointId}`}, 'https://data.seller.test/prices',
        '10000', 'usdc.testnet', 'near:testnet', 'intents', ${earlier.route.id})`;
    await sql`insert into payments (id, endpoint_id, route_id, payer_account_id, amount,
        asset_contract, replay_key, state, verified_at)
      values (${paymentId}, ${endpointId}, ${earlier.route.id}, ${`buyer-${run}.testnet`},
        '10000', 'usdc.testnet', ${`d5-${paymentId}`}, 'settled', now())`;

    // A destination change is an UPDATE of the endpoint, never of the route.
    await sql`update endpoints set route_id = ${later.route.id} where id = ${endpointId}`;

    const [row] = await sql`select route_id from payments where id = ${paymentId}`;
    expect(row?.route_id).toBe(earlier.route.id);
    const [endpoint] = await sql`select route_id from endpoints where id = ${endpointId}`;
    expect(endpoint?.route_id).toBe(later.route.id);
    expect(await routesOf(sellerId)).toHaveLength(2);

    await sql`delete from payments where id = ${paymentId}`;
    await sql`delete from endpoints where id = ${endpointId}`;
  });
});

afterAll(async () => {
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 }).catch(() => undefined);
  }
});
