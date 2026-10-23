export function median(values) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array');
  if (values.length === 0) throw new RangeError('values must not be empty');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
