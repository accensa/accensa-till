import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { endpoints, payments } from "../db/schema.ts";
import type { Logger } from "../lib/logger.ts";
import { recordSettlement } from "../services/ledger.ts";
import { advancePayment } from "../services/payments.ts";
import type { SettlementVerdict } from "../x402/types.ts";

/**
 * Restart recovery (C10). A `verified` row older than the in-flight window is
 * one a dead process left behind: nothing is serving it, and Guard 3's window
 * already stopped it from blocking its payer. What it must not become is a
 * silent answer, so the boot sweep gives it a terminal state -- except when the
 * row carries a settlement hash, because then a settle returned and the chain
 * has to say whether the money moved before the row is abandoned.
 *
 * Three outcomes, and the default is the cautious one:
 *
 *   no hash        `abandoned`. If the crash came before `settle`, nothing was
 *                  charged and C7's retry serves the same authorization again.
 *                  If it came from a submit still in flight, the delegate's
 *                  nonce is the chain's guard: a replay is refused by `verify`
 *                  (`nonce_already_used`), never served twice. The one limit
 *                  this cannot remove is that a settle that landed in that
 *                  window is not booked here -- there is no hash to ask about --
 *                  so it is left to the reconcile path as an unmatched arrival.
 *   hash, settled  `settled`, and the settlement lines the route never got to
 *                  write, through the ledger's only writer. Money moved and the
 *                  row says so.
 *   hash, failed   `abandoned` **with the hash kept**. C7's `REUSE_GUARD`
 *                  refuses to reopen a row that carries a hash, so evidence of
 *                  a chain attempt outranks the retry.
 *   hash, unknown  untouched. A node that cannot answer is not evidence of
 *                  anything; the row stays visible and the next boot asks again.
 */

export type SettlementProbe = (nearTxHash: string) => Promise<SettlementVerdict>;

export type SweepDeps = {
  readonly db: Db;
  /** `inFlightWindowSeconds` from the guards: the same rule that bounds Guard 3. */
  readonly windowSeconds: number;
  readonly probe: SettlementProbe;
  readonly log?: Logger;
};

export type SweepResult = {
  readonly abandoned: number;
  readonly recovered: number;
  readonly unproven: number;
};

export async function sweepStaleOnBoot(deps: SweepDeps): Promise<SweepResult> {
  const { db, log } = deps;
  const stale = await db
    .select({
      payment: payments,
      sellerId: endpoints.sellerId,
      payoutMode: endpoints.payoutMode,
    })
    .from(payments)
    .innerJoin(endpoints, eq(endpoints.id, payments.endpointId))
    .where(
      sql`${payments.state} = 'verified'
        and ${payments.verifiedAt} is not null
        and ${payments.verifiedAt} < now() - make_interval(secs => ${deps.windowSeconds}::int)`,
    )
    .orderBy(sql`${payments.verifiedAt} asc`);

  let abandoned = 0;
  let recovered = 0;
  let unproven = 0;

  for (const { payment, sellerId, payoutMode } of stale) {
    const hash = payment.nearTxHash;
    if (hash === null) {
      if (await moveOrSkip(db, payment.id, "abandoned", log)) {
        abandoned += 1;
      }
      continue;
    }

    let verdict: SettlementVerdict;
    try {
      verdict = await deps.probe(hash);
    } catch (error) {
      // A probe that throws is a probe that did not answer. Leave the row.
      log?.warn(
        { code: "sweep_probe_failed", paymentId: payment.id, hash, error: String(error) },
        "stale payment left verified: chain probe failed",
      );
      verdict = "unknown";
    }

    if (verdict === "unknown") {
      unproven += 1;
      log?.warn(
        { code: "sweep_unproven", paymentId: payment.id, hash },
        "stale payment left verified: settlement not proven on chain",
      );
      continue;
    }

    if (verdict === "failed") {
      if (await moveOrSkip(db, payment.id, "abandoned", log, { nearTxHash: hash })) {
        abandoned += 1;
      }
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        const settled = await advancePayment(tx, payment.id, "settled", {
          nearTxHash: hash,
        });
        await recordSettlement(
          tx,
          {
            sellerId,
            amount: BigInt(settled.amount),
            asset: settled.assetContract,
            paymentId: settled.id,
          },
          payoutMode === "direct" ? "direct" : "intents",
        );
      });
      recovered += 1;
    } catch (error) {
      log?.warn(
        { code: "sweep_settlement_failed", paymentId: payment.id, error: String(error) },
        "stale payment recovery or booking failed",
      );
    }
  }

  return { abandoned, recovered, unproven };
}

/**
 * `advancePayment` is compare-and-set on the state it read, so a row another
 * instance moved while this pass was probing throws instead of being overridden.
 * That is a skip, not a sweep failure: the other writer owns the row's story.
 */
async function moveOrSkip(
  db: Db,
  paymentId: string,
  to: "abandoned",
  log: Logger | undefined,
  fields: { nearTxHash?: string } = {},
): Promise<boolean> {
  try {
    await advancePayment(db, paymentId, to, fields);
    return true;
  } catch (error) {
    log?.warn(
      { code: "sweep_move_failed", paymentId, to, error: String(error) },
      "stale payment was moved by another writer",
    );
    return false;
  }
}
