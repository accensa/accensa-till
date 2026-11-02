CREATE TABLE "discrepancies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"payment_id" uuid,
	"swap_id" uuid,
	"dedupe_key" text NOT NULL,
	"explanation" text NOT NULL,
	"suggested_action" text NOT NULL,
	"details" jsonb,
	"opened_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"upstream_url" text NOT NULL,
	"price_amount" numeric(78, 0) NOT NULL,
	"asset_contract" text NOT NULL,
	"network" text NOT NULL,
	"description" text,
	"payout_mode" text NOT NULL,
	"route_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoints_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"asset" text NOT NULL,
	"payment_id" uuid,
	"swap_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"route_id" uuid,
	"payer_account_id" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"asset_contract" text NOT NULL,
	"replay_key" text NOT NULL,
	"state" text NOT NULL,
	"delegate_expires_at" timestamp with time zone,
	"near_tx_hash" text,
	"upstream_status" integer,
	"upstream_ms" integer,
	"verified_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_replay_key_unique" UNIQUE("replay_key")
);
--> statement-breakpoint
CREATE TABLE "payout_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"destination_chain" text NOT NULL,
	"destination_asset" text NOT NULL,
	"destination_address" text NOT NULL,
	"refund_address" text NOT NULL,
	"provider" text NOT NULL,
	"deposit_address" text,
	"deposit_memo" text,
	"quote_ref" text,
	"deadline_at" timestamp with time zone,
	"mode_detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "response_cache" (
	"replay_key" text PRIMARY KEY NOT NULL,
	"status" integer NOT NULL,
	"headers" jsonb NOT NULL,
	"body" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"near_account_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sellers_near_account_id_unique" UNIQUE("near_account_id")
);
--> statement-breakpoint
CREATE TABLE "swaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"payment_id" uuid,
	"provider_ref" text NOT NULL,
	"state" text NOT NULL,
	"amount_in" numeric(78, 0),
	"amount_out" numeric(78, 0),
	"min_amount_out" numeric(78, 0),
	"origin_tx_hash" text,
	"destination_tx_hash" text,
	"refunded_amount" numeric(78, 0),
	"last_polled_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swaps_provider_ref_unique" UNIQUE("provider_ref")
);
--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_swap_id_swaps_id_fk" FOREIGN KEY ("swap_id") REFERENCES "public"."swaps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_route_id_payout_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."payout_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_swap_id_swaps_id_fk" FOREIGN KEY ("swap_id") REFERENCES "public"."swaps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_route_id_payout_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."payout_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_routes" ADD CONSTRAINT "payout_routes_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_route_id_payout_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."payout_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discrepancies_open_dedupe" ON "discrepancies" USING btree ("dedupe_key") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "discrepancies_seller_open_idx" ON "discrepancies" USING btree ("seller_id","opened_at") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "endpoints_seller_idx" ON "endpoints" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "ledger_seller_asset_idx" ON "ledger_entries" USING btree ("seller_id","asset");--> statement-breakpoint
CREATE INDEX "payments_endpoint_idx" ON "payments" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "payments_payer_idx" ON "payments" USING btree ("payer_account_id","state");--> statement-breakpoint
CREATE INDEX "payments_payer_unsettled_idx" ON "payments" USING btree ("payer_account_id","state") WHERE state in ('verified', 'served_unsettled');--> statement-breakpoint
CREATE INDEX "payout_routes_seller_idx" ON "payout_routes" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "swaps_origin_tx_idx" ON "swaps" USING btree ("origin_tx_hash");--> statement-breakpoint
CREATE INDEX "swaps_route_idx" ON "swaps" USING btree ("route_id","state");