import type { ReactNode } from "react";
import "./globals.css";

/**
 * Root layout (A5). The header is UI-5: relayer balance and the last successful
 * provider poll, both warned when past threshold, so a seller can tell that the
 * numbers below may be stale before acting on them.
 *
 * It renders a server component shell; the poll data arrives with D6, which is
 * why the values below are absent rather than mocked to something reassuring.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b p-4">
          <span className="font-semibold">Till</span>{" "}
          <span className="text-sm opacity-60">
            relayer balance and last poll arrive with D6 (UI-5)
          </span>
        </header>
        <main className="p-4">{children}</main>
      </body>
    </html>
  );
}
