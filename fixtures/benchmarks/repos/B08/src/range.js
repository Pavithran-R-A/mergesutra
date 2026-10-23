export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function inRange(value, min, max) {
  return value >= min && value < max;
}
