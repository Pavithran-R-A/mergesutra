import { clearTimeout, setTimeout } from 'node:timers';

export function runWithTimeout(operation, ms) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new RangeError('ms must be a positive number');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
