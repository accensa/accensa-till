import type { PaymentDto } from "@till/core/schemas";
import { paymentDtoSchema } from "@till/core/schemas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PaymentTable } from "../components/domain/PaymentTable.tsx";
import { SELF_PAYMENT_NOTE } from "../lib/payments.ts";

/**
 * The payments table (UI-3, F3), rendered and read as text, the same way
 * `render.test.tsx` reads the endpoint screens. What is pinned is what a seller
 * would be misled about: which row links to a chain, which one does not and says
 * so, which amount is a test rather than income, and that a price stored in base
 * units reaches them in decimal.
 */
function payment(overrides: Partial<PaymentDto> = {}): PaymentDto {
  return paymentDtoSchema.parse({
    id: "01a1abe0-0672-7000-aab8-eb0edda04ae4",
    endpointId: "01a1abe0-0000-7000-8000-000000000001",
    routeId: null,
    payerAccountId: "buyer.testnet",
    amount: "1250000",
    assetContract: "usdc.testnet",
    network: "near:testnet",
    state: "settled",
    nearTxHash: "6pNcG8euAfQqojLvz3odjqzyqJ4Ffc9qXM11SeapFLYu",
    upstreamStatus: 200,
    upstreamMs: 42,
    verifiedAt: "2026-11-05T10:00:00.000Z",
    settledAt: "2026-11-05T10:00:04.000Z",
    selfPayment: false,
    ...overrides,
  });
}

function markupFor(payments: readonly PaymentDto[]): string {
  return renderToStaticMarkup(<PaymentTable payments={payments} />);
}

describe("the payments table (UI-3, F3)", () => {
  it("says there are no payments rather than showing an empty table", () => {
    expect(markupFor([])).toMatch(/No payments yet/);
    expect(markupFor([])).not.toContain("<table");
  });

  it("links a settled payment to its transaction on the chain the row names", () => {
    const markup = markupFor([payment()]);
    expect(markup).toContain(
      'href="https://testnet.nearblocks.io/txns/6pNcG8euAfQqojLvz3odjqzyqJ4Ffc9qXM11SeapFLYu"',
    );
    expect(markup).toContain("NearBlocks");
    // A dashboard link that can open a second tab without `noopener` hands the
    // explorer a handle on the dashboard window.
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it("puts a mainnet hash on the mainnet explorer, because a testnet URL would 404", () => {
    expect(markupFor([payment({ network: "near:mainnet" })])).toContain(
      'href="https://nearblocks.io/txns/6pNcG8euAfQqojLvz3odjqzyqJ4Ffc9qXM11SeapFLYu"',
    );
  });

  it("says a payment that never reached a chain has no transaction", () => {
    const markup = markupFor([payment({ state: "verified", nearTxHash: null, settledAt: null })]);
    expect(markup).toMatch(/no transaction yet/);
    expect(markup).not.toContain('href="https://testnet.nearblocks.io');
  });

  it("names a hash it cannot link instead of printing a bare code", () => {
    const markup = markupFor([payment({ network: "eip155:84532" })]);
    expect(markup).toMatch(/no NearBlocks link for eip155:84532/);
    expect(markup).not.toContain("<a ");
  });

  it("shows the amount in decimal units, not the base units the ledger stores", () => {
    const markup = markupFor([payment()]);
    expect(markup).toContain("1.25");
    expect(markup).not.toContain("1250000");
    expect(markup).toContain("usdc.testnet");
  });

  it("flags the seller's own payment as a test rather than revenue", () => {
    const markup = markupFor([payment({ payerAccountId: "self.testnet", selfPayment: true })]);
    expect(markup).toContain(SELF_PAYMENT_NOTE);
  });

  it("words each state the machine can hold, and does not hide a served-not-settled one", () => {
    const markup = markupFor([
      payment({
        state: "served_unsettled",
        settledAt: null,
        id: "01a1abe0-0000-7000-8000-000000000002",
      }),
      payment({
        state: "abandoned",
        settledAt: null,
        nearTxHash: null,
        id: "01a1abe0-0000-7000-8000-000000000003",
      }),
    ]);
    expect(markup).toMatch(/Served without settling/);
    expect(markup).toMatch(/nothing was settled/);
    expect(markup).toMatch(/Paid for, not served yet|Verified and given up on/);
  });
});
