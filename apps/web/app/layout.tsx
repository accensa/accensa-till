import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

/**
 * The only global shell. Chrome lives with the surface that needs it: the console
 * header and status strip belong to the dashboard and sign-in groups, and the
 * landing page gets its own marketing header, so a first-time visitor never lands
 * inside a seller's back-office frame.
 */
export const metadata: Metadata = {
  title: {
    default: "Till — x402 paywalls and settlement for NEAR APIs",
    template: "%s · Till",
  },
  description:
    "Till paywalls any GET API with x402 on NEAR, routes payouts through NEAR Intents, and reconciles every payment against every payout in an append-only ledger.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-bone">
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-acid focus:bg-ink focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:uppercase focus:tracking-[0.16em]"
          href="#main"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
