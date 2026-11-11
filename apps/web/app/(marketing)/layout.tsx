import type { ReactNode } from "react";

const SECTIONS = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#film", label: "Film" },
  { href: "#faq", label: "FAQ" },
] as const;

/**
 * Public chrome for the landing page. Deliberately not `ConsoleShell`: a visitor
 * arriving from a launch post should not be greeted by a relayer balance and a
 * seller's session state. The console is one click away, and its own header takes
 * over from there.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-ink/95 backdrop-blur-none">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4 lg:px-8">
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

          <nav aria-label="Landing" className="flex flex-wrap items-center gap-1">
            {SECTIONS.map((section) => (
              <a
                className="inline-flex items-baseline gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted transition-colors hover:text-bone"
                href={section.href}
                key={section.href}
              >
                {section.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <a
              className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-faint sm:block"
              href="/overview"
            >
              Open console
            </a>
            <a className="btn btn-primary" href="/sign-in">
              Connect wallet
            </a>
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-5 py-10 lg:px-8">
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
            <div>
              <p className="text-[15px] font-semibold tracking-[0.32em] text-bone">TILL</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                Paywalled APIs, reconciled on NEAR
              </p>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              <a className="hover:text-bone" href="#product">
                Product
              </a>
              <a className="hover:text-bone" href="#how-it-works">
                How it works
              </a>
              <a className="hover:text-bone" href="#film">
                Film
              </a>
              <a className="hover:text-bone" href="#faq">
                FAQ
              </a>
              <a className="hover:text-bone" href="/sign-in">
                Console
              </a>
            </div>
          </div>
          <div className="flex flex-col justify-between gap-2 border-t border-line pt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-faint sm:flex-row">
            <span>Built for the NEAR x402 hackathon · 2026</span>
            <span>Append-only ledger / bigint money / no custody</span>
          </div>
        </div>
      </footer>
    </>
  );
}
