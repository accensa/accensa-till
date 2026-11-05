import { newId } from "@till/core";
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { sellers } from "../db/schema.ts";

/**
 * The seller row behind an account name (F1, UI-1).
 *
 * Sign-in is self-service: the first successful signature for an account creates
 * the row, and nothing else can. That is deliberate — Till has no onboarding step
 * to invent, and a seller who cannot sign in cannot have endpoints anyway. So this
 * is the *only* place a seller is created, and the account name is the key: it is
 * what the chain says, not what someone typed.
 *
 * `display_name` stays null. It belongs to the seller to set later, and a name
 * read out of an account id would be a guess dressed up as data.
 */

export type SellerRow = {
  readonly id: string;
  readonly nearAccountId: string;
  readonly displayName: string | null;
};

const columns = {
  id: sellers.id,
  nearAccountId: sellers.nearAccountId,
  displayName: sellers.displayName,
} as const;

export async function findOrCreateSeller(db: Db, nearAccountId: string): Promise<SellerRow> {
  const inserted = await db
    .insert(sellers)
    // The id is minted here rather than by the database so it is a UUID v7 with
    // the row's insertion order (A20).
    .values({ id: newId(), nearAccountId, displayName: null })
    .onConflictDoNothing({ target: sellers.nearAccountId })
    .returning(columns);
  if (inserted.length === 1 && inserted[0] !== undefined) {
    return inserted[0];
  }

  // Either a concurrent sign-in won the race, or this account has signed in
  // before. Both end the same way: read the row that exists.
  const [existing] = await db
    .select(columns)
    .from(sellers)
    .where(eq(sellers.nearAccountId, nearAccountId));
  if (existing === undefined) {
    throw new Error(`seller row for ${nearAccountId} disappeared between insert and read`);
  }
  return existing;
}
