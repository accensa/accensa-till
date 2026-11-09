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

/**
 * Release the pool. `server.ts` never calls this — it is meant to listen until the
 * process is killed — but a script that finishes its work and leaves the pooled
 * sockets open is a script that never exits.
 */
export function closeDb(db: Db): Promise<unknown> {
  return db.$client.end({ timeout: 5 });
}
