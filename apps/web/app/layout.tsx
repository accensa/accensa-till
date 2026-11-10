import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { HeaderStatus } from "../components/domain/HeaderStatus.tsx";
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
      <body>
        <header className="border-b p-4">
          <span className="font-semibold">Till</span>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <HeaderStatus result={status} />
          </div>
          <nav className="mt-2 flex gap-4 text-sm">
            <a className="underline" href="/endpoints">
              Endpoints
            </a>
            <a className="underline" href="/payments">
              Payments
            </a>
            <a className="underline" href="/reconciliation">
              Reconciliation
            </a>
            <a className="underline" href="/sign-in">
              Sign in
            </a>
          </nav>
        </header>
        <main className="p-4">{children}</main>
      </body>
    </html>
  );
}
