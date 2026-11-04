import { newId } from "@till/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Data model for ARCHITECTURE.md section 6 (task A7).
 *
 * - Amounts are `numeric(78,0)` base units. Drizzle returns a numeric column as
 *   a string, so services convert with `toBaseUnits` from @till/core and only
 *   ever do arithmetic in `bigint`. Never a float, in column or code form
 *   (AGENTS.md hard rule 3).
 * - Ids are UUID v7, minted in the app by `newId()` from @till/core rather than
 *   by `gen_random_uuid()`. The 48-bit millisecond prefix means an id sorts with
 *   the row's insertion, to the millisecond, within one process (A20). That is a
 *   locality hint and a tiebreaker only: it is not a timestamp, and every time
 *   comparison and every ordering of record still reads `created_at`, which the
 *   database stamps (hard rule 12).
 * - Every table carries `created_at` with a database default; time comparisons
 *   read database time, never an application clock (hard rule 12).
 */

const id = () => uuid("id").primaryKey().$defaultFn(newId);
const money = (name: string) => numeric(name, { precision: 78, scale: 0 });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** drizzle-orm 0.38 exports no `bytea` helper, so the SQL type is declared here. */
const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const sellers = pgTable("sellers", {
  id: id(),
  nearAccountId: text("near_account_id").notNull().unique(),
  displayName: text("display_name"),
  createdAt: createdAt(),
});

export const payoutRoutes = pgTable(
  "payout_routes",
  {
    id: id(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id),
    destinationChain: text("destination_chain").notNull(),
    /** 6-decimal stablecoin only (D11, hard rule 9). */
    destinationAsset: text("destination_asset").notNull(),
    destinationAddress: text("destination_address").notNull(),
    refundAddress: text("refund_address").notNull(),
    provider: text("provider").notNull(),
    depositAddress: text("deposit_address"),
    depositMemo: text("deposit_memo"),
    quoteRef: text("quote_ref"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /** standing | per_payment — one of the two intents sub-designs survives S2. */
    modeDetail: text("mode_detail").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("payout_routes_seller_idx").on(table.sellerId)],
);

export const endpoints = pgTable(
  "endpoints",
  {
    id: id(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id),
    /** Random suffix, not enumerable (GW-8 surface area). */
    slug: text("slug").notNull().unique(),
    upstreamUrl: text("upstream_url").notNull(),
    /** Enforced against MIN_PRICE_BASE_UNITS at creation, not in the database (PO-2, S7). */
    priceAmount: money("price_amount").notNull(),
    assetContract: text("asset_contract").notNull(),
    network: text("network").notNull(),
    description: text("description"),
    payoutMode: text("payout_mode").notNull(),
    routeId: uuid("route_id").references(() => payoutRoutes.id),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [index("endpoints_seller_idx").on(table.sellerId)],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    /** Snapshotted at verify time so a later route edit cannot rewrite history (PO-7). */
    routeId: uuid("route_id").references(() => payoutRoutes.id),
    payerAccountId: text("payer_account_id").notNull(),
    /** Snapshot of the price at verify time (PO-7). */
    amount: money("amount").notNull(),
    assetContract: text("asset_contract").notNull(),
    replayKey: text("replay_key").notNull().unique(),
    /** verified | abandoned | settled | served_unsettled */
    state: text("state").notNull(),
    delegateExpiresAt: timestamp("delegate_expires_at", { withTimezone: true }),
    nearTxHash: text("near_tx_hash"),
    upstreamStatus: integer("upstream_status"),
    upstreamMs: integer("upstream_ms"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("payments_endpoint_idx").on(table.endpointId),
    index("payments_payer_idx").on(table.payerAccountId, table.state),
    // C8: one in-flight paid request per payer, and GW-7 strikes both read this.
    index("payments_payer_unsettled_idx")
      .on(table.payerAccountId, table.state)
      .where(sql`state in ('verified', 'served_unsettled')`),
  ],
);

/**
 * C9 (GW-7): a seller lifting a payer's strike block.
 *
 * The block itself is not stored — it is computed from `payments` (two
 * `served_unsettled` rows in 24 hours, ARCHITECTURE 4.3) — so the only thing that
 * needs a row is the seller's decision to end it. A clear is a watermark rather
 * than a delete: the strike query counts only rows that came after the newest
 * clear for this payer and seller, which keeps payment history unrewritten
 * (PO-7) and makes every clear auditable.
 *
 * Scoped to a seller, because the block protects that seller's upstream: a
 * second seller must not be able to lift a block that is not theirs to lift.
 */
export const payerClears = pgTable(
  "payer_clears",
  {
    id: id(),
    payerAccountId: text("payer_account_id").notNull(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id),
    /** The session subject that cleared it (UI-1), or a test's label until then. */
    clearedBy: text("cleared_by").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (table) => [
    index("payer_clears_pair_idx").on(table.payerAccountId, table.sellerId, table.createdAt),
  ],
);

export const swaps = pgTable(
  "swaps",
  {
    id: id(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => payoutRoutes.id),
    /** Set when matched by transaction hash; null means unmatched, not unrelated (LR-2). */
    paymentId: uuid("payment_id").references(() => payments.id),
    providerRef: text("provider_ref").notNull().unique(),
    /** NormalizedSwapState; unknown provider statuses map to processing (PO-4). */
    state: text("state").notNull(),
    amountIn: money("amount_in"),
    amountOut: money("amount_out"),
    minAmountOut: money("min_amount_out"),
    /** Match key against payments.near_tx_hash. Nothing else may match on it. */
    originTxHash: text("origin_tx_hash"),
    destinationTxHash: text("destination_tx_hash"),
    refundedAmount: money("refunded_amount"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    /** Raw provider payload, kept so a mapping bug is diagnosable without a re-poll. */
    raw: jsonb("raw").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("swaps_origin_tx_idx").on(table.originTxHash),
    index("swaps_route_idx").on(table.routeId, table.state),
  ],
);

/**
 * Append only. A database trigger rejects UPDATE and DELETE; corrections are
 * new `adjustment` rows (6.1). Only services/ledger.ts inserts, and
 * scripts/check-boundaries.sh greps for other insert sites.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id),
    /** payment_in | payout_out | refund_in | adjustment */
    kind: text("kind").notNull(),
    amount: money("amount").notNull(),
    /** Asset per entry; there is no cross-asset balance (6.1). */
    asset: text("asset").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id),
    swapId: uuid("swap_id").references(() => swaps.id),
    note: text("note"),
    createdAt: createdAt(),
  },
  (table) => [index("ledger_seller_asset_idx").on(table.sellerId, table.asset)],
);

export const discrepancies = pgTable(
  "discrepancies",
  {
    id: id(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id),
    swapId: uuid("swap_id").references(() => swaps.id),
    /** code plus subject ids, with "none" for nulls (LR-5). */
    dedupeKey: text("dedupe_key").notNull(),
    explanation: text("explanation").notNull(),
    suggestedAction: text("suggested_action").notNull(),
    details: jsonb("details"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    createdAt: createdAt(),
  },
  (table) => [
    // LR-5: at most one OPEN discrepancy per cause, including causes with a null
    // payment or swap id — a plain unique constraint would treat nulls as
    // distinct and fail to dedupe (ARCHITECTURE.md 14.1).
    uniqueIndex("discrepancies_open_dedupe")
      .on(table.dedupeKey)
      .where(sql`resolved_at is null`),
    index("discrepancies_seller_open_idx")
      .on(table.sellerId, table.openedAt)
      .where(sql`resolved_at is null`),
  ],
);

/** GW-9, P1: a paid-but-undelivered response, replayable for five minutes. */
export const responseCache = pgTable("response_cache", {
  replayKey: text("replay_key").primaryKey(),
  status: integer("status").notNull(),
  headers: jsonb("headers").notNull(),
  /** Capped at 256 KB by the writer; bytea keeps the size honest (ARCHITECTURE.md 6). */
  body: bytea("body").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type Seller = typeof sellers.$inferSelect;
export type Endpoint = typeof endpoints.$inferSelect;
export type PayoutRoute = typeof payoutRoutes.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Swap = typeof swaps.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type Discrepancy = typeof discrepancies.$inferSelect;
