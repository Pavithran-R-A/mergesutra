import path from 'node:path';
import { AppError } from '../core/errors.js';
import type { RunRecord } from './run-record.js';
import type { RunListResult, RunStore, RunSummary } from './run-store.js';

/**
 * Which run an omitted run id means.
 *
 * Every command that takes an optional run id asked the store for its readable
 * runs and took the first — the newest *readable* record. A directory holding a
 * newer record this build cannot read therefore answered a different question,
 * "which run can I still parse?", in a voice that said "here is your current
 * run", and everything the command then did described the older one.
 *
 * The unreadable list is part of the same question, so it is read as one. A
 * record this build cannot parse can still date itself: `newRunId` writes
 * `run-<yyyymmddThhmmssZ>-<suffix>`, so the name carries its own age. That is
 * the only ordering evidence an unreadable file offers — no `mtime` is consulted,
 * because a filesystem timestamp is not something the run record claims and a
 * copied or restored directory makes it mean whatever it wants to. When an
 * unreadable record is dated at or after the newest readable one, or has a name
 * outside that shape so its age is nobody's business to guess, the honest answer
 * is that "the current run" is not knowable here; the command refuses and names
 * the id a person may pass instead.
 *
 * When a filter is supplied the refusal is still measured against the newest
 * readable record, not against what the filter picks. That closes the question
 * the defect was about — which run is current — exactly, and it leaves a known,
 * documented limit: for a filtered walk, an unreadable record older than the
 * newest readable one might itself have matched the filter. The command that
 * walks still names the run it chose, so a person can see which one it was.
 *
 * An id a person typed is never run through any of this: naming a run means
 * loading that run, and a broken record stays broken on the page.
 */

const MAX_NAMED = 5;

/**
 * Summaries arrive newest-first and this compares the age the file name claims,
 * which is fixed-width and therefore sorts as text.
 */
function stampOf(file: string): string | null {
  const base = path.basename(file);
  const name = base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
  const dated = /^run-(\d{8}T\d{6}Z)-/.exec(name);
  return dated ? (dated[1] ?? null) : null;
}

/** Names a handful of files and counts the rest: one error line, not a wall. */
export function listRecordNames(files: readonly string[]): string {
  const named = files.slice(0, MAX_NAMED).map((file) => path.basename(file));
  const rest = files.length - named.length;
  return `${named.join(', ')}${rest > 0 ? `, and ${String(rest)} more` : ''}`;
}

function refuseOverread(runs: readonly RunSummary[], unreadable: readonly string[]): void {
  const newest = runs[0];
  if (!newest) return;
  const chosen = stampOf(newest.file);
  const blockers = unreadable.filter((file) => {
    const stamp = stampOf(file);
    if (stamp === null) return true;
    if (chosen === null) return true;
    return stamp >= chosen;
  });
  if (blockers.length === 0) return;
  // Only the names appear here. The bytes behind them are the thing this build
  // cannot promise is safe to print, and §27 forbids both quoting them back and
  // quietly repairing them so the command can proceed.
  throw new AppError({
    kind: 'validation',
    message:
      `Cannot tell which run is current: ${String(blockers.length)} run record(s) here ` +
      `cannot be read by this build and are dated at or after the newest one that can, ` +
      `or cannot be dated from their name at all: ${listRecordNames(blockers)}.`,
    remediation:
      `Pass the run id you mean explicitly — '${newest.runId}' is the newest record this ` +
      'build can read — or repair the records named above.',
  });
}

/**
 * The readable records, newest first, after the same refusal `newestRunId` makes.
 *
 * A stage that wants more than the current id — Stage 2 reads an intake run to
 * carry its issue — has to ask the same question, and asking it with its own
 * copy of `store.list()` would give it its own copy of the overread rule. There
 * is one rule about stepping over an unreadable record, so there is one door.
 */
export async function readableRuns(store: RunStore): Promise<readonly RunSummary[]> {
  const listing: RunListResult = await store.list();
  refuseOverread(
    listing.runs,
    listing.unreadable.map((entry) => entry.file),
  );
  return listing.runs;
}

/**
 * The id of the run an omitted run id should mean, or `null` when no readable
 * run exists for the caller to describe. Refuses rather than stepping over a
 * record it cannot read.
 */
export async function newestRunId(
  store: RunStore,
  accept?: (record: RunRecord) => boolean,
): Promise<string | null> {
  const runs = await readableRuns(store);
  const newest = runs[0];
  if (!newest) return null;
  if (!accept) return newest.runId;
  for (const summary of runs) {
    if (accept(await store.load(summary.runId))) return summary.runId;
  }
  return null;
}
