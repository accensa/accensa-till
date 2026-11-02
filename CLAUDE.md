# CLAUDE.md

@AGENTS.md

The shared rules above apply to every agent. This file adds only what is specific to Claude Code.

## Context discipline

- Do not import `docs/ARCHITECTURE.md` or `docs/PRD.md` with `@`. They are long. Read them on demand with a targeted look at the section you need (for example the requirement table row, or section 4 of the architecture for the paid-call lifecycle).
- At the start of a task, read the progress block and your phase section of `ROADMAP.md`, then `docs/ARCHITECTURE_ESSENTIALS.md`. Do not load the whole roadmap; read section 1 (update protocol) once per session and the tasks you need.
- Prefer searching and reading specific files over loading whole directories.

## Plan before editing

Use plan mode, or write a short plan and wait for approval, before changing any of these:

- `apps/api/src/gateway/` (guards, proxy, SSRF, route)
- `apps/api/src/services/ledger.ts` and `apps/api/src/db/schema.ts`
- `packages/core/src/reconcile/`
- Anything that moves, signs or settles money

A plan names the `ROADMAP.md` task ID, the requirement ID, the files to touch, the tests to add and any rule from `AGENTS.md` that is nearby. For other work, go straight to implementation.

## Delegation

- Use a subagent for open-ended research into third-party behavior (1Click API, FastNear packages, NEP-366). Ask it to return findings with sources and a confidence level, and write the result to `docs/spikes/Sx.md` yourself.
- Do the edits to code in the main session, so the diff and the tests stay in one place.

## Verification loop

- After each change, run the narrowest check first (the single test file), then the full set from the definition of done in `AGENTS.md` before declaring completion.
- If a check fails, show the failing output and fix the cause. Do not weaken or delete a test to get green.
- `pnpm roadmap:check` is part of the full set. A failing roadmap check means the work is not done.
- Do not run `pnpm demo` with `PAYOUT_PROVIDER=oneclick` or on `near:mainnet` unless the human asked for it in the current session.

## Roadmap upkeep

The rule in `AGENTS.md` applies to you on every turn that changes the repository: update `ROADMAP.md` in the same change. Practical steps for Claude Code:

1. Before editing code, note the task ID you are working on and set it `[~]` if it is not already.
2. Make the code change and run its checks.
3. Then edit `ROADMAP.md`: status, `Evidence:`, requirement matrix row, spike or decision entries if affected, and a changelog line.
4. Run `pnpm roadmap` and then `pnpm roadmap:check`.
5. Mention the changed task IDs in your final message.

Do not defer the roadmap edit to a later session. If you run out of room, leave the task `[~]` and write what remains on its line.

## Files you may create

- Source, tests and migrations that the task requires.
- Edits to `ROADMAP.md`, which you must make on every contribution.
- `docs/spikes/Sx.md` when a spike closes.
- Do not create other markdown files, scratch scripts in the repo root or planning documents unless asked. Throwaway experiments go in `scripts/spikes/`.

## Compaction

When the conversation is compacted, preserve:

1. The `ROADMAP.md` task ID and requirement ID currently being worked on, and any roadmap edits not yet written.
2. The list of files changed and why.
3. Any failing test or check, with its output.
4. The status of spikes S1 to S7 and any open VERIFY items touched.
5. Decisions the human made during the session.

## Style of response

- Short. State what changed, what you ran, and what is left.
- Name files by path. Do not paste large diffs back into chat.
- If you are unsure, say so and say how to check.
