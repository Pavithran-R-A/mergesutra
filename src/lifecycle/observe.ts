import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { defaultRunner, type Runner } from '../core/runner.js';
import { publicationDigestOf } from '../pr/digest.js';
import { readPackIdentity } from '../report/write.js';
import { repairPlanDigest } from '../repair/digest.js';
import type { RunRecord } from '../state/run-record.js';
import { scopeDigest } from '../verify/consent.js';
import { describePatch } from '../verify/patch.js';
import { lifecycleStaleness, type LifecycleFacts, type LifecycleVerdict } from './staleness.js';

/**
 * What is actually on this machine, next to what a run wrote down.
 *
 * `staleness.ts` decides what a pair of digests *means*. That is no use on its
 * own: somebody has to go and find the digests, and every way of finding them has
 * a way of being wrong. A workspace that has been deleted is not a workspace with
 * an unchanged patch in it. A checkout standing on a later commit is not the
 * run's workspace, and asking Git for its diff would *fail*, which is a different
 * fact from "no files differ". A directory that shares the run's basename is not
 * the run's directory. So this module is the part that can fail, written so that
 * every failure has a word of its own and none of them is a reassuring one.
 *
 * Four rules hold the whole file together:
 *
 * - **Read-only, always.** The commands run here are `rev-parse`, `cat-file`, and
 *   whatever `describePatch` asks Git — all of which write nothing. A person who
 *   runs `status` on a broken lifecycle must not end up with a *different* broken
 *   lifecycle, and the workspace they are about to go and look at is the thing
 *   most at risk. Nothing here recreates, resets, cleans, stashes or removes
 *   anything, including when the workspace is simply gone.
 * - **A measurement that failed is reported as failed.** `currentPatchIdentity` is
 *   `null` in that case, which the graph reads as `UNMEASURABLE`. It is never
 *   `null` *and* treated as agreement, and never guessed from the last recorded
 *   value — that would be the tool quoting its own memory as an observation.
 * - **Git evidence outranks an old absolute path.** A run's record carries where
 *   the workspace was on the day it was written, and people move repositories. So
 *   a directory is taken to be this run's repository when it can produce the
 *   commit the run is based on, not when its name matches.
 * - **Few states, each with a cause.** The vocabulary is closed below, and every
 *   state that is not `PRESENT_MATCHED` says why in `detail`.
 */

export const WORKSPACE_STATES = [
  /** The run never prepared one: there is no implementation record to point at. */
  'NOT_CREATED',
  /** It claimed one, and the path it claimed is not there. */
  'MISSING',
  /** There is a directory, but neither Git nor this tool can tell what it is. */
  'UNREADABLE',
  /** There is a Git workspace, but it is not this run's, or has moved past its base. */
  'BASE_MISMATCH',
  /** This run's workspace, at its base, with no patch identity on record to compare. */
  'PRESENT',
  /** These are the bytes the run's newest document describes. */
  'PRESENT_MATCHED',
  /** Somebody changed the bytes after the run's newest document described them. */
  'PRESENT_PATCH_CHANGED',
] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export interface WorkspaceObservation {
  readonly state: WorkspaceState;
  /** Where the run's workspace would be, as recorded; `null` when none was recorded. */
  readonly path: string | null;
  /** The commit this run's documents measured their patches from. */
  readonly recordedBaseSha: string | null;
  /** What Git says the workspace is standing on now, or `null` when it would not say. */
  readonly observedHead: string | null;
  /** The identity of the bytes here now. `null` when they could not be measured. */
  readonly currentPatchIdentity: string | null;
  /** The newest patch identity the run itself wrote down, if it ever wrote one. */
  readonly recordedPatchIdentity: string | null;
  /** Why this state, in the words a status screen prints. */
  readonly detail: string;
}

export interface LifecycleObservation {
  readonly workspace: WorkspaceObservation;
  /**
   * The identity of the pack directory on disk, or `null` when there is no
   * complete pack. Reported beside the graph because a pack is regenerable and so
   * its absence is a to-do rather than a loss — which is not true of anything else
   * in here.
   */
  readonly packOnDisk: string | null;
  readonly facts: LifecycleFacts;
  readonly verdict: LifecycleVerdict;
}

export interface ObserveInput {
  readonly record: RunRecord;
  /** The root the run store keeps its packs under. */
  readonly runsRoot: string;
  /** Where the command was run from; the last fallback for the primary checkout. */
  readonly cwd: string;
  /** A checkout a person pointed at instead of the one the record names. */
  readonly repo?: string;
  readonly run?: Runner;
}

export async function observeRun(input: ObserveInput): Promise<LifecycleObservation> {
  const run = input.run ?? defaultRunner;
  const record = input.record;
  const workspace = await observeWorkspace(record, input, run);
  const patch = workspace.currentPatchIdentity;
  const packOnDisk = await readPackIdentity(input.runsRoot, record.runId);
  const plan = record.verificationPlan;
  const repairPlan = record.repairPlan;
  const publication = record.publications.at(-1) ?? null;
  const execution = record.repairExecutions.at(-1) ?? null;

  const facts: LifecycleFacts = {
    verification: { recorded: record.verification?.patchIdentity ?? null, current: patch },
    evidence: { recorded: record.evidence?.patchIdentity ?? null, current: patch },
    review: { recorded: record.review?.reviewedPatchIdentity ?? null, current: patch },
    repairPlan: { recorded: repairPlan?.reviewedPatchIdentity ?? null, current: patch },
    executionConsent: {
      recorded: record.executionConsent?.planDigest ?? null,
      current: plan ? scopeDigest(plan) : null,
    },
    pack: {
      recorded: publication?.candidate.evidencePackIdentity ?? null,
      current: packOnDisk,
    },
    candidate: { recorded: publication?.candidate.patchIdentity ?? null, current: patch },
    publicationApproval: {
      recorded: publication?.approval?.publicationDigest ?? null,
      current: publication ? publicationDigestOf(publication.candidate) : null,
    },
    repairApproval: {
      recorded: execution?.planDigest ?? null,
      current: repairPlan ? repairPlanDigest(repairPlan) : null,
    },
  };

  return { workspace, packOnDisk, facts, verdict: lifecycleStaleness(facts) };
}

async function observeWorkspace(
  record: RunRecord,
  input: ObserveInput,
  run: Runner,
): Promise<WorkspaceObservation> {
  const implementation = record.implementation;
  if (!implementation) {
    // No loop record means no workspace was ever claimed. Asking Git about the
    // recorded path anyway would let a run that stopped at planning look like one
    // whose worktree had been deleted, which is a much worse thing to tell a human.
    return {
      state: 'NOT_CREATED',
      path: null,
      recordedBaseSha: record.base?.sha ?? null,
      observedHead: null,
      currentPatchIdentity: null,
      recordedPatchIdentity: null,
      detail: 'This run has no implementation record, so it never prepared a workspace of its own.',
    };
  }

  const primary = path.resolve(input.repo ?? record.local?.toplevel ?? input.cwd);
  const where = path.resolve(primary, implementation.workspace.relativePath);
  const baseSha = implementation.workspace.baseSha;
  const recordedPatchIdentity = newestRecordedPatchOf(record);
  const known = {
    path: where,
    recordedBaseSha: baseSha,
    observedHead: null,
    currentPatchIdentity: null,
    recordedPatchIdentity,
  };

  const presence = await presenceOf(where);
  if (presence === 'GONE') {
    return {
      ...known,
      state: 'MISSING',
      detail:
        'The workspace this run recorded is not there, and MergeSutra will not recreate it. ' +
        'Work a run wrote without committing it cannot be recovered by making the directory.',
    };
  }
  if (presence !== 'HERE') {
    return {
      ...known,
      state: 'UNREADABLE',
      detail:
        'The path this run recorded could not be read at all, so nothing can be said about ' +
        'the work in it. Check its permissions; MergeSutra will not move or replace it.',
    };
  }

  const toplevel = await git(run, where, ['rev-parse', '--show-toplevel']);
  const root = toplevel.code === 0 ? toplevel.stdout.trim() : '';
  if (root.length === 0) {
    return {
      ...known,
      state: 'UNREADABLE',
      detail:
        'There is a directory where this run recorded its workspace, but Git does not ' +
        'recognise it as a workspace, so its contents cannot be described as a patch.',
    };
  }

  const head = await git(run, root, ['rev-parse', '--verify', 'HEAD']);
  const observedHead = head.code === 0 ? head.stdout.trim().toLowerCase() : '';
  if (observedHead.length === 0) {
    return {
      ...known,
      state: 'UNREADABLE',
      detail:
        'Git would not say which commit this workspace stands on, so it cannot be compared ' +
        'with the base this run recorded.',
    };
  }

  if (!(await holdsCommit(run, root, baseSha))) {
    return {
      ...known,
      observedHead,
      state: 'BASE_MISMATCH',
      detail:
        `This repository does not contain commit ${short(baseSha)}, which is the base every ` +
        'document in this run was measured from, so it is not the repository those documents ' +
        'describe. Point the command at the right checkout; MergeSutra will not read another ' +
        'repository as though it were this one.',
    };
  }
  if (observedHead !== baseSha) {
    return {
      ...known,
      observedHead,
      state: 'BASE_MISMATCH',
      detail:
        `This workspace is standing on ${short(observedHead)}, not on the recorded base ` +
        `${short(baseSha)}. MergeSutra will not reset a checkout to make the numbers line up.`,
    };
  }

  let current: string;
  try {
    current = (await describePatch({ workspace: root, baseSha }, { run })).identity;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // The workspace is here and on its base, which is all that can honestly be
    // claimed. The patch is *unknown*, which the graph turns into UNMEASURABLE
    // rather than into "nothing changed".
    return {
      ...known,
      observedHead,
      state: 'PRESENT',
      detail:
        'This workspace is present at the recorded base, but its patch cannot be measured: ' +
        `${bound(error.message)}`,
    };
  }

  if (!recordedPatchIdentity) {
    return {
      ...known,
      observedHead,
      currentPatchIdentity: current,
      state: 'PRESENT',
      detail:
        `The workspace is here at the recorded base and its patch measures ${short(current)}. ` +
        'No stage has recorded a patch identity for it yet, so there is nothing to agree with.',
    };
  }
  if (current === recordedPatchIdentity) {
    return {
      ...known,
      observedHead,
      currentPatchIdentity: current,
      state: 'PRESENT_MATCHED',
      detail: `The bytes here measure ${short(current)}, which is what this run last wrote down.`,
    };
  }
  return {
    ...known,
    observedHead,
    currentPatchIdentity: current,
    state: 'PRESENT_PATCH_CHANGED',
    detail:
      `The bytes here measure ${short(current)}, but this run last described ` +
      `${short(recordedPatchIdentity)}. The files changed after that document was recorded.`,
  };
}

/**
 * The newest thing this run wrote down about the bytes it was looking at.
 *
 * Ordered by what happened last in the lifecycle rather than by timestamp, because
 * a document's *time* says when it was filed and its place in the chain says which
 * bytes it is about: a candidate describes the patch the page was assembled for, a
 * repair execution describes the bytes the loop left behind, and a review describes
 * the ones the reviewer was shown. Anything a run has not reached contributes
 * nothing, which is why a run that only implemented has `null` here and gets the
 * plainer `PRESENT` state rather than a comparison it cannot support.
 */
function newestRecordedPatchOf(record: RunRecord): string | null {
  const publication = record.publications.at(-1);
  if (publication) return publication.candidate.patchIdentity;
  const execution = record.repairExecutions.at(-1);
  if (execution) return execution.patchAfterIdentity;
  return (
    record.review?.reviewedPatchIdentity ??
    record.evidence?.patchIdentity ??
    record.verification?.patchIdentity ??
    null
  );
}

async function presenceOf(directory: string): Promise<'HERE' | 'GONE' | 'UNKNOWN'> {
  try {
    await stat(directory);
    return 'HERE';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'GONE' : 'UNKNOWN';
  }
}

/**
 * Whether a repository holds this run's history, asked of Git rather than guessed
 * from a path.
 *
 * A run's record stores where its workspace was as an absolute path, and that is
 * the least durable fact in it — a person renames a directory, clones to another
 * disk, or runs the command from a different checkout. The commit the run is based
 * on is the durable one: only the repository that has it can hold that run's work,
 * so it is what a moved repository is recognised by. This is not an identity check
 * in the sense of proving two directories are the same project — a clone of a clone
 * passes it — and the states above say only what they can support.
 */
async function holdsCommit(run: Runner, directory: string, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return false;
  const result = await git(run, directory, ['cat-file', '-e', `${commit}^{commit}`]);
  return result.code === 0;
}

function git(run: Runner, directory: string, args: readonly string[]) {
  return run('git', ['-C', directory, ...args]);
}

function short(digest: string): string {
  return digest.slice(0, 12);
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 157)}...`;
}
