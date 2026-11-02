/**
 * The buyer side of the demo (C11): call the gateway, read the 402, sign a
 * payment authorization, retry, print the response and the receipt header.
 *
 * Ships no SDK (PRD non-goal): this is one script that behaves like an agent,
 * which is also what proves the 402 body is enough to pay from scratch.
 */
export const DEMO_AGENT_ENDPOINT_SLUG = "demo";
