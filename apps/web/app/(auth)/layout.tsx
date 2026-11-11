import type { ReactNode } from "react";

import { ConsoleShell } from "../../components/domain/ConsoleShell.tsx";

/** Sign-in keeps the console chrome: it is the entry point to it (UI-1). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
