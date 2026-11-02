/**
 * Timer loop helper (D6). Claims work with `for update skip locked` so two loops
 * — two processes, or a tick that outlived its interval — never touch the same
 * swap, applies backoff on provider errors, and treats a tick that is still
 * running as a skip rather than a queue.
 *
 * One process, one Postgres (AGENTS.md hard rule 10): no queue library here.
 */
export type LoopSpec = {
  readonly name: string;
  readonly seconds: number;
  readonly run: (signal: AbortSignal) => Promise<void>;
};

export function startLoop(_spec: LoopSpec): () => void {
  throw new Error("not implemented (D6)");
}
