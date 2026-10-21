import { AppError, isAppError, retryFacts } from '../core/errors.js';
import type { RetryConfig, Sleeper } from './types.js';

/**
 * Bounded retry policy for BharatCode calls.
 *
 * Only *idempotent reads / non-mutating* attempts are retried. Retryability is
 * decided by the caller via the thrown `AppError.retryable` flag. Backoff is
 * exponential with full jitter and honours a server `Retry-After` when present.
 * Never retries indefinitely and never retries unsafe mutations.
 */

export interface AttemptContext {
  readonly attempt: number; // 0-based
  readonly error: AppError;
}

export interface RunWithRetryOptions {
  readonly config: RetryConfig;
  readonly signal?: AbortSignal;
  readonly sleep: Sleeper;
  readonly random?: () => number;
  /** Decide whether an error is worth retrying (default: error.retryable). */
  readonly isRetryable?: (error: unknown) => { retry: boolean; retryAfterMs?: number };
  readonly onRetry?: (ctx: AttemptContext) => void;
}

const defaultRandom = (): number => Math.random();

/** Parse a Retry-After header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function backoffDelayMs(config: RetryConfig, attempt: number, random: () => number): number {
  const capped = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
  // Full jitter: uniform in [0, capped].
  return Math.round(capped * random());
}

/**
 * Execute `fn`, applying the bounded retry policy. `fn` must reject with an
 * `AppError` (or anything classified by `isRetryable`) for retry logic to act.
 */
export async function runWithRetry<T>(
  fn: (attempt: number, signal?: AbortSignal) => Promise<T>,
  options: RunWithRetryOptions,
): Promise<T> {
  const { config, signal, sleep } = options;
  const random = options.random ?? defaultRandom;
  const classify: NonNullable<RunWithRetryOptions['isRetryable']> =
    options.isRetryable ??
    ((error: unknown): { retry: boolean; retryAfterMs?: number } => {
      // `retryFacts`, not a direct read: identity was established by `isAppError`, but the
      // flag itself can still be refused, and that refusal would escape from here.
      if (!isAppError(error)) return { retry: false };
      const facts = retryFacts(error);
      return { retry: facts.retryable, retryAfterMs: facts.retryAfterMs };
    });

  let attempt = 0;
  // maxRetries counts *additional* attempts, so total attempts = maxRetries + 1.
  for (;;) {
    throwIfCancelled(signal);
    try {
      return await fn(attempt, signal);
    } catch (error) {
      // Every read a decision needs can refuse: the classifier is caller-supplied, its
      // result is somebody else's object too, and a refusal thrown from here would replace
      // the attempt's failure with the trap's message. A decision this side cannot read is
      // answered "do not retry", which is the direction that cannot spend on a guess.
      let retry = false;
      let retryAfterMs: number | undefined;
      try {
        const decision = classify(error);
        retry = decision.retry === true;
        const after: unknown = decision.retryAfterMs;
        retryAfterMs = typeof after === 'number' && Number.isFinite(after) ? after : undefined;
      } catch {
        retry = false;
      }
      // `isAppError`, not `instanceof`: `classify` is handed whatever the attempt threw, and
      // asking a proxied failure whether it is one of ours can itself throw — which would
      // replace the retry decision, and the failure behind it, with the trap's own message.
      const appErr = isAppError(error)
        ? error
        : new AppError({
            kind: 'network',
            message: 'BharatCode request failed',
            retryable: retry,
            cause: error,
          });
      const canRetry = retry && attempt < config.maxRetries;
      if (!canRetry) throw appErr;
      const delay = retryAfterMs ?? backoffDelayMs(config, attempt, random);
      options.onRetry?.({ attempt, error: appErr });
      await sleep(delay, signal);
      attempt += 1;
    }
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError({
      kind: 'cancelled',
      message: 'Operation was cancelled.',
      retryable: false,
    });
  }
}
