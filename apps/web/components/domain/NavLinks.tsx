"use client";

import { usePathname } from "next/navigation";

/**
 * Console navigation (UI-1 to UI-6). A client component for one reason: the current
 * section is marked from the pathname, and the layout is a server component that
 * cannot read it. Nothing here fetches or measures.
 */
const LINKS = [
  { href: "/overview", index: "01", label: "Overview" },
  { href: "/endpoints", index: "02", label: "Endpoints" },
  { href: "/payments", index: "03", label: "Payments" },
  { href: "/reconciliation", index: "04", label: "Reconciliation" },
] as const;

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Console" className="flex flex-wrap items-center gap-1">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <a
            aria-current={active ? "page" : undefined}
            className={`group inline-flex items-baseline gap-2 border-b px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
              active
                ? "border-acid text-acid"
                : "border-transparent text-muted hover:border-line-bright hover:text-bone"
            }`}
            href={link.href}
            key={link.href}
          >
            <span className={`text-[9px] ${active ? "text-acid" : "text-faint"}`}>
              {link.index}
            </span>
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}
