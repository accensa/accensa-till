import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Tiny upstream API for the demo (C11). Serves a fixed JSON body, and can be
 * told to answer 500, hang, or redirect so GW-3 behaviour is shown rather than
 * described:
 *
 *   GET /data   200 with the payload a buyer pays for
 *   GET /fail   500 with a fake seller error page (the gateway answers 502)
 *   GET /slow   never answers, so UPSTREAM_TIMEOUT_MS decides
 *   GET /moved  302 with a *relative* Location (the gateway makes it absolute)
 *
 * localhost only. `resolveUpstreamTarget` refuses a loopback address for every
 * seller, whatever `ALLOW_INSECURE_UPSTREAM` says (C5: that knob relaxes http
 * versus https, never the address rule), so the demo reaches this server through
 * the gateway's `upstream` seam instead — see `scripts/demo.ts`.
 */

export const DEMO_UPSTREAM_PORT = 4100;
export const DEMO_UPSTREAM_PATHS = ["/data", "/fail", "/slow", "/moved"] as const;

const PAYLOAD = JSON.stringify({ ok: true, resource: "demo-data", value: 42 });

export type DemoUpstream = {
  readonly url: string;
  readonly port: number;
  /** Requests received so far, by path — the demo asserts what was dialled. */
  readonly hits: () => Readonly<Record<string, number>>;
  close(): Promise<void>;
};

export type DemoUpstreamOptions = {
  readonly port?: number;
  readonly host?: string;
};

function countHits(counts: Map<string, number>, path: string): void {
  counts.set(path, (counts.get(path) ?? 0) + 1);
}

function send(res: ServerResponse, status: number, body: string, headers?: Record<string, string>) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // The gateway strips the seller's headers it does not allow; this one is a
    // normal representation header and is expected to survive.
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

/**
 * Starts the upstream and resolves once it is listening. The caller owns
 * `close()`, and `close()` also destroys the hanging `/slow` responses so a
 * demo process cannot refuse to exit.
 */
export async function startDemoUpstream(options: DemoUpstreamOptions = {}): Promise<DemoUpstream> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEMO_UPSTREAM_PORT;
  const counts = new Map<string, number>();
  const hanging = new Set<ServerResponse>();

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    countHits(counts, path);
    if (req.method !== "GET") {
      send(res, 405, JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    switch (path) {
      case "/data":
        send(res, 200, PAYLOAD);
        return;
      case "/fail":
        // Deliberately carries a "stack trace"-looking line: a 5xx must be
        // replaced by the gateway, never forwarded to the buyer.
        send(res, 500, JSON.stringify({ error: "upstream_failed", detail: "at demo.ts:42" }));
        return;
      case "/moved":
        send(res, 302, "", { location: "/data" });
        return;
      case "/slow":
        // Never responds. The socket closes when `close()` runs or the client
        // gives up; either way nothing is served.
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
        return;
      default:
        send(res, 404, JSON.stringify({ error: "not_found" }));
    }
  };

  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    hits: () => {
      const snapshot: Record<string, number> = {};
      for (const [path, count] of counts) {
        snapshot[path] = count;
      }
      return snapshot;
    },
    close: async () => {
      for (const res of hanging) {
        res.destroy();
      }
      hanging.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function main(): Promise<void> {
  const upstream = await startDemoUpstream();
  console.log(`demo upstream on ${upstream.url}`);
  console.log(`  paths: ${DEMO_UPSTREAM_PATHS.join(", ")}`);
  console.log("  point an endpoint's upstream_url at one of them; Ctrl-C stops it");
  const stop = async (): Promise<void> => {
    await upstream.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
