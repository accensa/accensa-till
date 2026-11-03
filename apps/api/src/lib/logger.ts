/**
 * Structured stdout logging with a request id (A4, 11.1). Nothing swallows an
 * error silently: services throw typed errors and routes log them with the
 * request id they arrived on.
 *
 * Redaction is not cosmetic — RELAYER_SECRET_KEY, ONECLICK_JWT and
 * SESSION_SECRET must never reach a log line, including inside a dumped env
 * object. Two layers do that: one matches the field's name, one matches shapes
 * that are credentials wherever they turn up (G6 F3).
 */

const REDACTED_KEYS = [
  "relayer_secret_key",
  "oneclick_jwt",
  "session_secret",
  "authorization",
  "cookie",
  "database_url",
  "password",
  "secret",
  "token",
  // G6 F3: the list above only ever matched names the config file happens to
  // use. A key called `api_key`, `private_key` or `mnemonic` printed whole, and
  // any of them would be a credential.
  "api_key",
  "private_key",
  "access_key",
  "jwt",
  "mnemonic",
  "seed_phrase",
  "passphrase",
  "signature",
];

const REDACTION = "[redacted]";

/**
 * A secret that travels inside a value under an innocent key (G6 F3):
 * `url: "postgres://till:pw@db.internal"` is a field nobody would call secret,
 * and the credential-shaped text inside it is the thing that must not be readable.
 * This is not a scanner that proves a value harmless — nothing can — it only
 * recognises the shapes that are credentials wherever they appear.
 */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // scheme://user:password@host — the password goes, the host stays so the line
  // is still useful for debugging.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^\s@/]+)@/gi, `$1:${REDACTION}@`],
  [/(\b(?:bearer|basic)\s+)([^\s,]+)/gi, `$1${REDACTION}`],
  // A NEAR full access key and a JWT are recognisable by their own shape.
  [/\bed25519:[0-9A-Za-z]+/g, REDACTION],
  [/\beyJ[0-9A-Za-z_-]{5,}\.[0-9A-Za-z_-]{5,}\.[0-9A-Za-z_-]{5,}\b/g, REDACTION],
];

function isRedactedKey(key: string): boolean {
  // `apiKey` and `api_key` are the same name to a matcher, so the case boundary
  // becomes a separator before the needles are compared.
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_");
  return REDACTED_KEYS.some((needle) => normalized.includes(needle));
}

function redactValue(value: string): string {
  let output = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value === "string") {
    return redactValue(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    output[key] = isRedactedKey(key) ? REDACTION : redact(inner);
  }
  return output;
}

/** Typed entry point: the top level is always a field map, so `emit` can spread it. */
function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = isRedactedKey(key) ? REDACTION : redact(value);
  }
  return output;
}

export type Logger = {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  child(extra: Record<string, unknown>): Logger;
};

function emit(level: "info" | "warn" | "error", fields: Record<string, unknown>, message?: string) {
  // The message is the one field an error text lands in, and an error text is how
  // a driver URL reaches a log line, so it gets the value patterns too.
  const line = {
    level,
    time: new Date().toISOString(),
    message: message === undefined ? undefined : redactValue(message),
    ...redactFields(fields),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  return {
    info: (fields, message) => emit("info", { ...base, ...fields }, message),
    warn: (fields, message) => emit("warn", { ...base, ...fields }, message),
    error: (fields, message) => emit("error", { ...base, ...fields }, message),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

/** GW-4 and the ledger both need a per-request id; mint it at the edge. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
