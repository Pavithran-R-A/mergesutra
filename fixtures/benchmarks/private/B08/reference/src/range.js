export function assertBounds(min, max) {
  if (min > max) throw new RangeError('min must not exceed max');
}

export function clamp(value, min, max) {
  assertBounds(min, max);
  return Math.min(Math.max(value, min), max);
}

export function inRange(value, min, max, options = {}) {
  assertBounds(min, max);
  const inclusive = options.inclusive === true;
  return value >= min && (inclusive ? value <= max : value < max);
}
