/**
 * Structured stdout logging with a request id (A4, 11.1). Nothing swallows an
 * error silently: services throw typed errors and routes log them with the
 * request id they arrived on.
 *
 * Redaction is not cosmetic — RELAYER_SECRET_KEY, ONECLICK_JWT and
 * SESSION_SECRET must never reach a log line, including inside a dumped env
 * object.
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
];

const REDACTION = "[redacted]";

function isRedactedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return REDACTED_KEYS.some((needle) => normalized.includes(needle));
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
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
  const line = { level, time: new Date().toISOString(), message, ...redactFields(fields) };
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
