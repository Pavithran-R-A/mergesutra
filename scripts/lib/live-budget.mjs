// The live chain's own budget gate, separated from the driver so a test can plant the
// hostile cases against it instead of paying a real run to meet them by accident.
//
// `src/bharatcode/request-budget.ts` is the enforcement: one exclusive marker file per
// completion, refused before the transport. It does not need re-testing here — what this
// module guards is the step before it. A live chain whose ceiling was never installed does
// not fail: it spends as many requests as it likes and then reports the number, because the
// product only counts when it is told to and nothing in the workflow would notice a child
// that lost the two names. These functions are how the driver notices.
//
// Two of the checks below could only be written for a hosted run, and they are the reason
// this file exists at all. GitHub keeps `GITHUB_RUN_ID` across a re-run and gives every
// attempt a fresh ephemeral machine, so a ledger under the runner's temporary directory —
// the one place a job may privately write — is empty at the start of attempt two. The
// placement that makes the ledger safe *within* a run is what makes it unable to outlive
// one. So the count is enforced inside an attempt, and the attempt itself is refused here.
//
// No message returned here carries the ledger path. The driver writes refusals into
// `live-failure.json`, which is uploaded as an artifact and readable by anyone who can read
// the run. A hosted path is innocent, but a local operator's ledger sits wherever their home
// directory is, and an artifact is not the place to publish that.
import path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import process from 'node:process';
import { MAX_MODEL_COMPLETIONS } from './live-qualification.mjs';

/**
 * The names that must never reach a repository-facing child.
 *
 * The budget variables are deliberately absent from this list: a child that cannot
 * authenticate cannot spend, and a child that can must be counted.
 */
export const CREDENTIAL_ENV_NAMES = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
  'BHARATCODE_API_KEY',
  'BHARATCODE_KEY',
  'BHARATCODE_MODEL',
]);

/** Not a reservation: a filesystem probe, named so it can never collide with a marker. */
export const LEDGER_PROBE_FILE = '.mergesutra-ledger-probe';

/** Also not a reservation: the throwaway directory that measures the filesystem's modes. */
export const PERMISSION_REFERENCE_FILE = '.mergesutra-permission-reference';

const GROUP_OR_OTHER = 0o077;

/**
 * The environment the driver hands to one child.
 *
 * `publicGit` marks the children that touch a repository host, a package registry, or a
 * workspace the model wrote. They lose the credential and the token and keep everything else.
 */
export function liveChildEnv({ env, publicGit = false }) {
  const child = { ...env, NO_COLOR: '1' };
  if (publicGit) {
    for (const name of CREDENTIAL_ENV_NAMES) delete child[name];
  }
  return child;
}

/**
 * Would this environment install a ceiling the driver can honour?
 *
 * Every answer is a fact about names, so the whole matrix is testable without a filesystem
 * and without a credential. An empty array is the only green answer.
 */
export function budgetConfigRefusals({ env, ceiling = MAX_MODEL_COMPLETIONS }) {
  const limit = text(env.BHARATCODE_MAX_COMPLETION_REQUESTS);
  const ledger = text(env.BHARATCODE_REQUEST_LEDGER);
  const hosted = text(env.GITHUB_ACTIONS) === 'true';

  if (limit === '' && ledger === '') {
    return [
      'the live chain requires both BHARATCODE_MAX_COMPLETION_REQUESTS and BHARATCODE_REQUEST_LEDGER: ' +
        'without them no request is counted, so the ceiling this run reports is a number nobody enforced',
    ];
  }
  if (limit === '') {
    return [
      'BHARATCODE_REQUEST_LEDGER is set without BHARATCODE_MAX_COMPLETION_REQUESTS, so nothing would be ' +
        'counted against it',
    ];
  }
  if (ledger === '') {
    return [
      'BHARATCODE_MAX_COMPLETION_REQUESTS is set without BHARATCODE_REQUEST_LEDGER, which is a ceiling ' +
        'with nowhere to count',
    ];
  }

  const refusals = [];
  const wanted = Number(limit);
  if (!Number.isInteger(wanted) || wanted !== ceiling) {
    refusals.push(
      `BHARATCODE_MAX_COMPLETION_REQUESTS is ${quote(limit)}, but this chain's ceiling is ${String(
        ceiling,
      )}: the same number is what the qualification rules measure after the run, so a guard pinned to any ` +
        'other value enforces a budget the report does not describe',
    );
  }

  if (!path.isAbsolute(ledger)) {
    refusals.push(
      'BHARATCODE_REQUEST_LEDGER must be an absolute path and the configured value is not: the stages of a ' +
        'live chain run from the repository root while an implementation runs from its worktree, so a ' +
        'relative ledger becomes one counter per working directory',
    );
  }

  const retries = text(env.BHARATCODE_MAX_RETRIES);
  if (retries !== '0') {
    refusals.push(
      `BHARATCODE_MAX_RETRIES is ${quote(retries)}, and the live chain pins it to 0: every retry attempt ` +
        'pays for a slot of its own, so a retrying run spends the allowance on requests nobody asked for',
    );
  }

  if (hosted) {
    const attempt = text(env.GITHUB_RUN_ATTEMPT);
    if (attempt !== '1') {
      refusals.push(
        `GITHUB_RUN_ATTEMPT is ${quote(attempt)}, not 1: a re-run is handed a fresh ephemeral runner, so ` +
          'its ledger starts empty and would give this same run another full ceiling of requests. The ' +
          'budget is enforced inside an attempt, and the attempt is refused rather than re-counted',
      );
    }
    const runnerTemp = text(env.RUNNER_TEMP);
    if (runnerTemp === '') {
      refusals.push(
        'this is a GitHub Actions run but RUNNER_TEMP is unset, so the ledger cannot be placed where only ' +
          'this job can reach it',
      );
    } else if (path.resolve(ledger) === path.resolve(runnerTemp)) {
      refusals.push(
        'BHARATCODE_REQUEST_LEDGER is RUNNER_TEMP itself: the count needs a directory of its own, so the ' +
          'ledger is not the place the job writes everything else',
      );
    } else if (!isInside(runnerTemp, ledger)) {
      refusals.push(
        'BHARATCODE_REQUEST_LEDGER is outside RUNNER_TEMP: the workspace is written by the model under ' +
          'review, so a ledger inside it could be edited by the code whose spending the ledger bounds',
      );
    }
  }

  return refusals;
}

/**
 * Can this directory be trusted to hold a count?
 *
 * Four questions, in the order a hostile machine would try to avoid them: what already sits
 * at the path, whether the directory can be created and written, whether the filesystem
 * honours exclusive creation at all, and whether it can keep the directory private. The last
 * one is measured rather than assumed, and its answer separates a refusal from a disclosure —
 * a filesystem that reports the same mode for every directory is not an unsafe ledger, it is
 * a check that could not run, and calling that a pass would be the lie.
 *
 * `fs` is `node:fs/promises` unless a test hands in a filesystem that behaves in a way no
 * local host can be made to behave.
 *
 * The probe creates the ledger if it is absent, which is what the reservation does too, and
 * it removes only the two names it chose for itself: a reservation marker is somebody's
 * already-spent request, and a preflight that could empty the ledger is a preflight that can
 * refund it.
 */
export async function ledgerRefusals({ ledger, fs = nodeFs }) {
  const notes = [];

  if (typeof ledger !== 'string' || ledger === '' || !path.isAbsolute(ledger)) {
    return {
      refusals: [
        'BHARATCODE_REQUEST_LEDGER must be an absolute path and the configured value is not',
      ],
      notes,
    };
  }

  // A missing ledger is the normal start of a run, so this is not an inspection failure — it is
  // the answer that says "create it". POSIX gives the same instruction a second way: when part of
  // the path exists and is not a directory, `lstat` answers ENOTDIR rather than the ENOENT a
  // Windows host answers, and both mean that there is no ledger directory here yet. Treating only
  // one of them as "create it" left a Linux runner describing an uncreatable path as uninspectable
  // — the run was still refused before the first request, but with a reason an operator could not
  // act on. Every other code is a genuine inspection failure: an unreadable path, a symlink loop or
  // an access denial each mean the count below is not what the guard thinks it is, and none of them
  // can be reasoned around from here.
  const absentCodes = new Set(['ENOENT', 'ENOTDIR']);
  const before = await probe(fs.lstat, ledger);
  if (before.error && !absentCodes.has(codeOf(before.error))) {
    return {
      refusals: [
        `the ledger could not be inspected before the first request (code ${codeOf(before.error)})`,
      ],
      notes,
    };
  }
  if (before.value?.isSymbolicLink()) {
    return {
      refusals: [
        'BHARATCODE_REQUEST_LEDGER is a symbolic link: whoever controls where it points controls which ' +
          'directory holds the count, and the count is the ceiling',
      ],
      notes,
    };
  }
  if (before.value && !before.value.isDirectory()) {
    return {
      refusals: [
        'BHARATCODE_REQUEST_LEDGER names something that is not a directory, so no request could be counted',
      ],
      notes,
    };
  }

  const created = await probe((at) => fs.mkdir(at, { recursive: true, mode: 0o700 }), ledger);
  if (created.error) {
    return {
      refusals: [
        `the ledger directory could not be created (code ${codeOf(created.error)}), so this chain cannot ` +
          'count its requests and is refusing to send any',
      ],
      notes,
    };
  }
  // The path can have been replaced between the first read and the create. Re-reading is not
  // paranoia for its own sake: four processes write into this directory, and anything that
  // can swap a link here is standing in the same place as the run.
  const after = await probe(fs.lstat, ledger);
  if (after.error || !after.value?.isDirectory() || after.value.isSymbolicLink()) {
    return {
      refusals: [
        `the ledger is not a real directory this process owns (code ${
          codeOf(after.error) ?? 're-checked'
        })`,
      ],
      notes,
    };
  }

  // Drop a probe left behind by an interrupted preflight, then prove that two writes to the
  // same name cannot both succeed. `unlink` here targets a name this module chose; it is
  // never a reservation marker.
  const probeFile = path.join(ledger, LEDGER_PROBE_FILE);
  await probe((at) => fs.unlink(at), probeFile);
  const first = await probe(
    (at) => fs.writeFile(at, `${String(process.pid)}\n`, { flag: 'wx' }),
    probeFile,
  );
  if (first.error) {
    return {
      refusals: [
        `the ledger directory could not be written (code ${codeOf(first.error)}), so the request count ` +
          'could not be recorded and this chain refuses to spend',
      ],
      notes,
    };
  }
  const second = await probe((at) => fs.writeFile(at, 'second', { flag: 'wx' }), probeFile);
  if (!second.error || codeOf(second.error) !== 'EEXIST') {
    return {
      refusals: [
        'the filesystem holding BHARATCODE_REQUEST_LEDGER does not honour exclusive creation: a second ' +
          'write to the same name was accepted, so two requests racing for the last slot could both take ' +
          'it and the ceiling would be a suggestion',
      ],
      notes,
    };
  }
  await probe((at) => fs.unlink(at), probeFile);

  const privacy = await measurePrivacy(fs, ledger);
  if (privacy.measurable && (privacy.ledgerMode & GROUP_OR_OTHER) !== 0) {
    return {
      refusals: [
        `the ledger directory is readable or writable by group or other (mode ${modeOf(
          privacy.ledgerMode,
        )}): another account on this machine could delete the markers and reset the count mid-run`,
      ],
      notes,
    };
  }
  if (!privacy.measurable) {
    notes.push(
      'the permission-bit check could not run on the filesystem holding this ledger: every directory ' +
        'there reports group or other access, so those bits say nothing about who can reach the count. The ' +
        'absolute-path, placement and exclusive-creation checks still ran',
    );
  }

  return { refusals: [], notes };
}

/**
 * Does this filesystem model POSIX permission bits?
 *
 * Answered by measurement rather than by `process.platform`: a directory created here with
 * mode 0o700 is read back, and if the read-back still shows group or other access then the
 * filesystem is not modelling the bits — Windows and any FAT-like mount report a constant,
 * which this host reproduces without being asked. Only when the measurement discriminates
 * does the ledger's own mode say anything about safety.
 */
async function measurePrivacy(fs, ledger) {
  const reference = path.join(path.dirname(ledger), PERMISSION_REFERENCE_FILE);
  const made = await probe((at) => fs.mkdir(at, { recursive: true, mode: 0o700 }), reference);
  if (made.error) return { measurable: false, ledgerMode: 0 };
  const referenceStat = await probe(fs.lstat, reference);
  const ledgerStat = await probe(fs.lstat, ledger);
  await probe((at) => fs.rmdir(at), reference);
  if (referenceStat.error || !referenceStat.value || ledgerStat.error || !ledgerStat.value) {
    return { measurable: false, ledgerMode: 0 };
  }
  return {
    measurable: (referenceStat.value.mode & GROUP_OR_OTHER) === 0,
    ledgerMode: ledgerStat.value.mode,
  };
}

async function probe(fn, argument) {
  try {
    return { value: await fn(argument), error: null };
  } catch (error) {
    return { value: undefined, error };
  }
}

function codeOf(error) {
  return error && typeof error.code === 'string' ? error.code : 'unknown';
}

function modeOf(mode) {
  return (mode & 0o777).toString(8);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function quote(value) {
  return value === '' ? '<unset>' : `'${value}'`;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
