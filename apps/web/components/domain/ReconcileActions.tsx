"use client";

import { useState } from "react";

import {
  type DiscrepancyListResult,
  type PayerBlockListResult,
  api,
} from "../../lib/api-client.ts";
import { NO_DISCREPANCY_COPY } from "../../lib/reconcile.ts";
import { DiscrepancyCard } from "./DiscrepancyCard.tsx";
import { PayerBlockTable } from "./PayerBlockTable.tsx";
import { SessionNotice } from "./SessionNotice.tsx";

/**
 * The reconciliation screen (UI-4, F4): what needs looking at, and the two actions a
 * seller can take about it.
 *
 * The lists arrive from the server render, so the page says something with JavaScript
 * off; the actions run from here, and each of them redraws from the read that follows
 * it rather than from what the button hoped. `api.resolveDiscrepancy` and
 * `api.clearPayerBlock` are called with no cookie because the session cookie is
 * `HttpOnly` — the browser puts it on a same-origin request by itself, which is the
 * only way this screen can ask as the seller it is signed in as.
 *
 * The order of the cards is the API's (severity, then age, both from core's
 * `SEVERITIES`); nothing here sorts.
 */

export type ReconcileActionsProps = {
  readonly listed: DiscrepancyListResult;
  readonly blocked: PayerBlockListResult;
  /** The server's read time, carried in as a number so the age is one clock, not two. */
  readonly nowMs: number;
};

/**
 * What an action answered when it did not work, in Till's words rather than this
 * file's. Announced politely: the list it refers to is still on screen and unchanged,
 * and a seller who pressed a button that failed should not lose their place.
 */
export function ActionNotice({ message }: { readonly message: string }) {
  return (
    <p aria-live="polite" className="mt-2 text-sm text-red-700">
      {message}
    </p>
  );
}

export function ReconcileActions({ listed, blocked, nowMs }: ReconcileActionsProps) {
  const [items, setItems] = useState<DiscrepancyListResult>(listed);
  const [holds, setHolds] = useState<PayerBlockListResult>(blocked);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyPayer, setBusyPayer] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function resolve(discrepancyId: string): Promise<void> {
    setBusyId(discrepancyId);
    setNotice(null);
    try {
      const closed = await api.resolveDiscrepancy(discrepancyId);
      // A close that failed leaves the worklist exactly as it was: the item is still
      // open, and redrawing it from a guess would be the screen marking its own homework.
      if (closed.kind === "resolved") {
        setItems(await api.discrepancies());
      } else {
        setNotice(closed.kind === "rejected" ? closed.error.message : closed.detail);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function clear(payerAccountId: string): Promise<void> {
    setBusyPayer(payerAccountId);
    setNotice(null);
    try {
      const cleared = await api.clearPayerBlock(payerAccountId);
      if (cleared.kind === "cleared") {
        setHolds({ kind: "ok", payerBlocks: cleared.payerBlocks });
      } else {
        setNotice(cleared.kind === "rejected" ? cleared.error.message : cleared.detail);
      }
    } finally {
      setBusyPayer(null);
    }
  }

  if (items.kind === "signed_out") {
    return (
      <div>
        <SessionNotice kind="session-refused" />
      </div>
    );
  }

  const worklist =
    items.kind === "unreachable" ? (
      <SessionNotice detail={items.detail} kind="unreachable" />
    ) : items.discrepancies.length === 0 ? (
      <p className="text-sm opacity-70">{NO_DISCREPANCY_COPY}</p>
    ) : (
      <div className="mt-4 space-y-4">
        {items.discrepancies.map((discrepancy) => (
          <DiscrepancyCard
            busy={busyId === discrepancy.id}
            discrepancy={discrepancy}
            key={discrepancy.id}
            nowMs={nowMs}
            onResolve={(id) => {
              void resolve(id);
            }}
          />
        ))}
      </div>
    );

  const held =
    holds.kind === "signed_out" ? (
      <SessionNotice kind="session-refused" />
    ) : holds.kind === "unreachable" ? (
      <SessionNotice detail={holds.detail} kind="unreachable" />
    ) : (
      <PayerBlockTable
        busyPayer={busyPayer}
        onClear={(payer) => {
          void clear(payer);
        }}
        payerBlocks={holds.payerBlocks}
      />
    );

  return (
    <div className="space-y-8">
      {notice === null ? null : <ActionNotice message={notice} />}

      <section aria-label="Open items">
        <h2 className="text-lg font-semibold">Open items</h2>
        {worklist}
      </section>

      <section aria-label="Payers you are holding">
        <h2 className="text-lg font-semibold">Payers you are holding</h2>
        {held}
      </section>
    </div>
  );
}
