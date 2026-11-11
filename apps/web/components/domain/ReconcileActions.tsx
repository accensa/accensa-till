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
    <p aria-live="polite" className="notice-danger">
      <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-danger">
        Refused /
      </span>
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
      <div className="panel flex flex-col gap-2 p-6">
        <span className="chip chip-live w-fit">Clear</span>
        <p className="text-sm leading-6 text-muted">{NO_DISCREPANCY_COPY}</p>
      </div>
    ) : (
      <div className="space-y-3">
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
    <div className="space-y-12">
      {notice === null ? null : <ActionNotice message={notice} />}

      <section aria-label="Open items">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
          <h2 className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-bone">
            <span aria-hidden className="h-px w-5 bg-acid" />
            Open items
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Severity, then age
          </span>
        </div>
        {worklist}
      </section>

      <section aria-label="Payers you are holding">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
          <h2 className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-bone">
            <span aria-hidden className="h-px w-5 bg-acid" />
            Payers you are holding
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Gateway predicate, read back
          </span>
        </div>
        {held}
      </section>
    </div>
  );
}
