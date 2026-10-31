import { describe, expect, it } from 'vitest';

import { AppError, isAppError } from '../../src/core/errors.js';
import { runWithRetry } from '../../src/bharatcode/retry.js';
import type { Sleeper } from '../../src/bharatcode/types.js';

/**
 * The retry loop, on failures that refuse to be classified.
 *
 * `runWithRetry` decides whether to spend another attempt from the identity of whatever the
 * attempt threw. That identity is normally established with `instanceof AppError`, and this
 * loop is handed values from outside the build — the object a `fetch` rejected with, a
 * wrapper's re-throw — so the question is asked of a value that can answer it by throwing.
 * When it does, the trap's message is what escapes the loop, and the paid request's own
 * failure never reaches the operator at all.
 */

const noSleep: Sleeper = async () => {};
const config = { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 };

describe('retry classification of a hostile failure', () => {
  it('reports the failure it was given, not the trap that refused to identify it', async () => {
    const inner = new AppError({ kind: 'network', message: 'the socket died', retryable: true });
    const hostile = new Proxy(inner, {
      getPrototypeOf(): never {
        throw new TypeError('trap on the prototype chain');
      },
    });
    let attempts = 0;
    const err = await runWithRetry(
      async () => {
        attempts += 1;
        throw hostile;
      },
      { config, sleep: noSleep },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).kind).toBe('network');
    expect((err as AppError).message).not.toContain('trap on the prototype chain');
    // A value this side cannot identify is not one it may re-spend on: `retryable` is read
    // through the refusal, so the conservative answer is the only one that is honest.
    expect(attempts).toBe(1);
    expect((err as AppError).retryable).toBe(false);
  });

  it('does not let a failure that refuses its retry flag replace the failure', async () => {
    // Identity and readability are different questions. A value can inherit `AppError`'s
    // prototype — so `instanceof` answers "ours" without a throw — and still refuse the one
    // field the classifier reads next. That read is a trap of its own, and it used to
    // escape from the catch block, replacing the attempt's failure with the trap's message.
    const ours = new AppError({ kind: 'network', message: 'the socket died', retryable: true });
    const hostile = new Proxy(ours, {
      get(target, key, receiver) {
        if (key === 'retryable') throw new TypeError('trap on the retry flag');
        return Reflect.get(target, key, receiver);
      },
    });
    let attempts = 0;
    const err = await runWithRetry(
      async () => {
        attempts += 1;
        throw hostile;
      },
      { config, sleep: noSleep },
    ).catch((e: unknown) => e);
    // The failure it was given is what escapes, and it is not re-spent on: a retry decided
    // from a flag this side could not read is a spend it could not explain.
    expect(err).toBe(hostile);
    expect(isAppError(err)).toBe(true);
    expect((err as AppError).message).not.toContain('trap on the retry flag');
    expect(attempts).toBe(1);
  });
});

describe('a server Retry-After is subject to the same ceiling as jitter', () => {
  it('clamps an hours-long Retry-After to maxDelayMs', async () => {
    const slept: number[] = [];
    const sleep: Sleeper = async (ms) => {
      slept.push(ms);
    };
    let attempts = 0;
    const err = await runWithRetry(
      async () => {
        attempts += 1;
        throw new AppError({
          kind: 'rate-limit',
          message: 'slow down',
          retryable: true,
          retryAfterMs: 7_200_000,
        });
      },
      { config: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 15_000 }, sleep },
    ).catch((e: unknown) => e);

    expect(attempts).toBe(2);
    expect(slept).toEqual([15_000]);
    expect(err).toBeInstanceOf(AppError);
  });
});
