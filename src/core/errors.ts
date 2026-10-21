import { redactDocument } from '../security/redaction.js';

/**
 * Structured application errors.
 *
 * Every failure MergeSutra surfaces is an `AppError` with an explicit, machine
 * readable `kind`, a truthful `retryable` flag and optional safe `details`.
 *
 * Secrets must never appear in `message` or `details`, and the two halves are
 * guarded at different places. `details` is masked here, on construction, because
 * it is where a caller puts the bytes it did not write — a child process's stderr,
 * a parse failure over a file a human edited, a value read off disk — and a caller
 * that had already cleaned them would not need this line. Masked deeply and
 * structurally, so a count stays a count and a refusal stays an object rather than
 * a string dump. `message` is the build's own prose and is masked where it is
 * printed (`cli/program.ts`), which keeps the two paths from disagreeing about one
 * error's text.
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
    super(
      options.message,
      // `isErrorLike`, not `instanceof`: the cause of a transport failure is somebody
      // else's value, and asking a proxied cause what it is can be the thing that throws —
      // which would replace the failure under construction with the trap's own message.
      isErrorLike(options.cause) ? { cause: options.cause } : undefined,
    );
    this.name = 'AppError';
    this.kind = options.kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.remediation = options.remediation;
    this.details = redactDocument(options.details);
    Error.captureStackTrace?.(this, AppError);
  }
}

export function isAppError(value: unknown): value is AppError {
  if (!isObjectLike(value)) return false;
  try {
    return value instanceof AppError;
  } catch {
    // A refusal is answered "not one of ours", which is the safe direction: the caller
    // then wraps the value in an error it wrote itself instead of trusting `kind` and
    // `retryable` read through an object that has already shown it withholds what it is.
    return false;
  }
}

/**
 * Whether this is a failure, asked in a way that cannot fail.
 *
 * `instanceof` is not a safe read: it walks the value's prototype chain, so a proxy with a
 * throwing `getPrototypeOf` trap turns the question "is this an `Error`" into the error —
 * and the trap's message then replaces the failure being described. Refusing the question
 * is not the same as answering "not an error", so a refusal falls back to the one field
 * that makes a failure worth reporting: a message of its own.
 */
export function isErrorLike(value: unknown): value is Error {
  if (!isObjectLike(value)) return false;
  let answered: boolean | undefined;
  try {
    answered = value instanceof Error;
  } catch {
    answered = undefined;
  }
  if (answered !== undefined) return answered;
  try {
    return typeof (value as { message?: unknown }).message === 'string';
  } catch {
    return false;
  }
}

/**
 * The retry decision's facts, read without being able to fail.
 *
 * `isAppError` establishes identity, not readability: a value can inherit this class's
 * prototype and still refuse a field through a getter or a proxy. A refused flag is
 * answered "do not retry" — the same safe direction as a refused identity — because a
 * retry decided from a flag this side could not read is a spend it cannot explain. A
 * refused delay does not cancel the retry: the server's wait is an optimisation, and the
 * caller's backoff is still a bound.
 */
export function retryFacts(error: AppError): { retryable: boolean; retryAfterMs?: number } {
  let retryable: unknown;
  try {
    retryable = error.retryable;
  } catch {
    return { retryable: false };
  }
  if (retryable !== true) return { retryable: false };
  let after: unknown;
  try {
    after = error.retryAfterMs;
  } catch {
    return { retryable: true };
  }
  return typeof after === 'number' && Number.isFinite(after)
    ? { retryable: true, retryAfterMs: after }
    : { retryable: true };
}

function isObjectLike(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
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
