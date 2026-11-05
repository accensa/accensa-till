import { describe, expect, it } from "vitest";

import { PAYMENT_STATES } from "@till/core/states";

import {
  EXPLORER_LABEL,
  NO_PAYMENTS_COPY,
  SELF_PAYMENT_NOTE,
  paymentStateWords,
  paymentTxLink,
} from "../lib/payments.ts";

/**
 * The rules behind UI-3's table (F3), tested as functions. A row's link and a
 * row's word are the two things here that can be wrong without anyone noticing,
 * so they are named.
 */

describe("a link to the transaction, or none (UI-3)", () => {
  it("links a settled payment on testnet to the testnet explorer", () => {
    expect(paymentTxLink("near:testnet", "6pNcG8euAfQq")).toBe(
      "https://testnet.nearblocks.io/txns/6pNcG8euAfQq",
    );
  });

  it("links a mainnet payment to mainnet, because a testnet URL would 404 on a real hash", () => {
    expect(paymentTxLink("near:mainnet", "GVhGh1wyqsHw")).toBe(
      "https://nearblocks.io/txns/GVhGh1wyqsHw",
    );
  });

  it("names no explorer for a network Till does not know", () => {
    // The alternative is to guess a URL for a chain the row only claims to be on,
    // and a wrong explorer link is worse than no link: it reads as evidence.
    for (const network of ["eip155:84532", "", "testnet", "near:"]) {
      expect([network, paymentTxLink(network, "abc123")]).toEqual([network, null]);
    }
  });

  it("names no link when nothing has been written on chain yet", () => {
    // `verified` and `abandoned` rows carry no hash by design, and the UI-3
    // Done-when is a link on the rows that have a transaction.
    for (const hash of [null, ""]) {
      expect(paymentTxLink("near:testnet", hash)).toBeNull();
    }
  });

  it("escapes nothing, because a hash is not text a seller typed", () => {
    // The value comes from the chain through the API's own schema; the link is
    // built by concatenation and nothing here quotes or trims it into place.
    expect(paymentTxLink("near:testnet", "a/b?c=d")).toBe(
      "https://testnet.nearblocks.io/txns/a/b?c=d",
    );
  });

  it("labels the explorer it linked, so a click is not a surprise", () => {
    expect(EXPLORER_LABEL).toBe("NearBlocks");
  });
});

describe("what each state means to the seller (UI-3)", () => {
  it("has a word for every state the machine can hold, and none invented", () => {
    const words = paymentStateWords();
    expect(Object.keys(words).sort()).toEqual([...PAYMENT_STATES].sort());
    for (const state of PAYMENT_STATES) {
      expect(words[state]?.length).toBeGreaterThan(0);
    }
  });

  it("keeps a served-but-unsettled payment named as the fault it is", () => {
    // This is the state the payer bought an answer Till did not pay for; a bland
    // word in the table would be the dashboard hiding a discrepancy (E3's rule).
    // Both halves have to be in the word: the buyer was served and the money did
    // not arrive. A table that said only "served" would hide the loss.
    expect(paymentStateWords().served_unsettled).toMatch(/served/i);
    expect(paymentStateWords().served_unsettled).toMatch(/without settling|not settled/i);
    expect(paymentStateWords().abandoned).toMatch(/nothing was settled/i);
    expect(paymentStateWords().settled).toMatch(/settled/i);
  });

  it("says why a self-payment is not revenue", () => {
    expect(SELF_PAYMENT_NOTE).toMatch(/your own wallet/i);
    expect(SELF_PAYMENT_NOTE).toMatch(/not revenue|revenue/i);
  });

  it("says there is nothing yet, rather than that something failed", () => {
    expect(NO_PAYMENTS_COPY).toMatch(/no payments/i);
  });
});
