import { createPayerFetch } from "../apps/api/src/x402/near.ts";

/**
 * The buyer side of the demo (C11): call the gateway, read the 402, sign a
 * payment authorization, retry, print the response and the receipt header.
 *
 * Ships no SDK (PRD non-goal): this is one script that behaves like an agent,
 * which is also what proves the 402 body is enough to pay from scratch.
 *
 * Run: `tsx scripts/demo-agent.ts [slug-or-url]`
 *
 * env:
 *   GATEWAY_PUBLIC_URL      base URL of the gateway (default http://127.0.0.1:3000)
 *   DEMO_ENDPOINT_SLUG      endpoint to call (default "demo")
 *   NEAR_NETWORK            near:testnet (default) or near:mainnet
 *   NEAR_RPC_URL            optional RPC override
 *   DEMO_PAYER_ACCOUNT_ID   payer account (A10)
 *   DEMO_PAYER_SECRET_KEY   payer full-access key (A10; never printed)
 *
 * Exit codes: 0 paid and receipted; 2 no payer credentials (the free half is
 * shown); 1 an assertion about what the protocol returned failed.
 */

export const DEMO_AGENT_ENDPOINT_SLUG = "demo";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3000";

type Challenge = {
  readonly x402Version?: unknown;
  readonly accepts?: unknown;
  readonly resource?: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The 402's requirements ride in the `PAYMENT-REQUIRED` header, and the body is
 * only an alternative for humans (`docs/ARCHITECTURE.md` 4.2 step 1). Header
 * first, body second, and `null` when neither carries a non-empty `accepts`
 * array — an agent that guesses at that point would pay the wrong thing.
 */
export function decodeChallenge(header: string | null, body: unknown): Challenge | null {
  const fromHeader = header === null ? undefined : decodeBase64Json(header);
  const candidate = asObject(fromHeader) ?? asObject(body) ?? null;
  if (candidate === null) {
    return null;
  }
  if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) {
    return null;
  }
  return candidate as Challenge;
}

function requirementLines(accepts: readonly unknown[]): readonly string[] {
  const first = asObject(accepts[0]);
  if (first === null) {
    return ["  (accepts[0] is not an object)"];
  }
  const fields = ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"] as const;
  return fields.map((field) => `  ${field.padEnd(19)}${String(first[field] ?? "(missing)")}`);
}

function receiptOf(response: Response): unknown {
  const header =
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  return header === null ? undefined : decodeBase64Json(header);
}

function clipped(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 500 ? flat : `${flat.slice(0, 500)}…`;
}

async function main(argv: readonly string[]): Promise<number> {
  const gatewayUrl = (process.env.GATEWAY_PUBLIC_URL ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
  const target = argv[0] ?? process.env.DEMO_ENDPOINT_SLUG ?? DEMO_AGENT_ENDPOINT_SLUG;
  const url = target.startsWith("http") ? target : `${gatewayUrl}/r/${target}`;
  const network = process.env.NEAR_NETWORK ?? "near:testnet";

  console.log(`agent   -> ${url}`);

  const unpaid = await fetch(url, { headers: { accept: "application/json" } });
  if (unpaid.status === 200) {
    console.error("assertion failed: the endpoint served without a payment");
    return 1;
  }
  if (unpaid.status !== 402) {
    const text = await unpaid.text();
    console.error(`assertion failed: expected 402, got ${unpaid.status}: ${clipped(text)}`);
    return 1;
  }

  const challenge = decodeChallenge(
    unpaid.headers.get("payment-required"),
    await unpaid.json().catch(() => undefined),
  );
  if (challenge === null) {
    console.error("assertion failed: 402 carried no decodable PAYMENT-REQUIRED requirements");
    return 1;
  }
  const accepts = challenge.accepts as readonly unknown[];
  console.log(
    `challenge x402Version=${String(challenge.x402Version ?? "(missing)")} accepts=${accepts.length}`,
  );
  for (const line of requirementLines(accepts)) {
    console.log(line);
  }
  if (accepts.length !== 1) {
    console.log("  note: more than one requirement advertised; a wallet may choose another one");
  }

  const accountId = process.env.DEMO_PAYER_ACCOUNT_ID ?? "";
  const secretKey = process.env.DEMO_PAYER_SECRET_KEY ?? "";
  if (accountId === "" || secretKey === "") {
    console.log("");
    console.log("no payer credentials: set DEMO_PAYER_ACCOUNT_ID and DEMO_PAYER_SECRET_KEY.");
    console.log("The 402 above is the free half, verified end to end; the paid half needs");
    console.log("A10's funded testnet payer and relayer (AGENTS.md: no funded key without it).");
    return 2;
  }

  console.log(`payer   ${accountId} on ${network}`);
  const payFetch = createPayerFetch({
    accountId,
    secretKey,
    network,
    ...(process.env.NEAR_RPC_URL === undefined ? {} : { rpcUrl: process.env.NEAR_RPC_URL }),
  });

  let response: Response;
  try {
    response = await payFetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    console.error(`paid call failed before an answer: ${clipped(String(error))}`);
    console.error(
      "A10: the payer account must exist on the network and hold the endpoint's token.",
    );
    return 1;
  }

  console.log(`response ${response.status}`);
  const receipt = asObject(receiptOf(response));
  const receiptHeader = receipt === null ? "(missing)" : JSON.stringify(receipt);
  console.log(`receipt  ${receiptHeader}`);

  if (!response.ok) {
    console.error(
      `assertion failed: the paid call answered ${response.status}: ${clipped(await response.text())}`,
    );
    return 1;
  }
  const transaction = receipt?.transaction;
  if (receipt === null || receipt.success !== true || typeof transaction !== "string") {
    console.error(
      "assertion failed: a served response must carry a successful PAYMENT-RESPONSE receipt",
    );
    return 1;
  }
  console.log(`settled  ${transaction}`);
  console.log(`body     ${clipped(await response.text())}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
