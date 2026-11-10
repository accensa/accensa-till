import {
  type PayoutPollDto,
  type RelayerBalanceDto,
  type StatusDto,
  type StatusResponse,
  statusResponseSchema,
} from "@till/core/schemas";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeaderStatus } from "../components/domain/HeaderStatus.tsx";
import { api } from "../lib/api-client.ts";
import { type HeaderLine, headerView } from "../lib/header-status.ts";

/**
 * The header (UI-5, F5), tested as the two things it is made of: the decision
 * function that turns Till's facts into the sentence a seller reads, and the
 * markup that sentence ends up in.
 *
 * There is no browser framework in this repository and adding one is a human
 * dependency decision, so what is asserted here is the rendered text — which is
 * exactly the surface UI-5's Done-when is about. A warning that exists in the
 * data and not on the screen does not warn anybody, and a warning the screen
 * invents sends a seller to fix a relayer that is fine. The two states the whole
 * task turns on, `low` and `unknown`, must therefore read differently, and each
 * of the branches below is the only thing standing between one of them and a
 * reassuring number.
 */

const ONE_NEAR = "1000000000000000000000000";

/**
 * A balance override with the two branded decimal-string fields written as plain
 * strings, so a case can be spelled `amount: "0"` and still reach the header as a
 * parsed DTO: `status` below runs the real contract over it rather than a cast.
 */
type BalanceOverride = Partial<Omit<RelayerBalanceDto, "amount" | "alertBelow">> & {
  amount?: string | null;
  alertBelow?: string;
};

type StatusOverride = {
  readonly relayer?: BalanceOverride;
  readonly payouts?: Partial<PayoutPollDto>;
};

function status(over: StatusOverride = {}): StatusDto {
  return statusResponseSchema.parse({
    status: {
      relayer: {
        accountId: "relayer.testnet",
        network: "near:testnet",
        state: "ok",
        amount: "1500000000000000000000000",
        alertBelow: ONE_NEAR,
        ...over.relayer,
      },
      payouts: {
        provider: "mock",
        state: "polled",
        swaps: 3,
        lastPolledAt: "2026-11-05T10:00:00.000Z",
        ageSeconds: 12,
        staleAfterSeconds: 100,
        ...over.payouts,
      },
    },
  }).status;
}

function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function linesOf(result: Parameters<typeof headerView>[0]): readonly HeaderLine[] {
  return headerView(result).lines;
}

const OK_RESULT = { kind: "ok", status: status() } as const;

describe("the relayer balance line (UI-5)", () => {
  it("states a healthy balance in the units a seller reads, with the threshold beside it", () => {
    const line = headerView(OK_RESULT).lines[0];
    expect(line?.text).toContain("1.5 NEAR");
    // Not a constant: the number the operator configured is what the sentence names.
    expect(line?.text).toContain("1 NEAR");
    expect(line?.tone).toBe("ok");
  });

  it("warns below the configured threshold, and only below it", () => {
    const at = headerView({
      kind: "ok",
      status: status({ relayer: { amount: ONE_NEAR } }),
    }).lines[0];
    expect(at?.tone).toBe("ok");

    const justUnder = headerView({
      kind: "ok",
      status: status({ relayer: { amount: "999999999999999999999999" } }),
    }).lines[0];
    expect(justUnder?.tone).toBe("warn");
    expect(justUnder?.text).toMatch(/^Warning:/);
  });

  it("compares balances that a float cannot tell apart", () => {
    // Both of these round to the same `Number`, so a float comparison would call the
    // second one healthy and hide the warning UI-5 exists to show.
    const above = headerView({
      kind: "ok",
      status: status({ relayer: { amount: "1000000000000000000000001", alertBelow: ONE_NEAR } }),
    }).lines[0];
    const below = headerView({
      kind: "ok",
      status: status({ relayer: { amount: "999999999999999999999999", alertBelow: ONE_NEAR } }),
    }).lines[0];
    expect([above?.tone, below?.tone]).toEqual(["ok", "warn"]);
  });

  it("names the configured threshold in the warning, not a guessed one", () => {
    const line = headerView({
      kind: "ok",
      status: status({
        relayer: { amount: "1500000000000000000000000", alertBelow: "2500000000000000000000000" },
      }),
    }).lines[0];
    expect(line?.tone).toBe("warn");
    expect(line?.text).toContain("2.5 NEAR");
    expect(line?.text).not.toContain("alerts below 1 NEAR");
  });

  it("says a zero balance is zero, and does not warn about a number it never got", () => {
    const line = headerView({
      kind: "ok",
      status: status({ relayer: { amount: "0" } }),
    }).lines[0];
    expect(line?.tone).toBe("warn");
    expect(line?.text).toContain("0 NEAR");
  });

  it("renders an unreadable balance as unknown, with no number in the sentence", () => {
    // The shape this refuses: `state: "unreadable"` came back from a balance field
    // that had to hold something, and the only something available was 0.
    const line = headerView({
      kind: "ok",
      status: status({ relayer: { state: "unreadable", amount: null } }),
    }).lines[0];
    expect(line?.tone).toBe("unknown");
    expect(line?.text).toMatch(/unknown/i);
    expect(line?.text).not.toMatch(/\d+ NEAR/);
    expect(line?.text).not.toMatch(/Warning:/);
  });

  it("treats a relayer account that is not on the network as a warning", () => {
    // Not an unknown: the header knows something is wrong, and a relayer that is
    // not there cannot sponsor gas at all.
    const line = headerView({
      kind: "ok",
      status: status({ relayer: { state: "account_missing", amount: null } }),
    }).lines[0];
    expect(line?.tone).toBe("warn");
    expect(line?.text).toContain("relayer.testnet");
    expect(line?.text).toContain("near:testnet");
    expect(line?.text).not.toMatch(/\d+ NEAR/);
  });
});

describe("the provider poll line (UI-5)", () => {
  it("states a fresh answer against the derived window", () => {
    const line = headerView(OK_RESULT).lines[1];
    expect(line?.tone).toBe("ok");
    expect(line?.text).toContain("12 seconds ago");
    // 100 s, humanised — the window the API derived, not one guessed here.
    expect(line?.text).toContain("1 minute");
  });

  it("names the window it was given, not a window of its own", () => {
    // The balance line has the same rule and the same reason for it: the interval
    // comes from `POLL_INTERVAL_SECONDS`, and a header that hardcoded a five-minute
    // silence would stop being true the moment an operator retuned the poll loop.
    const line = headerView({
      kind: "ok",
      status: status({ payouts: { ageSeconds: 12, staleAfterSeconds: 900 } }),
    }).lines[1];
    expect(line?.text).toContain("15 minutes");
    expect(line?.text).not.toContain("1 minute");
  });

  it("warns past the window, and not at exactly the window", () => {
    const at = headerView({
      kind: "ok",
      status: status({ payouts: { ageSeconds: 100 } }),
    }).lines[1];
    expect(at?.tone).toBe("ok");

    const past = headerView({
      kind: "ok",
      status: status({ payouts: { ageSeconds: 101 } }),
    }).lines[1];
    expect(past?.tone).toBe("warn");
    expect(past?.text).toMatch(/^Warning:/);
  });

  it("separates 'no payouts tracked yet' from 'never polled'", () => {
    const none = headerView({
      kind: "ok",
      status: status({
        payouts: { state: "no_swaps", swaps: 0, lastPolledAt: null, ageSeconds: null },
      }),
    }).lines[1];
    const never = headerView({
      kind: "ok",
      status: status({
        payouts: { state: "never_polled", swaps: 2, lastPolledAt: null, ageSeconds: null },
      }),
    }).lines[1];
    expect(none?.tone).toBe("ok");
    expect(none?.text).toContain("No payouts tracked yet");
    expect(never?.tone).toBe("warn");
    expect(never?.text).toContain("never");
    // Two swaps, and the sentence says two: the count is what makes the difference
    // between "you have nothing" and "nobody has answered about the two you have".
    expect(never?.text).toContain("2");
  });

  it("ages an answer in the unit a seller reads", () => {
    const minutes = headerView({
      kind: "ok",
      status: status({ payouts: { ageSeconds: 240 } }),
    }).lines[1];
    const hours = headerView({
      kind: "ok",
      status: status({ payouts: { ageSeconds: 7_500 } }),
    }).lines[1];
    expect(minutes?.text).toContain("4 minutes ago");
    expect(hours?.text).toContain("2 hours ago");
    expect(hours?.tone).toBe("warn");
  });

  it("states an unknown rather than a fresh answer when a polled swap has no time", () => {
    // Core refuses this payload over HTTP — `polled` has to carry an answer time —
    // so it is built here instead of parsed: the type allows it, `StatusDto` is what
    // the function is handed, and the age alone cannot be shown as fresh because
    // "how stale" is the question and "since when" is the only evidence for it.
    const polled = status();
    const line = headerView({
      kind: "ok",
      status: { ...polled, payouts: { ...polled.payouts, lastPolledAt: null } },
    }).lines[1];
    expect(line?.tone).toBe("unknown");
    expect(line?.text).toContain("no answer time");
  });
});

describe("the alert the header raises (UI-5's Done-when)", () => {
  it("is raised by a low balance alone", () => {
    const view = headerView({
      kind: "ok",
      status: status({ relayer: { amount: "500000000000000000000" } }),
    });
    expect(view.alert).toBe(true);
  });

  it("is raised by a stale poll alone", () => {
    const view = headerView({
      kind: "ok",
      status: status({ payouts: { ageSeconds: 900 } }),
    });
    expect(view.alert).toBe(true);
  });

  it("is not raised when both halves are healthy", () => {
    expect(headerView(OK_RESULT).alert).toBe(false);
  });

  it("is not raised by a balance it could not read", () => {
    // Deliberate: `unreadable` is Till's problem and the tone says so. A red warning
    // would send the seller to top up a relayer that may be full.
    expect(
      headerView({
        kind: "ok",
        status: status({ relayer: { state: "unreadable", amount: null } }),
      }).alert,
    ).toBe(false);
  });
});

describe("the header without a session or without an answer", () => {
  it("sends a signed-out seller to sign in and says nothing about balances", () => {
    // The sign-in screen shares this layout, so the header must neither fail nor
    // invent a number for a seller Till does not know yet.
    const view = headerView({ kind: "signed_out" });
    expect(view.alert).toBe(false);
    const text = view.lines.map((line) => line.text).join(" ");
    expect(text).toMatch(/sign in/i);
    expect(text).not.toMatch(/NEAR/);
    expect(text).not.toMatch(/Warning:/);
  });

  it("quotes why Till could not be reached, without warning about a threshold", () => {
    const view = headerView({ kind: "unreachable", detail: "/api/status returned 500" });
    expect(view.alert).toBe(false);
    expect(view.lines[0]?.tone).toBe("unknown");
    expect(view.lines[0]?.text).toContain("/api/status returned 500");
    expect(view.lines.map((line) => line.text).join(" ")).not.toMatch(/Warning:/);
  });
});

describe("the rendered header (UI-5)", () => {
  it("shows both facts in the header text a seller reads", () => {
    const markup = words(renderToStaticMarkup(<HeaderStatus result={OK_RESULT} />));
    expect(markup).toContain("1.5 NEAR");
    expect(markup).toContain("12 seconds ago");
    expect(markup).not.toContain("Warning:");
  });

  it("puts the low-balance warning where a seller sees it, marked as an alert", () => {
    const markup = renderToStaticMarkup(
      <HeaderStatus
        result={{
          kind: "ok",
          status: status({ relayer: { amount: "500000000000000000000" } }),
        }}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(words(markup)).toContain("Warning:");
    expect(words(markup)).toContain("0.0005 NEAR");
  });

  it("marks a stale poll as an alert too, and says how old the answer is", () => {
    const markup = renderToStaticMarkup(
      <HeaderStatus result={{ kind: "ok", status: status({ payouts: { ageSeconds: 900 } }) }} />,
    );
    expect(markup).toContain('role="alert"');
    expect(words(markup)).toContain("15 minutes ago");
  });

  it("renders an unknown balance differently from a low one", () => {
    const unknown = renderToStaticMarkup(
      <HeaderStatus
        result={{ kind: "ok", status: status({ relayer: { state: "unreadable", amount: null } }) }}
      />,
    );
    const low = renderToStaticMarkup(
      <HeaderStatus
        result={{
          kind: "ok",
          status: status({ relayer: { amount: "500000000000000000000" } }),
        }}
      />,
    );
    expect(words(unknown)).toMatch(/unknown/i);
    expect(words(unknown)).not.toMatch(/NEAR/);
    expect(unknown).not.toContain('role="alert"');
    expect(low).toContain('role="alert"');
  });

  it("renders nothing alarming with no session", () => {
    const markup = renderToStaticMarkup(<HeaderStatus result={{ kind: "signed_out" }} />);
    expect(markup).not.toContain('role="alert"');
    expect(words(markup)).not.toMatch(/Warning:|NEAR/);
    expect(words(markup)).toMatch(/sign in/i);
  });
});

describe("the header's read (UI-5)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stub(body: unknown, status = 200): RequestInit[] {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    return seen;
  }

  const RESPONSE: StatusResponse = statusResponseSchema.parse({
    status: {
      relayer: {
        accountId: "relayer.testnet",
        network: "near:testnet",
        state: "ok",
        amount: "500000000000000000000",
        alertBelow: ONE_NEAR,
      },
      payouts: {
        provider: "mock",
        state: "never_polled",
        swaps: 1,
        lastPolledAt: null,
        ageSeconds: null,
        staleAfterSeconds: 100,
      },
    },
  });

  it("reads /api/status with the page's session cookie", async () => {
    const seen = stub(RESPONSE);
    const result = await api.status("till_session=token-value");
    expect(seen[0]?.headers).toBeDefined();
    expect(new Headers(seen[0]?.headers as HeadersInit).get("cookie")).toBe(
      "till_session=token-value",
    );
    if (result.kind !== "ok") {
      throw new Error("unreachable: the API answered in shape");
    }
    expect(result.status.relayer.amount).toBe("500000000000000000000");
  });

  it("turns a 401 into 'signed out', which the header must not paint as a warning", async () => {
    stub({ code: "unauthenticated", message: "Sign in to read Till's own status." }, 401);
    expect(await api.status()).toEqual({ kind: "signed_out" });
  });

  it("turns a body its own schema refuses into 'unreachable', not into a zero", async () => {
    // The API's own contract says a balance read that succeeded carries a number. A
    // half-written answer must become "we do not know", never a default.
    stub({
      status: {
        relayer: { accountId: "relayer.testnet", network: "near:testnet", state: "ok" },
        payouts: RESPONSE.status.payouts,
      },
    });
    const result = await api.status();
    expect(result.kind).toBe("unreachable");
  });

  it("turns a fetch failure into 'unreachable' with the reason", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const result = await api.status();
    expect(result.kind).toBe("unreachable");
    if (result.kind === "unreachable") {
      expect(result.detail).toContain("ECONNREFUSED");
    }
  });
});
