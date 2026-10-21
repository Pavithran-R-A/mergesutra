import { describe, expect, it } from 'vitest';

import { AppError, isAppError, isErrorLike, retryFacts } from '../../src/core/errors.js';

/**
 * Asking a failure what it is, of failures that may refuse to answer.
 *
 * These two predicates are what the transport path uses to decide how to describe (and
 * whether to retry) something that came from outside this build. `instanceof` looks like the
 * one question that needs no care, and it is not: it walks the value's prototype chain, so a
 * proxy with a throwing `getPrototypeOf` trap turns the question into a failure of its own.
 * The tests here hold the predicates to their contract — never throw, and never guess — so
 * that the callers in `bharatcode/retry.ts` and `bharatcode/client.ts` can ask it freely.
 */

describe('reading the shape of a failure that may refuse', () => {
  it('answers for the values that answer it', () => {
    expect(isErrorLike(new Error('a real one'))).toBe(true);
    expect(isErrorLike(new AppError({ kind: 'network', message: 'one of ours' }))).toBe(true);
    expect(isErrorLike({ message: 'shaped like one' })).toBe(false);
    expect(isErrorLike('fetch failed')).toBe(false);
    expect(isErrorLike(null)).toBe(false);
    expect(isErrorLike(undefined)).toBe(false);
  });

  it('still recognises a failure whose prototype chain refuses the question', () => {
    // Refusing `getPrototypeOf` is refusing the question, not answering "not an error". The
    // fields are still readable and they are the diagnosis, so the fallback asks for the one
    // that makes a failure worth reporting instead of letting the trap decide the answer.
    const hostile = new Proxy(
      { name: 'TypeError', message: 'fetch failed at the socket' },
      {
        getPrototypeOf(): never {
          throw new TypeError('trap on the prototype chain');
        },
      },
    );
    expect(isErrorLike(hostile)).toBe(true);
    expect(
      isErrorLike(
        new Proxy(
          { note: 'no message here' },
          {
            getPrototypeOf(): never {
              throw new TypeError('trap on the prototype chain');
            },
          },
        ),
      ),
    ).toBe(false);
  });

  it('does not claim one of its own for a value that refuses the question', () => {
    // The other predicate has the opposite safe direction: `AppError` carries `kind` and
    // `retryable`, and a retry decided from fields read through an object that withheld its
    // own identity is a retry this build cannot explain. So a refusal is answered "not ours".
    const ours = new AppError({ kind: 'network', message: 'the socket died', retryable: true });
    expect(isAppError(ours)).toBe(true);
    const hostile = new Proxy(ours, {
      getPrototypeOf(): never {
        throw new TypeError('trap on the prototype chain');
      },
    });
    expect(isAppError(hostile)).toBe(false);
    expect(isAppError(new Error('an ordinary one'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it('builds an AppError around a cause that refuses to be identified', () => {
    // The constructor used to ask `options.cause instanceof Error` to decide whether to hand
    // the cause to `super()`. That is a read of somebody else's value, in the middle of
    // constructing the error that reports it — so a hostile cause did not withhold itself, it
    // destroyed the report. Building the error is now something that cannot fail this way.
    const hostile = new Proxy(new Error('fetch failed behind a refused prototype'), {
      getPrototypeOf(): never {
        throw new TypeError('trap on the prototype chain');
      },
    });
    const built = new AppError({
      kind: 'network',
      message: 'Could not reach BharatCode',
      cause: hostile,
    });
    expect(built.message).toBe('Could not reach BharatCode');
    expect(built.cause).toBe(hostile);
  });

  it('reads the retry facts of a failure whose fields refuse', () => {
    // Identity was established, so the fields are the next read — and they are somebody
    // else's values too. A refused flag is answered "do not retry"; a refused delay leaves
    // the retry itself intact, because the server's wait is an optimisation, not permission.
    const ours = new AppError({
      kind: 'rate-limit',
      message: 'slow down',
      retryable: true,
      retryAfterMs: 4000,
    });
    expect(retryFacts(ours)).toEqual({ retryable: true, retryAfterMs: 4000 });
    expect(retryFacts(new AppError({ kind: 'auth', message: 'no', retryable: false }))).toEqual({
      retryable: false,
    });

    const refusesDelay = new Proxy(ours, {
      get(target, key, receiver) {
        if (key === 'retryAfterMs') throw new TypeError('trap on the delay');
        return Reflect.get(target, key, receiver);
      },
    });
    expect(retryFacts(refusesDelay)).toEqual({ retryable: true });

    const refusesFlag = new Proxy(ours, {
      get(target, key, receiver) {
        if (key === 'retryable') throw new TypeError('trap on the flag');
        return Reflect.get(target, key, receiver);
      },
    });
    expect(retryFacts(refusesFlag)).toEqual({ retryable: false });
  });
});
