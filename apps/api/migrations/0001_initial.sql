-- Initial schema (task A7): tables from docs/ARCHITECTURE.md section 6, the
-- append-only ledger trigger, and the partial unique index behind LR-5.
--
-- HAND-WRITTEN PLACEHOLDER. Once A2 installs drizzle-kit, `pnpm db:generate`
-- owns apps/api/migrations/ and this file must be replaced by the generated
-- snapshot; do not edit generated migrations by hand afterwards. Amount columns
-- are numeric(78,0) so Postgres keeps full precision, and ids come from the app
-- as UUID v7 rather than gen_random_uuid(), so rows sort by insertion.

begin;

create table sellers (
  id uuid primary key,
  near_account_id text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table payout_routes (
  id uuid primary key,
  seller_id uuid not null references sellers (id),
  destination_chain text not null,
  destination_asset text not null,
  destination_address text not null,
  refund_address text not null,
  provider text not null,
  deposit_address text,
  deposit_memo text,
  quote_ref text,
  deadline_at timestamptz,
  mode_detail text not null,
  created_at timestamptz not null default now()
);
create index payout_routes_seller_idx on payout_routes (seller_id);

create table endpoints (
  id uuid primary key,
  seller_id uuid not null references sellers (id),
  slug text not null unique,
  upstream_url text not null,
  price_amount numeric(78, 0) not null,
  asset_contract text not null,
  network text not null,
  description text,
  payout_mode text not null,
  route_id uuid references payout_routes (id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index endpoints_seller_idx on endpoints (seller_id);

create table payments (
  id uuid primary key,
  endpoint_id uuid not null references endpoints (id),
  route_id uuid references payout_routes (id),
  payer_account_id text not null,
  amount numeric(78, 0) not null,
  asset_contract text not null,
  replay_key text not null unique,
  state text not null,
  delegate_expires_at timestamptz,
  near_tx_hash text,
  upstream_status integer,
  upstream_ms integer,
  verified_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now()
);
create index payments_endpoint_idx on payments (endpoint_id);
create index payments_payer_idx on payments (payer_account_id, state);
-- C8 one-in-flight and GW-7 strikes both query unpaid-or-unserved rows only.
create index payments_payer_unsettled_idx on payments (payer_account_id, state)
  where state in ('verified', 'served_unsettled');

create table swaps (
  id uuid primary key,
  route_id uuid not null references payout_routes (id),
  payment_id uuid references payments (id),
  provider_ref text not null unique,
  state text not null,
  amount_in numeric(78, 0),
  amount_out numeric(78, 0),
  min_amount_out numeric(78, 0),
  origin_tx_hash text,
  destination_tx_hash text,
  refunded_amount numeric(78, 0),
  last_polled_at timestamptz,
  terminal_at timestamptz,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
create index swaps_origin_tx_idx on swaps (origin_tx_hash);
create index swaps_route_idx on swaps (route_id, state);

create table ledger_entries (
  id uuid primary key,
  seller_id uuid not null references sellers (id),
  kind text not null,
  amount numeric(78, 0) not null,
  asset text not null,
  payment_id uuid references payments (id),
  swap_id uuid references swaps (id),
  note text,
  created_at timestamptz not null default now()
);
create index ledger_seller_asset_idx on ledger_entries (seller_id, asset);

-- LR-1: the ledger is append only. Corrections are new `adjustment` rows.
create function ledger_entries_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger_entries is append only (% is forbidden)', tg_op
    using hint = 'insert an adjustment row instead of changing history';
end;
$$;

create trigger ledger_entries_no_rewrite
before update or delete on ledger_entries
for each row execute function ledger_entries_is_append_only();

create table discrepancies (
  id uuid primary key,
  seller_id uuid not null references sellers (id),
  code text not null,
  severity text not null,
  payment_id uuid references payments (id),
  swap_id uuid references swaps (id),
  dedupe_key text not null,
  explanation text not null,
  suggested_action text not null,
  details jsonb,
  opened_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now()
);

-- LR-5: one open discrepancy per cause. A partial unique index is required
-- because a plain unique constraint treats null subjects as distinct and stops
-- deduplicating exactly the causes that have no payment or swap id.
create unique index discrepancies_open_dedupe on discrepancies (dedupe_key)
  where resolved_at is null;
create index discrepancies_seller_open_idx on discrepancies (seller_id, opened_at)
  where resolved_at is null;

create table response_cache (
  replay_key text primary key,
  status integer not null,
  headers jsonb not null,
  body bytea not null,
  expires_at timestamptz not null
);

commit;
