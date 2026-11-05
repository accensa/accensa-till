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
    return <p className="text-sm opacity-70">{NO_PAYMENTS_COPY}</p>;
  }

  const words = paymentStateWords();

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left opacity-70">
            <th className="py-1 pr-4 font-medium">Paid at</th>
            <th className="py-1 pr-4 font-medium">Payer</th>
            <th className="py-1 pr-4 font-medium">Amount</th>
            <th className="py-1 pr-4 font-medium">State</th>
            <th className="py-1 font-medium">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr className="border-t" key={payment.id}>
              <td className="py-2 pr-4 align-top">{displayDate(payment.verifiedAt)}</td>
              <td className="py-2 pr-4 align-top">
                <code>{payment.payerAccountId}</code>
                {payment.selfPayment ? (
                  <p className="mt-1 text-amber-700">{SELF_PAYMENT_NOTE}</p>
                ) : null}
              </td>
              <td className="py-2 pr-4 align-top">
                {displayAmount(payment.amount)}{" "}
                <span className="opacity-70">{payment.assetContract}</span>
              </td>
              <td className="py-2 pr-4 align-top">
                <span className={STATE_CLASS[payment.state]}>{words[payment.state]}</span>
                {payment.settledAt === null ? null : (
                  <p className="opacity-60">settled {displayDate(payment.settledAt)}</p>
                )}
              </td>
              <td className="py-2 align-top">
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
  settled: "text-green-700",
  verified: "text-sky-700",
  abandoned: "text-red-700",
  served_unsettled: "text-red-700",
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
      <a className="underline" href={link} rel="noreferrer noopener" target="_blank">
        {EXPLORER_LABEL}
      </a>
    );
  }
  if (nearTxHash === null || nearTxHash === "") {
    return <span className="opacity-60">no transaction yet</span>;
  }
  return (
    <span className="opacity-60">
      <code>{nearTxHash}</code> — no {EXPLORER_LABEL} link for {network}
    </span>
  );
}
