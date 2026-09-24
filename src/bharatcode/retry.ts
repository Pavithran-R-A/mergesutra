import { AppError } from '../core/errors.js';
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
    ((error: unknown): { retry: boolean; retryAfterMs?: number } => ({
      retry: error instanceof AppError && error.retryable,
    }));

  let attempt = 0;
  // maxRetries counts *additional* attempts, so total attempts = maxRetries + 1.
  for (;;) {
    throwIfCancelled(signal);
    try {
      return await fn(attempt, signal);
    } catch (error) {
      const { retry, retryAfterMs } = classify(error);
      const appErr =
        error instanceof AppError
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
