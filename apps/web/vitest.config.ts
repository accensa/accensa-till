import { defineConfig } from "vitest/config";

/**
 * apps/web has no browser test framework (ARCHITECTURE.md 3: "No browser test
 * framework"), and adding one is a dependency decision for the human. What can be
 * run here is the code's own behaviour: the form's rules, the typed reads, and the
 * components rendered by `react-dom/server` — the library the app already ships
 * with — so a screen is checked as the text a seller reads rather than as a claim
 * in a comment.
 *
 * `jsx: "automatic"` is here because the app's tsconfig leaves JSX for Next to
 * compile (`jsx: "preserve"`) and Vitest has no Next plugin: esbuild does the same
 * transform, with the same `react/jsx-runtime` import, and nothing new is installed.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    pool: "forks",
  },
});
