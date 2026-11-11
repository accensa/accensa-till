import type { PaymentDto } from "@till/core/schemas";

import { displayAmount, displayDate } from "../../lib/format.ts";
import {
  EXPLORER_LABEL,
  NO_PAYMENTS_COPY,
  SELF_PAYMENT_NOTE,
  paymentStateWords,
  paymentTxLink,
} from "../../lib/payments.ts";

/**
 * The seller's payments (UI-3, F3): one row per payment, each saying what state
 * Till recorded, who paid, how much, and where the transaction is — or that there
 * is no transaction to point at yet.
 *
 * The rows are read-only by construction: this file takes `PaymentDto[]` and calls
 * no fetch. A payment is moved by the gateway's sequence and the state machine,
 * never by the dashboard (hard rule 4), so there is no button here to add.
 */
export type PaymentTableProps = { readonly payments: readonly PaymentDto[] };

export function PaymentTable({ payments }: PaymentTableProps) {
  if (payments.length === 0) {
    return (
      <div className="panel flex flex-col gap-3 p-8">
        <span className="chip chip-muted w-fit">Empty ledger</span>
        <p className="max-w-xl text-sm leading-6 text-muted">{NO_PAYMENTS_COPY}</p>
      </div>
    );
  }

  const words = paymentStateWords();

  return (
    <div className="panel overflow-x-auto">
      <div className="panel-head">
        <span className="eyebrow">Payment ledger</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          {payments.length} record{payments.length === 1 ? "" : "s"}
        </span>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Paid at</th>
            <th>Payer</th>
            <th>Amount</th>
            <th>State</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr className="border-t border-line" key={payment.id}>
              <td className="whitespace-nowrap font-mono text-[11px] text-muted">
                {displayDate(payment.verifiedAt)}
              </td>
              <td>
                <code className="text-[12px] text-bone">{payment.payerAccountId}</code>
                {payment.selfPayment ? (
                  <p className="mt-1.5 max-w-52 font-mono text-[10px] uppercase leading-4 tracking-[0.08em] text-amber">
                    {SELF_PAYMENT_NOTE}
                  </p>
                ) : null}
              </td>
              <td className="whitespace-nowrap font-mono tabular-nums">
                <span className="text-bone">{displayAmount(payment.amount)}</span>{" "}
                <span className="text-faint">{payment.assetContract}</span>
              </td>
              <td>
                <span className={`inline-flex items-start gap-2 ${STATE_CLASS[payment.state]}`}>
                  <span
                    aria-hidden
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 ${STATE_DOT[payment.state]}`}
                  />
                  <span className="text-[13px] leading-5">{words[payment.state]}</span>
                </span>
                {payment.settledAt === null ? null : (
                  <p className="mt-1 pl-3.5 font-mono text-[10px] text-faint">
                    settled {displayDate(payment.settledAt)}
                  </p>
                )}
              </td>
              <td>
                <TransactionLink network={payment.network} nearTxHash={payment.nearTxHash} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATE_CLASS: Readonly<Record<PaymentDto["state"], string>> = {
  settled: "text-mint",
  verified: "text-amber",
  abandoned: "text-danger",
  served_unsettled: "text-danger",
};

const STATE_DOT: Readonly<Record<PaymentDto["state"], string>> = {
  settled: "bg-mint",
  verified: "bg-amber",
  abandoned: "bg-danger",
  served_unsettled: "bg-danger",
};

/**
 * A row with no hash is a payment that never reached a chain, and the table says
 * so rather than printing an empty cell that reads as a broken link. A hash on a
 * network Till has no explorer for is named as that too (see `paymentTxLink`).
 */
function TransactionLink({
  network,
  nearTxHash,
}: {
  readonly network: string;
  readonly nearTxHash: string | null;
}) {
  const link = paymentTxLink(network, nearTxHash);
  if (link !== null) {
    return (
      <a
        className="link inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.08em]"
        href={link}
        rel="noreferrer noopener"
        target="_blank"
      >
        {EXPLORER_LABEL}
        <span aria-hidden>↗</span>
      </a>
    );
  }
  if (nearTxHash === null || nearTxHash === "") {
    return <span className="font-mono text-[11px] text-faint">— no transaction yet</span>;
  }
  return (
    <span className="font-mono text-[10px] leading-4 text-faint">
      <code className="break-all text-muted">{nearTxHash}</code>
      <span className="mt-1 block">
        — no {EXPLORER_LABEL} link for {network}
      </span>
    </span>
  );
}
