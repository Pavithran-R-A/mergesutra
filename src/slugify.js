/**
 * Turn a title into a URL slug.
 *
 * Current behaviour: lowercase, replace each run of non-alphanumeric characters
 * with a single hyphen. Leading and trailing hyphens are NOT removed, so
 * `slugify('  Hello  ')` returns '-hello-'.
 */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}
