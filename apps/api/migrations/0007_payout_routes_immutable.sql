-- D5: a payout route is a snapshot of where one destination was paid out to, and a
-- payment that references one has to keep reading the way it paid out even after the
-- seller changes their mind (PO-7, red-team B9). UPDATE is the statement that would
-- rewrite that history, so the database refuses it outright.
--
-- DELETE is deliberately not refused here. The foreign keys from `endpoints`,
-- `payments` and `swaps` are `ON DELETE NO ACTION`, so a route anything references
-- already cannot be removed, and a route nothing references carries no history to
-- lose — which is also what lets a test suite clean up rows it created.
--
-- This migration is hand written, like 0001: drizzle-kit's schema cannot express a
-- trigger, so `pnpm db:generate` neither emits this file nor removes it. Keep it as
-- the last entry in `meta/_journal.json`.
--
-- The drizzle statement-breakpoint marker below is what the migrator splits on, so
-- the dollar-quoted function body must stay inside a single statement. Never mention
-- that marker in a comment: the splitter matches the text, not the line prefix, and a
-- comment containing it becomes SQL.
CREATE FUNCTION payout_routes_are_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
begin
  raise exception 'payout_routes is immutable (% is forbidden)', tg_op
    using hint = 'insert a new route and point the endpoint at it; earlier payments keep their own route_id';
end;
$$;
--> statement-breakpoint
CREATE TRIGGER payout_routes_no_rewrite
BEFORE UPDATE ON payout_routes
FOR EACH ROW EXECUTE FUNCTION payout_routes_are_immutable();
