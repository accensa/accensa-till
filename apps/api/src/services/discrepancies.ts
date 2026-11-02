/**
 * Persist findings (E2/E3): insert on the dedupe key, let the partial unique
 * index drop duplicates of an open cause, and close rows with resolution = 'auto'
 * when the cause clears. UI copy (LR-4) comes from the finding's explanation and
 * suggested action, never from the UI layer.
 */
export function persistFindings(): never {
  throw new Error("not implemented (E2)");
}
