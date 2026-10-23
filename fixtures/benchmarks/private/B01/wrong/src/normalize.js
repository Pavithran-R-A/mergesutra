export function normalizeLabel(value) {
  if (typeof value !== 'string') throw new TypeError('label must be a string');
  return value
    .trim()
    .toLowerCase()
    .replace(/[ \t\n\r\f\v]+/g, ' ');
}
