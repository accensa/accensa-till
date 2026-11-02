import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

/**
 * One pooled Postgres client per process (AGENTS.md hard rule 10).
 *
 * `select now()` for the reconciliation clock belongs in db/queries/ under task
 * A7, not here: it needs a test against real Postgres, and a scaffold cannot
 * provide one.
 */
export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10, idle_timeout: 20, connect_timeout: 10 });
  return drizzle(client, { schema });
}
