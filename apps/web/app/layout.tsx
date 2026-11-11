import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { HeaderStatus } from "../components/domain/HeaderStatus.tsx";
import { NavLinks } from "../components/domain/NavLinks.tsx";
import { api } from "../lib/api-client.ts";
import "./globals.css";

/**
 * Root layout (A5). The header line is UI-5, F5: the relayer balance and the last
 * successful provider poll, each with the threshold Till judges it against, so a
 * seller can see that the numbers below may be stale — or that the relayer sponsoring
 * their settles is running out — before acting on them. There is no admin page for
 * either fact, which is why both live here.
 *
 * The read happens in the layout rather than in the browser for the reason every
 * other dashboard read has: the session cookie is `HttpOnly`, so a server render is
 * the only thing that can hand it back to the API that signed it. And because
 * `/sign-in` shares this layout, no cookie at all is a normal case here — the header
 * then says nothing about balances and warns about nothing.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const status = await api.status(token === undefined ? undefined : `${SESSION_COOKIE}=${token}`);

  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-bone">
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-acid focus:bg-ink focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:uppercase focus:tracking-[0.16em]"
          href="#main"
        >
          Skip to content
        </a>

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
              <a className="btn btn-primary" href="/sign-in">
                Connect wallet
              </a>
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
      </body>
    </html>
  );
}
