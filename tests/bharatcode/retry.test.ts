import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
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
});
