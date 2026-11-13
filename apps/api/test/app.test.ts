import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { createDb } from "../src/db/client.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * A21 acceptance: the app answers without a process.
 *
 * Before the split these assertions needed `serve()` on a port, because
 * `server.ts` built the Hono app at import time. That is a boot test, and it is
 * why every route task after this one had no way to be tested at all. What is
 * pinned here is the middleware and the two health paths — and the fact that a
 * test can now hand the app a recording logger and an env of its own choosing,
 * which is the shape the F and C phase routes will plug into.
 */

const required = {
  DATABASE_URL: "postgres://till:till@localhost:5432/till",
  SESSION_SECRET: "x".repeat(32),
  GATEWAY_PUBLIC_URL: "http://localhost:3000",
};

function envWith(overrides: Record<string, string> = {}): Env {
  return loadEnv({ ...process.env, ...required, ...overrides });
}

type Recorded = { readonly logger: Logger; readonly lines: Record<string, unknown>[] };

function recordingLogger(): Recorded {
  const lines: Record<string, unknown>[] = [];
  const record = (level: string) => (fields: Record<string, unknown>) => {
    lines.push({ level, ...fields });
  };
  const logger: Logger = {
    info: vi.fn(record("info")) as Logger["info"],
    warn: vi.fn(record("warn")) as Logger["warn"],
    error: vi.fn(record("error")) as Logger["error"],
    child: () => logger,
  };
  return { logger, lines };
}

type Built = {
  readonly app: ReturnType<typeof createApp>;
  readonly lines: Record<string, unknown>[];
};

function appFor(overrides: Record<string, string> = {}): Built {
  const { logger, lines } = recordingLogger();
  return {
    app: createApp({
      env: envWith(overrides),
      log: logger,
      // C4 made these required, and these tests never reach either: they assert the
      // health paths and the request middleware. An address that cannot resolve is
      // the honest value to hand in — `postgres()` connects lazily, so nothing opens
      // a socket unless a route queries, and if one ever does it will fail loudly
      // rather than quietly reading a real database. The gateway's own suite
      // (`test/gateway.test.ts`) runs against `DATABASE_URL` for exactly that reason.
      db: createDb("postgres://till:till@unresolved.invalid/till"),
      // No relayer, so `configured` is false: the health route does not ask, and a
      // test that wanted a payment would have to bring the chain, which is A10.
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
    }),
    lines,
  };
}

describe("the app boots without a process (A21)", () => {
  it("answers /healthz with the network from the env it was given", async () => {
    const { app } = appFor();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, network: "near:testnet" });
  });

  it("answers the /api path the browser actually uses", async () => {
    // A5 rewrites apps/web's `/api/*` onto this process, so a handler mounted
    // only at `/healthz` was unreachable from the dashboard. Both paths, one
    // handler, and the body identical.
    const { app } = appFor();
    const direct = await app.request("/healthz");
    const rewritten = await app.request("/api/healthz");
    expect([direct.status, rewritten.status]).toEqual([200, 200]);
    expect(await rewritten.json()).toEqual(await direct.json());
  });

  it("reads the network from the injected env, not from a constant", async () => {
    const { app } = appFor({ NEAR_NETWORK: "near:localnet" });
    const response = await app.request("/healthz");
    expect(await response.json()).toEqual({ ok: true, network: "near:localnet" });
  });

  it("404s a path nobody mounted, and logs that too", async () => {
    const { app, lines } = appFor();
    // Deliberately not one of the dashboard's own paths: `/api/payments` was this
    // test's example until F3 mounted it, and a route that arrives later must not
    // be able to satisfy "unmounted" by accident.
    const response = await app.request("/api/nothing-is-here-yet");
    expect(response.status).toBe(404);
    expect(lines.length).toBe(1);
    expect(lines[0]?.status).toBe(404);
  });
});

describe("the request middleware (A21)", () => {
  it("logs exactly one line per request, with the id it set and the status it returned", async () => {
    const { app, lines } = appFor();
    await app.request("/healthz");
    expect(lines.length).toBe(1);
    const line = lines[0] as Record<string, unknown>;
    expect(typeof line.requestId).toBe("string");
    expect([line.method, line.path, line.level]).toEqual(["GET", "/healthz", "info"]);
  });

  it("gives each request its own id, and a plausible uuid shape", async () => {
    const { app, lines } = appFor();
    await app.request("/healthz");
    await app.request("/api/healthz");
    const ids = lines.map((line) => line.requestId);
    expect(new Set(ids).size).toBe(2);
    // A correlation id, not a row id: `newRequestId` stays v4 on purpose (A20).
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("refuses a dashboard body over the ceiling instead of parsing it", async () => {
    // G7: before this, every `/api` handler called `c.req.json()` on whatever the
    // client sent. A 200 MB body was read into memory, and an OOM restart also
    // resets the in-memory sponsored-gas budget (limits.ts), so an anonymous
    // request could reach the money cap through the availability path.
    const { app } = appFor();
    const response = await app.request("/api/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(200_000) },
      body: JSON.stringify({ pad: "x".repeat(200_000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
  });

  it("refuses a state-changing dashboard request from another origin", async () => {
    // G7: SameSite=Strict already stops the cookie travelling, but `PATCH
    // /api/endpoints/:id` can move a payout address, so the origin is checked as
    // its own rule rather than only as a side effect of the cookie policy.
    const { app, lines } = appFor();
    const response = await app.request("/api/auth/nonce", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "origin_refused" });
    expect(lines.some((line) => line.code === "origin_refused")).toBe(true);
  });

  it("accepts the dashboard's own origin, and a browserless client with none", async () => {
    const { app } = appFor();
    const own = await app.request("/api/auth/nonce", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    const none = await app.request("/api/auth/nonce", { method: "POST" });
    expect([own.status, none.status]).toEqual([200, 200]);
  });

  it("mounts both halves of the dashboard ledger, refusing without a session", async () => {
    // F15: `/api/swaps` used to be an unmounted stub, so this 401 (rather than a
    // 404) is the mount itself. Neither route reads the database on this path, so
    // the assertion holds with the unreachable handle `appFor` hands in.
    const { app } = appFor();
    const payments = await app.request("/api/payments");
    const swaps = await app.request("/api/swaps");
    expect([payments.status, swaps.status]).toEqual([401, 401]);
    expect(await swaps.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("sends nosniff on every answer, which the CSV export needs most", async () => {
    // G7: the ledger export is `text/csv`, the one content type a browser might
    // otherwise sniff into something executable.
    const { app } = appFor();
    const health = await app.request("/healthz");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("measures the request's own duration, not the process's uptime", async () => {
    // A4's bug, found by booting the thing: the log printed
    // `performance.now()/1000`, which is time since process start, so a request
    // after a slow start reported the whole of it as its own latency. Made
    // deterministic rather than left to timing: the process is deliberately aged
    // past one second first, so the uptime reading this test refuses is over 1 by
    // construction instead of by luck.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const { app, lines } = appFor();
    await app.request("/healthz");
    const seconds = Number(lines[0]?.seconds);
    expect([Number.isFinite(seconds), seconds < 1]).toEqual([true, true]);
  });
});
