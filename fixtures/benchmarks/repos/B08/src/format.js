import { clamp, inRange } from './range.js';

export function describeRange(value, min, max) {
  const bounded = clamp(value, min, max);
  return `${bounded} ${inRange(value, min, max) ? 'inside' : 'outside'}`;
}
