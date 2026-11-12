import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { api } from "../../lib/api-client.ts";
import { HeaderStatus } from "./HeaderStatus.tsx";
import { NavLinks } from "./NavLinks.tsx";
import { SignOutButton } from "./SignOutButton.tsx";

/**
 * Console chrome (A5, UI-5, F5) shared by the dashboard and sign-in groups. The
 * status strip is here rather than on each page because a seller needs the relayer
 * balance and the last provider poll before trusting any number below them, and
 * because `/sign-in` shares this shell: no cookie is a normal case, and the strip
 * then claims nothing.
 *
 * The read happens on the server for the reason every dashboard read does — the
 * session cookie is `HttpOnly`, so only a server render can hand it back to the API
 * that signed it.
 */
export async function ConsoleShell({ children }: { children: ReactNode }) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const status = await api.status(token === undefined ? undefined : `${SESSION_COOKIE}=${token}`);

  return (
    <>
      <header className="border-b border-line bg-ink">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4 lg:px-8">
          <a className="flex items-center gap-3" href="/">
            <span
              aria-hidden
              className="grid h-9 w-9 grid-cols-2 gap-[3px] border border-line-bright p-[5px]"
            >
              <span className="bg-acid" />
              <span className="bg-bone/80" />
              <span className="bg-bone/80" />
              <span className="bg-line-bright" />
            </span>
            <span>
              <span className="block text-[15px] font-semibold leading-none tracking-[0.32em] text-bone">
                TILL
              </span>
              <span className="mt-1.5 block font-mono text-[9px] uppercase leading-none tracking-[0.16em] text-faint">
                NEAR / x402 settlement
              </span>
            </span>
          </a>

          <NavLinks />

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-faint sm:block">
              Hackathon build · 2026
            </span>
            {token !== undefined ? (
              <div className="flex items-center gap-2">
                <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-mint sm:inline">
                  Connected
                </span>
                <SignOutButton />
              </div>
            ) : (
              <a className="btn btn-primary" href="/sign-in">
                Connect wallet
              </a>
            )}
          </div>
        </div>

        <div className="border-t border-line bg-coal">
          <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5 lg:px-8">
            <span className=" eyebrow flex items-center gap-2 text-faint">
              <span aria-hidden className="h-1 w-1 bg-acid" />
              System status
            </span>
            <HeaderStatus result={status} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1320px] px-5 py-10 lg:px-8 lg:py-14" id="main">
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-2 px-5 py-6 font-mono text-[10px] uppercase tracking-[0.14em] text-faint sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <span>Till — paywalled APIs, reconciled on NEAR</span>
          <span>Append-only ledger / bigint money / no custody</span>
        </div>
      </footer>
    </>
  );
}
