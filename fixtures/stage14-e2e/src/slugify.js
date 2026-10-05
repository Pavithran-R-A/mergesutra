/**
 * Turn a title into a URL slug.
 *
 * Baseline behavior intentionally leaves separators at the edges so the
 * controlled Stage 14 task has one small, deterministic defect to repair.
 */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}
