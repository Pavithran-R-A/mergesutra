export function truncate(text, max, suffix = '…') {
  if (text.length <= max) return text;
  return text.slice(0, max - suffix.length) + suffix;
}
