import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, isAppError } from '../core/errors.js';
import type { RequestBudget } from './types.js';

/**
 * The ceiling on completion requests, enforced where a request is actually made.
 *
 * MergeSutra has always had a bound on what a live chain may spend — `MAX_MODEL_COMPLETIONS`
 * in the qualification rules — but it is a *measurement* taken after the run: it adds up the
 * requests the three stages filed and declares a finished run unqualified when the sum is past
 * the ceiling. That is the right instrument for judging a run that already happened and the
 * wrong one for stopping a request about to happen, and the difference is money. A thirteenth
 * POST was reachable without any stage misbehaving, by three routes:
 *
 * - **Re-entry.** `plan`, `implement` and `review` run as separate processes, and `plan`'s own
 *   next-stage line tells the operator to run it again. Nothing any one of them holds in
 *   memory outlives it, so a per-process counter is not a per-run ceiling. Only `implement`
 *   carries a residual (`src/lifecycle/budget.ts`), and a residual in one stage is not a
 *   ceiling across three.
 * - **Retries.** One `complete()` is `maxRetries + 1` POSTs when the service is busy. The
 *   live job pins `BHARATCODE_MAX_RETRIES: '0'`, but a ceiling that only held under that pin
 *   is a ceiling with a documented exception, and the number being protected is what the
 *   provider is asked for, not how many turns the caller intended.
 * - **A failed write.** A guard that counts in memory and spends on the filesystem reports a
 *   budget it did not enforce.
 *
 * So the count lives where the request is made: one marker file per request, created
 * exclusively (`O_CREAT | O_EXCL`) in a directory every process of the run is pointed at. The
 * claim is exclusive creation — the same kind of claim the per-run lock makes with `mkdir`,
 * for the same reason: it is the one atomic, crash-safe, no-dependency primitive both POSIX
 * and Windows offer, and two processes racing for the last slot cannot both win it. A
 * read-modify-write counter would have to be locked to be correct, which is this mechanism
 * one level down.
 *
 * Two consequences are deliberate and worth stating plainly:
 *
 * 1. **A slot is spent, never refunded.** A request that reserved a slot and then died — killed
 *    mid-flight, cancelled, answered with an error — leaves its marker behind. Under-counting
 *    is the failure this mechanism exists to prevent, so the conservative direction wins: the
 *    ledger says "this many were asked for", which is what a ceiling is about. Starting a fresh
 *    run therefore means pointing it at a fresh ledger directory: the reservation makes that
 *    directory if it is absent and never removes a marker from it, so nothing here resets a
 *    count between runs. No driver or workflow in this repository sets either variable, so every
 *    run that exists today sends its requests exactly as it did before this file was written.
 * 2. **It fails closed.** If the ledger cannot be created or written, the request is refused
 *   rather than sent. A guard that spends when its bookkeeping breaks is a guard that spends.
 *
 * When neither variable is set there is no budget, no directory, and no filesystem access at
 * all — an ordinary customer run behaves exactly as it did before this file existed.
 */

/** What the exhausted ceiling says, distinct from a ledger that could not be written. */
export const REQUEST_BUDGET_EXHAUSTED = 'REQUEST_BUDGET_EXHAUSTED';
export const REQUEST_BUDGET_UNAVAILABLE = 'REQUEST_BUDGET_UNAVAILABLE';

/**
 * The marker name for slot `index`, zero-padded so a directory listing is in order and the
 * same slot resolves to the same name in every process.
 */
function slotName(index: number): string {
  return `completion-${String(index).padStart(4, '0')}`;
}

/**
 * Take one completion slot out of the ledger, or refuse the request.
 *
 * Returns nothing on success: the caller's next line is the request, and a value it could
 * ignore would be a way to skip the reservation. The refusal is `blocked` and not retryable,
 * because the answer is not "wait and ask again" — asking again is what this exists to stop.
 */
export async function reserveCompletion(budget: RequestBudget): Promise<void> {
  try {
    await mkdir(budget.ledgerDirectory, { recursive: true });
  } catch (cause) {
    throw unavailable(budget, cause);
  }

  for (let index = 1; index <= budget.limit; index += 1) {
    const slot = path.join(budget.ledgerDirectory, slotName(index));
    try {
      // `wx` is O_WRONLY | O_CREAT | O_EXCL: this call either creates the file nobody else
      // has created yet or fails, and it cannot truncate a marker that is already there.
      await writeFile(slot, `${process.pid}\n`, { flag: 'wx' });
      return;
    } catch (cause) {
      if (codeOf(cause) === 'EEXIST') continue;
      throw unavailable(budget, cause);
    }
  }

  throw new AppError({
    kind: 'blocked',
    message:
      `This run's BharatCode completion budget of ${String(budget.limit)} request` +
      `${budget.limit === 1 ? '' : 's'} is already spent, so the request was refused here and ` +
      'never left this process.',
    retryable: false,
    details: { code: REQUEST_BUDGET_EXHAUSTED, limit: budget.limit },
    remediation:
      'The ledger that counts these requests is the directory named by BHARATCODE_REQUEST_LEDGER. ' +
      'A new run needs a new ledger directory; raise BHARATCODE_MAX_COMPLETION_REQUESTS only if ' +
      'the extra requests are authorised.',
  });
}

/**
 * A ledger this build cannot write is a budget this build cannot honour.
 *
 * The reason is reported as the error code, not as the operating system's message: an `ENOENT`
 * or `EPERM` string from `mkdir`/`writeFile` can carry the path it failed on, and this message
 * goes into a run record that gets packed and shipped to a reviewer.
 */
function unavailable(budget: RequestBudget, cause: unknown): AppError {
  return new AppError({
    kind: 'blocked',
    message: `The BharatCode request budget could not be recorded in the ledger configured by BHARATCODE_REQUEST_LEDGER (code ${codeOf(cause) ?? 'unknown'}), so this request was refused before it left this process.`,
    retryable: false,
    cause,
    details: { code: REQUEST_BUDGET_UNAVAILABLE, limit: budget.limit },
    remediation:
      'Point BHARATCODE_REQUEST_LEDGER at a directory this process can create and write, or unset ' +
      'both budget variables to run without a ceiling.',
  });
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * Which budget refusal this failure is, or `null` when it is not one.
 *
 * A stage that catches a transport failure has to say what happened in its own words, and
 * the words it has were written for the case where BharatCode was asked and did not answer.
 * A refusal from here is the opposite event — nothing was asked — so the caller needs to be
 * able to tell the two apart without reading this module's message text.
 *
 * Every field is read through a guard: `isAppError` establishes that the value inherits this
 * class, not that reading it is safe, and a refusal here must answer "not a budget refusal"
 * rather than replace the caller's failure with the trap's message.
 */
export function budgetRefusalCode(error: unknown): string | null {
  if (!isAppError(error)) return null;
  let kind: unknown;
  let code: unknown;
  try {
    kind = error.kind;
  } catch {
    return null;
  }
  if (kind !== 'blocked') return null;
  try {
    code = error.details?.code;
  } catch {
    return null;
  }
  return code === REQUEST_BUDGET_EXHAUSTED || code === REQUEST_BUDGET_UNAVAILABLE
    ? String(code)
    : null;
}
