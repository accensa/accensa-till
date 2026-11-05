import type { DiscrepancyDto, PayerBlockDto } from "@till/core/schemas";
import { discrepancyDtoSchema, payerBlockDtoSchema } from "@till/core/schemas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiscrepancyCard } from "../components/domain/DiscrepancyCard.tsx";
import { PayerBlockTable } from "../components/domain/PayerBlockTable.tsx";
import { ActionNotice, ReconcileActions } from "../components/domain/ReconcileActions.tsx";
import {
  HELD_PAYER_EXPLAINED,
  NO_BLOCKED_PAYER_COPY,
  NO_DISCREPANCY_COPY,
  severityWords,
} from "../lib/reconcile.ts";

/**
 * The reconciliation screen (UI-4, F4), rendered with `react-dom/server` and read as
 * the text a seller sees — the same approach as the payments table, because apps/web
 * has no browser test framework. What is pinned here is what a seller would be
 * misled about: that a worklist is complete, whose words the explanation is, in what
 * order the items sit, and that a button that is mid-flight cannot be pressed twice.
 */

const NOW = Date.parse("2026-11-05T12:00:00.000Z");

function item(overrides: Partial<DiscrepancyDto> = {}): DiscrepancyDto {
  return discrepancyDtoSchema.parse({
    id: "01a1abe0-1111-7000-8000-000000000001",
    sellerId: "01a1abe0-2222-7000-8000-000000000002",
    code: "SERVED_NOT_SETTLED",
    severity: "critical",
    paymentId: "01a1abe0-3333-7000-8000-000000000003",
    swapId: null,
    dedupeKey: "SERVED_NOT_SETTLED:01a1abe0-3333-7000-8000-000000000003:none",
    explanation: "A payer was served and the money never settled.",
    suggestedAction: "Refund the payer or settle the payment by hand.",
    openedAt: "2026-11-05T09:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    ...overrides,
  });
}

function held(overrides: Partial<PayerBlockDto> = {}): PayerBlockDto {
  return payerBlockDtoSchema.parse({
    payerAccountId: "payer.testnet",
    strikes: 2,
    blocked: true,
    lastStrikeAt: "2026-11-05T11:30:00.000Z",
    ...overrides,
  });
}

const noop = (): void => {};

describe("one open item (DiscrepancyCard)", () => {
  it("shows the finding's own words, not a summary of them", () => {
    const discrepancy = item();
    const markup = renderToStaticMarkup(
      <DiscrepancyCard discrepancy={discrepancy} nowMs={NOW} onResolve={noop} />,
    );

    expect(markup).toContain(discrepancy.explanation);
    expect(markup).toContain(discrepancy.suggestedAction);
    expect(markup).toContain(discrepancy.code);
    expect(markup).toContain(severityWords().critical);
    expect(markup).toContain("3 h old");
  });

  it("labels the subject it points at, so the seller knows which payment to open", () => {
    const markup = renderToStaticMarkup(
      <DiscrepancyCard discrepancy={item()} nowMs={NOW} onResolve={noop} />,
    );
    expect(markup).toContain("01a1abe0-3333-7000-8000-000000000003");

    const noPayment = renderToStaticMarkup(
      <DiscrepancyCard
        discrepancy={item({ paymentId: null, code: "PAYOUT_STUCK" })}
        nowMs={NOW}
        onResolve={noop}
      />,
    );
    // A finding with no payment is named as that, rather than as an empty cell.
    expect(noPayment).not.toContain("01a1abe0-3333-7000-8000-000000000003");
    expect(noPayment).toContain("No payment named");
  });

  it("cannot be resolved twice while the first close is in flight", () => {
    const idle = renderToStaticMarkup(
      <DiscrepancyCard discrepancy={item()} nowMs={NOW} onResolve={noop} />,
    );
    expect(idle).toContain("Resolve");
    expect(idle).not.toContain('disabled=""');

    const busy = renderToStaticMarkup(
      <DiscrepancyCard busy discrepancy={item()} nowMs={NOW} onResolve={noop} />,
    );
    expect(busy).toContain('disabled=""');
    expect(busy).toContain("Closing");
  });
});

describe("the payers this seller is holding (PayerBlockTable)", () => {
  it("names each payer, how many strikes count and when the last one was", () => {
    const markup = renderToStaticMarkup(
      <PayerBlockTable
        busyPayer={null}
        onClear={noop}
        payerBlocks={[held(), held({ payerAccountId: "other.testnet" })]}
      />,
    );
    expect(markup).toContain("payer.testnet");
    expect(markup).toContain("other.testnet");
    expect(markup).toContain("2 unpaid serves");
    expect(markup.match(/<button/g)?.length).toBe(2);
    expect(markup).toContain(HELD_PAYER_EXPLAINED);
  });

  it("disables the row that is being cleared and leaves the others usable", () => {
    const markup = renderToStaticMarkup(
      <PayerBlockTable
        busyPayer="payer.testnet"
        onClear={noop}
        payerBlocks={[held(), held({ payerAccountId: "other.testnet" })]}
      />,
    );
    const rows = markup.split("<tr").filter((row) => row.includes("Clear"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('disabled=""');
    expect(rows[1]).not.toContain('disabled=""');
  });

  it("says no payer is held, which is the good news and not a fault", () => {
    const markup = renderToStaticMarkup(
      <PayerBlockTable busyPayer={null} onClear={noop} payerBlocks={[]} />,
    );
    expect(markup).toContain(NO_BLOCKED_PAYER_COPY);
    expect(markup).not.toContain("<button");
  });

  it("keeps a hold whose last strike the read did not name", () => {
    const markup = renderToStaticMarkup(
      <PayerBlockTable
        busyPayer={null}
        onClear={noop}
        payerBlocks={[held({ lastStrikeAt: null })]}
      />,
    );
    expect(markup).toContain("payer.testnet");
    expect(markup).toContain("—");
  });

  it("offers no clear for a payer the read says is not held", () => {
    // The list is the gateway's own predicate, so a released payer should not reach
    // this table — but `blocked` is on the row for exactly this check, and a button
    // that clears nothing would be the screen claiming an action it cannot take.
    const markup = renderToStaticMarkup(
      <PayerBlockTable busyPayer={null} onClear={noop} payerBlocks={[held({ blocked: false })]} />,
    );
    expect(markup).toContain("already released");
    expect(markup).not.toContain("<button");
  });
});

describe("the reconciliation screen (ReconcileActions)", () => {
  const ok = (discrepancies: readonly DiscrepancyDto[]) => ({ kind: "ok", discrepancies }) as const;
  const blocks = (payerBlocks: readonly PayerBlockDto[]) => ({ kind: "ok", payerBlocks }) as const;

  it("renders one card per item, in the order the API answered", () => {
    const words = severityWords();
    const items = [
      item({ severity: "critical" }),
      item({ severity: "high" }),
      item({ severity: "low" }),
    ];
    const markup = renderToStaticMarkup(
      <ReconcileActions blocked={blocks([])} listed={ok(items)} nowMs={NOW} />,
    );

    expect(markup.match(/<article/g)?.length).toBe(3);
    // The order is the API's (severity first, then age, both from `severityRank`);
    // a page that sorted again could put `low` above `critical` and nobody would
    // notice, so what is pinned is that the badges come out in the order given.
    const positions = [words.critical, words.high, words.low].map((word) => markup.indexOf(word));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("says nothing needs reconciling when the worklist came back empty", () => {
    const markup = renderToStaticMarkup(
      <ReconcileActions blocked={blocks([held()])} listed={ok([])} nowMs={NOW} />,
    );
    expect(markup).toContain(NO_DISCREPANCY_COPY);
    expect(markup).not.toContain("<article");
    // The empty worklist does not empty the hold table with it.
    expect(markup).toContain("payer.testnet");
  });

  it("shows the API's own sentence for a worklist it could not read, and no cards", () => {
    const refusal = {
      kind: "unreachable",
      detail: "A discrepancy on record is not one Till can read, so none are shown.",
    } as const;
    const markup = renderToStaticMarkup(
      <ReconcileActions blocked={blocks([])} listed={refusal} nowMs={NOW} />,
    );
    expect(markup).toContain(refusal.detail);
    expect(markup).not.toContain(NO_DISCREPANCY_COPY);
    expect(markup).not.toContain("<article");
  });

  it("sends a signed-out seller to sign in rather than showing an empty screen", () => {
    const markup = renderToStaticMarkup(
      <ReconcileActions
        blocked={{ kind: "signed_out" }}
        listed={{ kind: "signed_out" }}
        nowMs={NOW}
      />,
    );
    expect(markup).toContain("/sign-in");
    expect(markup).not.toContain("<article");
    expect(markup).not.toContain(NO_DISCREPANCY_COPY);
  });

  it("keeps a hold list it cannot read as a fault, not as no holds", () => {
    const markup = renderToStaticMarkup(
      <ReconcileActions
        blocked={{
          kind: "unreachable",
          detail: "A blocked payer on record is not one Till can read.",
        }}
        listed={ok([item()])}
        nowMs={NOW}
      />,
    );
    expect(markup).toContain("A blocked payer on record is not one Till can read.");
    expect(markup).not.toContain(NO_BLOCKED_PAYER_COPY);
    expect(markup.match(/<article/g)?.length).toBe(1);
  });

  it("announces a refusal in the seller's own words, taken from the answer", () => {
    const markup = renderToStaticMarkup(
      <ActionNotice message="That is not one of your open discrepancies." />,
    );
    expect(markup).toContain("That is not one of your open discrepancies.");
    expect(markup).toContain('aria-live="polite"');
  });
});
