import { assertBounds, inRange } from './range.js';

export function describeRange(value, min, max, options) {
  assertBounds(min, max);
  return `${value} ${inRange(value, min, max, options) ? 'inside' : 'outside'}`;
}
