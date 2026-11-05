/**
 * `react-dom` ships no type declarations, and `@types/react-dom` would be a new
 * dependency — which AGENTS.md reserves for the human — so the one entry point the
 * render tests call is declared here instead. Recorded as C19 so this file goes away
 * with the dependency rather than becoming permanent.
 *
 * Only `renderToStaticMarkup` is declared, because that is all `test/render.test.tsx`
 * uses: static markup, no hydration, no DOM.
 */
declare module "react-dom/server" {
  import type { ReactNode } from "react";

  export function renderToStaticMarkup(element: ReactNode): string;
}
