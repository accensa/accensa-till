ALTER TABLE "swaps" ADD COLUMN "poll_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "next_poll_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "swaps_poll_due_idx" ON "swaps" USING btree ("next_poll_at") WHERE "swaps"."terminal_at" is null;