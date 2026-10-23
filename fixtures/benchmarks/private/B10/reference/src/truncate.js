export function truncate(text, max, suffix = '…') {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (typeof suffix !== 'string') throw new TypeError('suffix must be a string');
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError('max must be a positive integer');
  }
  if (text.length <= max) return text;
  if (suffix.length >= max) {
    throw new RangeError('max is too small for the suffix');
  }
  let kept = '';
  for (const char of text) {
    if (kept.length + char.length + suffix.length > max) break;
    kept += char;
  }
  return kept + suffix;
}
