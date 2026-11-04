CREATE TABLE "payer_clears" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payer_account_id" text NOT NULL,
	"seller_id" uuid NOT NULL,
	"cleared_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payer_clears" ADD CONSTRAINT "payer_clears_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payer_clears_pair_idx" ON "payer_clears" USING btree ("payer_account_id","seller_id","created_at");