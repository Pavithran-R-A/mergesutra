import { setTimeout } from 'node:timers';

export function runWithTimeout(operation, ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    operation().then(resolve, reject);
  });
}
