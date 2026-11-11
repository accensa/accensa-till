/**
 * The three sentences a dashboard read can end on that are not a list (UI-2, F1):
 * no session to ask with, a session Till will not accept, and no answer from the
 * API at all.
 *
 * They live together because they are easy to confuse and must not be. "No
 * endpoints yet" is a fact about the seller; a session that expired and an API that
 * is down are facts about Till, and drawing either as an empty list would be the
 * dashboard telling a seller they have nothing when it does not know.
 */
export type SessionNoticeKind = "no-session" | "session-refused" | "unreachable";

export type SessionNoticeProps = {
  readonly kind: SessionNoticeKind;
  /** With `unreachable`: what the read failed on, quoted as the client reported it. */
  readonly detail?: string;
};

export function SessionNotice({ kind, detail }: SessionNoticeProps) {
  if (kind === "unreachable") {
    return (
      <div className="panel flex flex-col gap-2 border-l-2 border-l-danger p-6 sm:flex-row sm:items-start sm:gap-5">
        <span className="chip chip-danger w-fit">Read failed</span>
        <p className="text-sm leading-6 text-bone">
          Till is not answering, so this page cannot say what you have. Nothing was changed.
          {detail === undefined ? null : (
            <span className="mt-1 block font-mono text-[11px] text-muted">{detail}</span>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="panel flex flex-col gap-2 border-l-2 border-l-acid p-6 sm:flex-row sm:items-start sm:gap-5">
      <span className="chip chip-muted w-fit">
        {kind === "no-session" ? "No session" : "Session refused"}
      </span>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        {kind === "no-session"
          ? "Till will not list or save an endpoint without a session."
          : "That session is no longer one Till accepts — it expired, or it was issued by a different install."}{" "}
        <a className="link text-bone" href="/sign-in">
          {kind === "no-session" ? "Sign in with your NEAR wallet" : "Sign in again"}
        </a>
        .
      </p>
    </div>
  );
}
