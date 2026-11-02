-- LR-1: the ledger is append only. Corrections are new `adjustment` rows.
--
-- This migration is hand written on purpose and is the only exception to
-- "migrations/ is owned by `pnpm db:generate`": drizzle-kit's schema cannot
-- express a trigger, so generating does not emit it and regenerating never
-- removes it either. Keep it as the last entry in `meta/_journal.json`; if a
-- future `db:generate` numbers a new migration 0001, renumber this file and the
-- journal entry so the trigger still applies after the tables exist.
--
-- The drizzle statement-breakpoint marker below is what the migrator splits on,
-- so the dollar-quoted function body must stay inside a single statement. Never
-- mention that marker in a comment: the splitter matches the text, not the line
-- prefix, and a comment containing it becomes SQL.
CREATE FUNCTION ledger_entries_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
begin
  raise exception 'ledger_entries is append only (% is forbidden)', tg_op
    using hint = 'insert an adjustment row instead of changing history';
end;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_rewrite
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_entries_is_append_only();
