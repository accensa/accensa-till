import { describe, expect, it } from "vitest";

import { type SubmissionPayload, validateSubmissionPayload } from "../hackathon.ts";

const VALID_PAYLOAD: SubmissionPayload = {
  requestId: "01a1abe0-1111-7000-8000-000000000001",
  projectName: "Till",
  leadName: "Ademola",
  email: "ademola2993k@gmail.com",
  size: "1",
  tracks: ["agents", "realworld", "defi"],
  nearAddress: "till-seller-dev.testnet",
  projectUrl: "https://github.com/wagmiiii/accensa-till",
  demoUrl: "https://x.com/wagmiiii/status/1234567890123456789",
  idea: "Till is an automated seller-side gateway and ledger that turns any GET API into a high-speed x402 paywall on NEAR, settles payments with zero relayer drain, routes cross-chain payouts through NEAR Intents, and reconciles every payment against every payout.",
  consent: true,
};

describe("hackathon submission validation (H6, HACKATHON.md)", () => {
  it("validates a compliant submission payload successfully", () => {
    const res = validateSubmissionPayload(VALID_PAYLOAD);
    expect(res.valid).toBe(true);
    expect(res.payload?.projectName).toBe("Till");
    expect(res.byteLength).toBeGreaterThan(0);
    expect(res.byteLength).toBeLessThan(12000);
  });

  it("rejects non-UUID requestId", () => {
    const res = validateSubmissionPayload({ ...VALID_PAYLOAD, requestId: "not-a-uuid" });
    expect(res.valid).toBe(false);
    expect(res.errors?.some((e: string) => e.includes("requestId"))).toBe(true);
  });

  it("rejects invalid team size", () => {
    const res = validateSubmissionPayload({ ...VALID_PAYLOAD, size: "solo" });
    expect(res.valid).toBe(false);
    expect(res.errors?.some((e: string) => e.includes("size"))).toBe(true);
  });

  it("rejects invalid or duplicate tracks", () => {
    const invalidTrack = validateSubmissionPayload({
      ...VALID_PAYLOAD,
      tracks: ["unknown-track"],
    });
    expect(invalidTrack.valid).toBe(false);

    const duplicateTracks = validateSubmissionPayload({
      ...VALID_PAYLOAD,
      tracks: ["agents", "agents"],
    });
    expect(duplicateTracks.valid).toBe(false);
    expect(duplicateTracks.errors?.some((e: string) => e.includes("duplicates"))).toBe(true);
  });

  it("rejects uppercase or invalid NEAR addresses", () => {
    const res = validateSubmissionPayload({
      ...VALID_PAYLOAD,
      nearAddress: "Seller.NEAR",
    });
    expect(res.valid).toBe(false);
  });

  it("rejects when website spam-trap field is provided", () => {
    const res = validateSubmissionPayload({
      ...VALID_PAYLOAD,
      website: "https://till.example.com",
    });
    expect(res.valid).toBe(false);
    expect(res.errors?.some((e: string) => e.includes("spam trap"))).toBe(true);
  });

  it("rejects when consent is false", () => {
    const res = validateSubmissionPayload({
      ...VALID_PAYLOAD,
      consent: false,
    });
    expect(res.valid).toBe(false);
    expect(res.errors?.some((e: string) => e.includes("consent"))).toBe(true);
  });

  it("rejects description shorter than 20 characters", () => {
    const res = validateSubmissionPayload({
      ...VALID_PAYLOAD,
      idea: "Too short",
    });
    expect(res.valid).toBe(false);
    expect(res.errors?.some((e: string) => e.includes("idea"))).toBe(true);
  });
});
