import { z } from 'zod';
import type { LockReading } from './lock.js';

/**
 * The one description of a run's lock that is allowed to reach a page.
 *
 * `lock.ts` already answers the hard question — who holds this, and can this machine
 * prove they are gone — and its answer is a `LockReading`: a directory, a parsed owner
 * record or the reason there is not one, and a liveness of `ALIVE`, `GONE` or
 * `UNKNOWABLE`. What it deliberately does *not* hold is the sentence a person reads,
 * because the module that can break a lock should not also be the module that decides
 * how breaking one looks from the outside.
 *
 * So this file turns that answer into five words and one sentence, and nothing else:
 *
 * 1. **The vocabulary is closed, and `UNKNOWABLE` is not `GONE`.** A holder on another
 *    host is reported as held elsewhere, never as stale. That distinction is the entire
 *    safety of the screen: "stale" is the word that makes a person delete a directory,
 *    and this build cannot know whether a process on a machine it cannot reach is
 *    running. The fifth word, `UNREADABLE`, covers a lock this build cannot interpret at
 *    all — a truncated owner record, a lock naming a different run, a plain file where
 *    the directory belongs — which is likewise never rendered as an absence.
 * 2. **Nothing here can change what it describes.** This module reads a `LockReading`
 *    and returns data; it imports no filesystem function. The claim that `status` does
 *    not touch a lock is therefore not a claim about discipline but about shape.
 * 3. **The token is never carried out.** A release proves the lock it removes is the one
 *    it created by matching that token. A description of a lock that printed the token
 *    would hand any reader of the screen the ability to release somebody else's claim,
 *    so the field is not in the output type at all.
 * 4. **Owner strings are somebody else's bytes.** `host` and `createdAt` come from a JSON
 *    file any process on this machine could have written, and `why` is built partly from
 *    a recorded run id. They reach a page only when every code point is printable —
 *    otherwise a lock file could type an escape sequence into a terminal, which is the
 *    same injection §27 refuses to let a run record do to a screen.
 */

export const LOCK_REPORT_STATES = [
  'UNHELD',
  'HELD_LIVE',
  'HELD_ELSEWHERE',
  'HELD_PROVABLY_GONE',
  'UNREADABLE',
] as const;

const lockHolderSchema = z
  .object({
    operation: z.string().min(1),
    pid: z.number().int(),
    /** `null` means the record named a host this build will not print, not "no host". */
    host: z.string().nullable(),
    createdAt: z.string().nullable(),
  })
  .strict();

export const lockReportSchema = z
  .object({
    state: z.enum(LOCK_REPORT_STATES),
    /** One sentence, in the build's own words, never quoting a record's bytes. */
    detail: z.string().min(1),
    /** Where the lock is, so the answer to an uncertain lock is a person with a filesystem. */
    directory: z.string().min(1),
    holder: lockHolderSchema.nullable(),
  })
  .strict();

export type LockReport = z.infer<typeof lockReportSchema>;
export type LockHolder = z.infer<typeof lockHolderSchema>;

export function describeLock(reading: LockReading): LockReport {
  if (reading.state === 'FREE') {
    return {
      state: 'UNHELD',
      detail: 'No lock directory for this run, and looking at it did not make one.',
      directory: reading.directory,
      holder: null,
    };
  }

  const { holding } = reading;
  const report = (
    state: LockReport['state'],
    detail: string,
    holder: LockHolder | null,
  ): LockReport => ({ state, detail, directory: holding.directory, holder });

  if (holding.occupied) {
    return report(
      'UNREADABLE',
      `Something that is not a MergeSutra lock directory is at ${holding.directory}. Nothing here will delete or overwrite it.`,
      null,
    );
  }
  if (!holding.owner) {
    const why = printable(holding.why) ?? 'cannot be read by this build';
    return report(
      'UNREADABLE',
      `There is a lock for this run ${why}. Nothing here will delete it, and nothing here will repair it; a person has to decide.`,
      null,
    );
  }

  const holder: LockHolder = {
    operation: holding.owner.operation,
    pid: holding.owner.pid,
    host: printable(holding.owner.host),
    createdAt: printable(holding.owner.createdAt),
  };
  const who = `process ${String(holder.pid)} on host ${holder.host ?? 'a name this build will not print'}`;
  // The time the claim was written is on the page because it is what a person weighs a
  // `HELD_PROVABLY_GONE` against — and it is the owner record's own string, so it goes
  // through the same refusal as the host name rather than being printed because it looks
  // like a date.
  const when = holder.createdAt === null ? '' : `, taken ${holder.createdAt}`;

  if (holding.liveness === 'UNKNOWABLE') {
    return report(
      'HELD_ELSEWHERE',
      `${who} holds this run's lock${when}, and whether that process is running is a question this machine cannot answer. The lock is at ${holding.directory}.`,
      holder,
    );
  }
  if (holding.liveness === 'ALIVE') {
    return report(
      'HELD_LIVE',
      `${who} holds this run's lock${when} and is running on this machine, so a second lifecycle operation on this run would edit the same evidence twice.`,
      holder,
    );
  }
  return report(
    'HELD_PROVABLY_GONE',
    `The lock names ${who}${when === '' ? '' : `${when},`}, and this machine can see no such process. The lock is still at ${holding.directory} — this command does not remove it.`,
    holder,
  );
}

/**
 * The owner record's strings, or `null` when they would type into a terminal.
 *
 * Tested by code point rather than by a control-character pattern, because a raw
 * escape regex is itself the thing a linter is right to ban. Anything outside printable
 * ASCII — C0 and C1 controls, `DEL`, and a newline that would start a fresh line on a
 * page whose rows are the structure — is refused, and the refusal is visible as `null`
 * rather than hidden as an empty string.
 */
function printable(value: string | null): string | null {
  if (value === null) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i) ?? 0;
    if (code < 0x20 || code > 0x7e) return null;
  }
  return value.length > 0 ? value : null;
}
