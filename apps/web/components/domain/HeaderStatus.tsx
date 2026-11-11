import type { StatusResult } from "../../lib/api-client.ts";
import { type HeaderLine, headerView } from "../../lib/header-status.ts";

/**
 * The status block in the header (UI-5, F5): the relayer balance and the last
 * successful provider poll, each stated with the threshold it is judged against.
 *
 * A server component with nothing to hydrate, so the warning is in the first paint
 * and a seller with JavaScript off still reads it. All of the wording and every
 * comparison live in `headerView`, which is what lets the sentences be asserted
 * without a browser: this file's only job is to mark which line is an alert.
 *
 * `role="alert"` goes on a warned line and on nothing else. An unknown is Till's own
 * outage rather than a fact the seller must act on, and announcing it as an alert is
 * how an RPC hiccup becomes a fire alarm.
 */
export type HeaderStatusProps = {
  readonly result: StatusResult;
};

const TONE_CLASS: Readonly<Record<HeaderLine["tone"], string>> = {
  ok: "text-muted",
  warn: "text-amber font-medium",
  unknown: "text-faint",
};

const DOT_CLASS: Readonly<Record<HeaderLine["tone"], string>> = {
  ok: "bg-mint",
  warn: "bg-amber",
  unknown: "bg-faint",
};

export function HeaderStatus({ result }: HeaderStatusProps) {
  const { lines } = headerView(result);
  return (
    <>
      {lines.map((line) => (
        <span
          className={`inline-flex items-center gap-2 text-[11px] leading-5 ${TONE_CLASS[line.tone]}`}
          key={line.text}
          role={line.tone === "warn" ? "alert" : undefined}
        >
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 ${DOT_CLASS[line.tone]}`} />
          {line.text}
        </span>
      ))}
    </>
  );
}
