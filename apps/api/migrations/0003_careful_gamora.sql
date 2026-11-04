ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_price_amount_non_negative" CHECK ("endpoints"."price_amount" >= 0);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_sign_by_kind" CHECK (("ledger_entries"."kind" in ('payment_in', 'payout_out', 'refund_in')
          and "ledger_entries"."amount" >= 0)
        or ("ledger_entries"."kind" = 'adjustment'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_non_negative" CHECK ("payments"."amount" >= 0);--> statement-breakpoint
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_refunded_amount_within_amount_in" CHECK ("swaps"."refunded_amount" is null or "swaps"."amount_in" is null
        or "swaps"."refunded_amount" <= "swaps"."amount_in");