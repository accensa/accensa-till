import type { ReactNode } from "react";

import { ConsoleShell } from "../../components/domain/ConsoleShell.tsx";

/** Dashboard chrome (A5, UI-5). Kept per group so the landing page never inherits it. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
