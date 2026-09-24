/**
 * Structured application errors.
 *
 * Every failure MergeSutra surfaces is an `AppError` with an explicit, machine
 * readable `kind`, a truthful `retryable` flag and optional safe `details`.
 * Secrets must never appear in `message` or `details` — callers pass already
 * redacted values, and `AppError` redacts `details` defensively on construction.
 */

export type AppErrorKind =
  | 'config'
  | 'network'
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'not-found'
  | 'validation'
  | 'not-implemented';

export interface AppErrorOptions {
  readonly kind: AppErrorKind;
  readonly message: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly remediation?: string;
}

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly remediation?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause instanceof Error ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.kind = options.kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.remediation = options.remediation;
    this.details = options.details;
    Error.captureStackTrace?.(this, AppError);
  }

  isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Map an HTTP status code to a truthful error kind + retryability. */
export function kindForStatus(status: number): { kind: AppErrorKind; retryable: boolean } {
  switch (status) {
    case 401:
    case 403:
      return { kind: 'auth', retryable: false };
    case 408:
      return { kind: 'timeout', retryable: true };
    case 429:
      return { kind: 'rate-limit', retryable: true };
    case 404:
      return { kind: 'not-found', retryable: false };
    case 400:
    case 422:
      return { kind: 'invalid-response', retryable: false };
    default:
      if (status >= 500) return { kind: 'server', retryable: true };
      return { kind: 'invalid-response', retryable: false };
  }
}
