import { describe, expect, it } from "vitest";

import {
  type EndpointDto,
  endpointDtoSchema,
  endpointUpdateRequestSchema,
} from "@till/core/schemas";

import {
  type EditFormValues,
  buildEditBody,
  changeRows,
  editInitial,
  livenessBody,
} from "../lib/endpoint-edit.ts";

/**
 * F2's edit step (PO-7's UI half): what the dashboard sends to `PATCH
 * /api/endpoints/:id` (D9).
 *
 * Two rules decide this file, and both are about money rather than about form
 * state. The first is D9's: a body carries *only the fields the seller changed*,
 * because `active` in a price patch would open a paywall somebody paused, and a
 * destination in a body nobody confirmed is a payout route to an address no human
 * looked at. The second is the echo: the address `confirmedAddress` vouches for is
 * the one on the screen, read from the endpoint's own route row (D5), never
 * re-derived here.
 *
 * These are pure-function tests — `apps/web` has no browser framework, so the
 * rules live out of the components precisely so they can be run (ARCHITECTURE.md 3).
 */

const INTENTS: EndpointDto = endpointDtoSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  slug: "grain-7f3a",
  gatewayUrl: "https://gateway.test/r/grain-7f3a",
  upstreamUrl: "https://data.seller.test/prices",
  priceAmount: "10000",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "intents",
  active: true,
  description: "Live grain prices",
  route: {
    id: "00000000-0000-4000-8000-000000000003",
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: "old-payout.testnet",
    refundAddress: "old-refund.testnet",
    provider: "mock",
    depositAddress: "mock-deposit-1",
    modeDetail: "standing",
  },
  creationWarnings: [],
});

const ROUTELESS: EndpointDto = endpointDtoSchema.parse({
  ...INTENTS,
  payoutMode: "intents",
  active: false,
  description: null,
  route: null,
  creationWarnings: ["The destination address is not a NEAR account id."],
});

function filled(overrides: Partial<EditFormValues> = {}): EditFormValues {
  return { ...editInitial(INTENTS), ...overrides };
}

describe("editInitial (F2, PO-7)", () => {
  it("prefills the form with the terms the endpoint has now", () => {
    const values = editInitial(INTENTS);
    expect(values.upstreamUrl).toBe("https://data.seller.test/prices");
    // The price as the seller reads it, not as the column stores it.
    expect(values.priceAmount).toBe("0.01");
    expect(values.description).toBe("Live grain prices");
    // The destination comes off the route row, because that is where D5 put it.
    expect(values.destinationAddress).toBe("old-payout.testnet");
    expect(values.refundAddress).toBe("old-refund.testnet");
    expect(values.payoutMode).toBe("intents");
  });

  it("prefills an endpoint with no route with empty destination fields, not empty strings read as values", () => {
    const values = editInitial(ROUTELESS);
    expect(values.destinationAddress).toBe("");
    expect(values.description).toBe("");
  });
});

describe("buildEditBody (D9's contract, from the form)", () => {
  it("sends nothing when the seller changed nothing", () => {
    // Not a `422` from the API for an empty patch, and not a log line for an edit
    // that did not happen: the dashboard does not ask.
    const body = buildEditBody(INTENTS, filled(), { confirmed: false });
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.reason).toBe("nothing-changed");
  });

  it("sends only the price for a price change, in base units", () => {
    const body = buildEditBody(INTENTS, filled({ priceAmount: "2.50" }), { confirmed: false });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.body).toEqual({ priceAmount: "2500000" });
    expect(body.changedFields).toEqual(["priceAmount"]);
  });

  it("never names active, network, assetContract or slug, whatever the form holds", () => {
    // The three fields D9 refuses by name, and the one whose absence from a body is
    // the whole of "an edit does not decide whether the paywall is open".
    const body = buildEditBody(
      INTENTS,
      filled({
        priceAmount: "3.00",
        description: "changed",
        upstreamUrl: "https://other.seller.test/api",
        destinationAddress: "new-payout.testnet",
        refundAddress: "new-refund.testnet",
        destinationChain: "solana",
        destinationAsset: "usdt",
        payoutMode: "direct",
      }),
      { confirmed: true },
    );
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(Object.keys(body.body).sort()).toEqual(
      [
        "confirmedAddress",
        "destinationAddress",
        "destinationAsset",
        "destinationChain",
        "description",
        "payoutMode",
        "priceAmount",
        "refundAddress",
        "upstreamUrl",
      ].sort(),
    );
    expect(endpointUpdateRequestSchema.safeParse(body.body).success).toBe(true);
  });

  it("sends null for a description the seller cleared, and nothing for one they left alone", () => {
    const cleared = buildEditBody(INTENTS, filled({ description: "" }), { confirmed: false });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.body).toEqual({ description: null });

    const untouched = buildEditBody(ROUTELESS, { ...editInitial(ROUTELESS), description: "" });
    expect(untouched.ok).toBe(false);
    if (!untouched.ok) expect(untouched.reason).toBe("nothing-changed");
  });

  it("refuses to send a new destination address the seller has not been shown", () => {
    // The API's `422 destination_not_confirmed` is the backstop; the form's job is to
    // not need it, because a seller who is asked to pay a stranger's address was never
    // told what they were confirming.
    const body = buildEditBody(INTENTS, filled({ destinationAddress: "attacker.testnet" }), {
      confirmed: false,
    });
    expect(body.ok).toBe(false);
    if (body.ok) {
      throw new Error("an unconfirmed address must never produce a body");
    }
    if (body.reason !== "needs-confirmation") {
      throw new Error(`expected a confirmation to be asked for, got ${body.reason}`);
    }
    expect(body.shownAddress).toBe("attacker.testnet");
    expect(body.body).toBeNull();
  });

  it("echoes the typed address when it is confirmed, and never the stored one", () => {
    const body = buildEditBody(INTENTS, filled({ destinationAddress: "new-payout.testnet" }), {
      confirmed: true,
    });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.body).toEqual({
      destinationAddress: "new-payout.testnet",
      confirmedAddress: "new-payout.testnet",
    });
  });

  it("does not ask for a confirmation over a destination the seller did not touch", () => {
    // Only an address that *changes* has to be echoed: refund-only edits land on the
    // destination that is already on the row, so blocking them would be the dashboard
    // inventing a rule the API does not have.
    const body = buildEditBody(INTENTS, filled({ refundAddress: "new-refund.testnet" }), {
      confirmed: false,
    });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.body).toEqual({ refundAddress: "new-refund.testnet" });
    expect("confirmedAddress" in body.body).toBe(false);
  });

  it("lets a route-less endpoint be repaired by typing the destination it never had", () => {
    // D9: a price change alone cannot fix an endpoint whose create got no route. The
    // form has to be able to send the destination for an endpoint that has none, and
    // the echo rule is the same there.
    const values: EditFormValues = {
      ...editInitial(ROUTELESS),
      destinationAddress: "fixed.testnet",
      destinationChain: "near",
      destinationAsset: "usdc",
      refundAddress: "refund.testnet",
    };
    const unconfirmed = buildEditBody(ROUTELESS, values, { confirmed: false });
    expect(unconfirmed.ok).toBe(false);
    if (unconfirmed.ok) return;
    expect(unconfirmed.reason).toBe("needs-confirmation");

    const body = buildEditBody(ROUTELESS, values, { confirmed: true });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.body).toEqual({
      destinationAddress: "fixed.testnet",
      destinationChain: "near",
      destinationAsset: "usdc",
      refundAddress: "refund.testnet",
      confirmedAddress: "fixed.testnet",
    });
  });

  it("reports a price the money converter refuses on the price field, and sends nothing", () => {
    const body = buildEditBody(INTENTS, filled({ priceAmount: "1.2345678" }), {
      confirmed: false,
    });
    expect(body.ok).toBe(false);
    if (body.ok || body.reason !== "invalid") {
      throw new Error("expected the price field to be blamed");
    }
    expect(Object.keys(body.errors)).toEqual(["priceAmount"]);
  });

  it("round-trips a price the seller did not change without putting it in the body", () => {
    // 10000 base units displays as 0.01; if the diff compared the displayed string to
    // the column it would send `priceAmount: "10000"` on every save and turn an edit
    // into a re-confirmation of the whole form.
    const body = buildEditBody(INTENTS, filled({ priceAmount: "0.0100" }), { confirmed: false });
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.reason).toBe("nothing-changed");
  });
  it("refuses an upstream URL the API's own schema would refuse, and says which field", () => {
    // The form does not re-implement Till's rules; it runs the candidate body through
    // the same schema the route will, so a seller is told before a request is made —
    // and never told in words the API did not write.
    const body = buildEditBody(INTENTS, filled({ upstreamUrl: "data.seller.test/prices" }), {
      confirmed: false,
    });
    expect(body.ok).toBe(false);
    if (body.ok || body.reason !== "invalid") {
      throw new Error("expected the upstream URL field to be blamed");
    }
    expect(Object.keys(body.errors)).toEqual(["upstreamUrl"]);
  });
});

describe("changeRows (what the seller confirms)", () => {
  it("shows a price as both numbers, typed and charged", () => {
    const rows = changeRows(INTENTS, filled({ priceAmount: "2.50" }));
    expect(rows).toEqual([
      { label: "Price per call", from: "0.01 of usdc.testnet", to: "2.5 of usdc.testnet" },
    ]);
  });

  it("names the same address the body will echo, from the same form", () => {
    // The confirmation and the echo are one read of one object. If the row said one
    // address and the body vouched for another, the seller would be confirming
    // something Till is not writing.
    const values = filled({ destinationAddress: "new-payout.testnet" });
    const rows = changeRows(INTENTS, values);
    const body = buildEditBody(INTENTS, values, { confirmed: true });
    expect(rows.map((row) => row.to)).toEqual(["new-payout.testnet"]);
    expect(body.ok && body.body.confirmedAddress).toBe(rows[0]?.to);
  });

  it("says (no description) rather than an empty box when the seller clears one", () => {
    const rows = changeRows(INTENTS, filled({ description: "" }));
    expect(rows).toEqual([
      { label: "Description (optional)", from: "Live grain prices", to: "(no description)" },
    ]);
  });

  it("has nothing to confirm when nothing changed", () => {
    expect(changeRows(INTENTS, filled())).toEqual([]);
  });
});

describe("the liveness control (D9's rule, from the button)", () => {
  it("names active and nothing else", () => {
    // The one body in the dashboard allowed to change whether money arrives, kept
    // separate from the edit form so a price save cannot carry it by accident.
    expect(livenessBody(INTENTS)).toEqual({ active: false });
    expect(livenessBody({ ...INTENTS, active: false })).toEqual({ active: true });
    expect(Object.keys(livenessBody(INTENTS))).toEqual(["active"]);
  });
});
