import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import LandingPage from "../app/(marketing)/page.tsx";

/**
 * The landing page is the only screen a visitor sees before signing in, so its job is
 * explanation rather than data: the paid-call order, the custody answer, the testnet
 * limit and the FAQ all have to survive a render. There is no browser here, so this
 * proves the copy is present and the FAQ is real `<details>` markup, not that it
 * expands on a click.
 */
describe("the landing page", () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  it("leads with what the product does and how to enter the console", () => {
    expect(markup).toContain("Charge agents");
    expect(markup).toContain("Prove every payout.");
    expect(markup).toContain("Connect a NEAR wallet");
    expect(markup).toContain('href="/sign-in"');
  });

  it("states the paid-call order the gateway enforces", () => {
    for (const step of ["Verify", "Guards", "Upstream", "Settle"]) {
      expect(markup).toContain(step);
    }
    expect(markup).toContain("Only a 2xx from your upstream is allowed to settle");
  });

  it("answers the questions a buyer asks before trusting it with money", () => {
    expect(markup).toContain("Does Till hold my money?");
    expect(markup).toContain("Which networks and assets work today?");
    expect(markup).toContain("Is this production-ready?");
    expect(markup).toContain("How do I sign in, and where do my keys live?");
    expect(markup).toContain("It is a hackathon build, not an audited payment system.");
  });

  it("renders the FAQ as accessible disclosure elements", () => {
    const details = markup.match(/<details/g) ?? [];
    expect(details.length).toBe(8);
    const summaries = markup.match(/<summary/g) ?? [];
    expect(summaries.length).toBe(8);
  });
});
