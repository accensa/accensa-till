DROP INDEX "discrepancies_open_dedupe";--> statement-breakpoint
CREATE UNIQUE INDEX "discrepancies_open_dedupe" ON "discrepancies" USING btree ("seller_id","dedupe_key") WHERE resolved_at is null;