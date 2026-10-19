/**
 * The rules that decide whether the Stage 17 customer qualification may be
 * called a hosted release gate.
 *
 * The harness already refuses a bad scenario, so a gate that only read the
 * harness's own exit code would be trusting the thing it is meant to check: a
 * summary written by an earlier commit, an empty scenario list, a row whose
 * verdict was relabelled, or an oracle that silently stopped running all look
 * like a green job. These rules read the bytes of `summary.json` and name the
 * specific claim each one fails to support.
 *
 * The library is pure — no filesystem, no child process — because the hosted
 * gate has to be able to answer "would this summary be certified?" for a record
 * it is about to reject, and because the same rules are exercised against
 * deliberately falsified summaries in tests/security.
 */

export const CUSTOMER_SCENARIOS = [
  'journey',
  'failed-assertion',
  'interruption',
  'repair',
  'stale-patch',
  'forged-metadata',
  'no-sandbox',
  'repeated',
];

/**
 * The journeys that end with the customer's issue actually solved.
 *
 * A run that recovers from an interruption or a repair is only worth reporting if
 * the bytes it lands on are correct — a recovery that returns a still-broken patch
 * is a failure with extra steps. The four that deliberately stop early
 * (`failed-assertion`, `stale-patch`, `forged-metadata`, `no-sandbox`) are judged
 * on the stop, and their oracle rows are recorded, not required.
 */
export const ORACLE_MUST_PASS = ['journey', 'interruption', 'repair', 'repeated'];

/** One row per documented acceptance criterion — five, or the oracle did not run. */
export const ORACLE_CRITERIA = [
  'ORACLE-AC-1',
  'ORACLE-AC-2',
  'ORACLE-AC-3',
  'ORACLE-AC-4',
  'ORACLE-AC-5',
];

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST_IMAGE = /^node@sha256:[0-9a-f]{64}$/;

/**
 * @param {unknown} summary the parsed `summary.json` the harness wrote
 * @param {{revision?: string, sandboxImage?: string, notBefore?: string|number, now?: string|number}} expected
 *   what the surrounding job knows about itself: the commit it checked out, the image it
 *   preloaded, when the run began and when the gate is reading. A missing value is a gate
 *   failure, not an unchecked rule — otherwise forgetting to set one would certify anything.
 * @returns {string[]} one sentence per unsupported claim, empty only when the summary is certifiable
 */
export function customerGateFailures(summary, expected = {}) {
  const failures = [];
  if (!isObject(summary)) {
    return ['the customer gate received no summary to read, so nothing was certified'];
  }
  if (!Array.isArray(summary.scenarios)) {
    return ['the summary records no scenario list, so no customer journey was run'];
  }

  checkScenarioList(summary.scenarios, failures);
  for (const record of summary.scenarios) checkScenario(record, failures);
  checkVersion(summary, failures);
  checkIdentity(summary.identity, expected, failures);
  checkFreshness(summary, expected, failures);
  return failures;
}

function checkScenarioList(scenarios, failures) {
  const names = [];
  for (const record of scenarios) names.push(isObject(record) ? String(record.scenario ?? '') : '');
  for (const name of CUSTOMER_SCENARIOS) {
    const hits = names.filter((candidate) => candidate === name).length;
    if (hits === 0) failures.push(`scenario ${name} was not run by this summary`);
    if (hits > 1) failures.push(`scenario ${name} appears twice in the summary`);
  }
  for (const name of names) {
    if (name && !CUSTOMER_SCENARIOS.includes(name)) {
      failures.push(`scenario ${name} is not one of the eight documented customer journeys`);
    }
    if (!name) failures.push('the summary holds a scenario row with no name');
  }
}

function checkScenario(record, failures) {
  if (!isObject(record)) {
    failures.push('the summary holds a scenario row that is not an object');
    return;
  }
  const label = `scenario ${String(record.scenario ?? '<unnamed>')}`;
  if (record.verdict !== 'PASS') {
    failures.push(`${label} verdict is ${String(record.verdict)}, not PASS`);
    return;
  }
  // A PASS that carries its own objections is the relabelling this gate exists for.
  const problems = Array.isArray(record.problems) ? record.problems.filter(Boolean) : [];
  if (problems.length > 0) {
    failures.push(`${label} claims PASS but recorded problems: ${problems.join(' | ')}`);
  }
  const damage = Array.isArray(record.damage) ? record.damage.filter(Boolean) : [];
  if (damage.length > 0) {
    failures.push(`${label} claims PASS with customer checkout damage: ${damage.join(' | ')}`);
  }
  const secrets = Array.isArray(record.secrets) ? record.secrets.filter(Boolean) : [];
  if (secrets.length > 0) {
    failures.push(`${label} claims PASS with credential-shaped evidence in ${secrets.join(' | ')}`);
  }
  checkExitCodes(record, label, failures);
  checkOracle(record, label, failures);
  checkCleanup(record, label, failures);
}

/**
 * That the harness removed the workspace it created, not merely that it said so.
 *
 * A hosted job runs on someone else's disk and is only allowed to leave behind the
 * artifact it uploads, so `cleanup` is the scenario's own report of its housekeeping:
 * written in the `finally` that every real run reaches. A row without it either came
 * from a build predating the field or was assembled by hand; either way the job has
 * no evidence that the disposable clone, its gitdir and its node_modules went away.
 */
function checkCleanup(record, label, failures) {
  const cleanup = isObject(record.cleanup) ? record.cleanup : null;
  if (cleanup === null) {
    failures.push(
      `${label} claims PASS but records no workspace cleanup, so this run never proved it removed what it created`,
    );
    return;
  }
  if (cleanup.removed !== true || cleanup.remaining !== 0) {
    failures.push(
      `${label} claims PASS but left ${String(cleanup.remaining)} file(s) of its own disposable workspace behind (${String(cleanup.lastError ?? 'no error recorded')})`,
    );
  }
}

/**
 * An exit code read from a process, not from a pipeline.
 *
 * A number is the ordinary case. `null` is only certifiable when the row names the
 * signal that ended the child, because the interruption journey kills a real CLI
 * process on purpose and a killed process reports no status by definition — a rule
 * that refused every null would reject the one scenario that proves recovery works.
 * Naming the signal is what makes the exception honest: it is a second reading of the
 * same `close` event, so a row that claims a kill without one is still an unobserved
 * exit. A stage that hit its deadline is the opposite of an observation — the process
 * was still running when the harness gave up on it — so it is refused even though the
 * harness recorded it just as faithfully.
 */
function checkExitCodes(record, label, failures) {
  const rows = Array.isArray(record.exitCodes) ? record.exitCodes : [];
  if (rows.length === 0) {
    failures.push(`${label} recorded no stage exit codes, so no CLI stage was observed`);
    return;
  }
  for (const row of rows) {
    const text = String(row);
    const index = text.lastIndexOf('=');
    const stage = index < 0 ? text : text.slice(0, index);
    const code = index < 0 ? '' : text.slice(index + 1);
    if (/^-?\d+$/.test(code)) continue;
    const killed = /^null\(killed:[A-Z]+\)$/.exec(code);
    if (killed === null && /^null\(timed out after \d+ms\)$/.test(code)) {
      failures.push(
        `${label} stage ${stage} was still running when its deadline expired (${code}), so the run was not bounded`,
      );
    } else if (killed === null && (code === '' || code === 'null' || code === 'undefined')) {
      failures.push(`${label} stage ${stage} has no exit code read from a process (${code})`);
    } else if (killed === null) {
      failures.push(`${label} stage ${stage} reported an exit code that is not a number (${code})`);
    }
  }
}

/**
 * The independent oracle lives outside the workspace the model can write. Five rows
 * or none: a scenario that reached the end without an oracle row per criterion is a
 * gate that stopped checking, which is precisely the failure a green job hides.
 */
function checkOracle(record, label, failures) {
  const rows = Array.isArray(record.oracle) ? record.oracle : [];
  if (rows.length === 0) {
    failures.push(`${label} has no independent oracle rows, so acceptance was never checked`);
    return;
  }
  const ids = rows.map((row) => (isObject(row) ? String(row.id ?? '') : ''));
  for (const id of ORACLE_CRITERIA) {
    const hits = ids.filter((candidate) => candidate === id).length;
    if (hits === 0) {
      failures.push(
        `${label} oracle is missing ${id}; it recorded ${String(rows.length)} rows, not the ${String(ORACLE_CRITERIA.length)} documented criteria`,
      );
    }
    if (hits > 1) failures.push(`${label} oracle recorded ${id} ${String(hits)} times`);
  }
  for (const id of ids) {
    if (id && !ORACLE_CRITERIA.includes(id)) {
      failures.push(`${label} oracle judged an undocumented criterion ${id}`);
    }
  }
  if (ORACLE_MUST_PASS.includes(String(record.scenario ?? ''))) {
    for (const row of rows) {
      const verdict = isObject(row) ? String(row.verdict ?? '') : '';
      if (verdict !== 'PASS') {
        failures.push(
          `${label} oracle row ${String(row && isObject(row) ? row.id : '<unnamed>')} is ${verdict || 'unverdicted'}, and this journey needs all five criteria to pass`,
        );
      }
    }
  }
}

function checkVersion(summary, failures) {
  const version = typeof summary.mergeSutraVersion === 'string' ? summary.mergeSutraVersion : '';
  if (version.trim() === '') {
    failures.push('the summary records no MergeSutra version, so its CLI build is unnamed');
  }
}

function checkIdentity(identity, expected, failures) {
  if (!isObject(identity)) {
    failures.push(
      'the summary records no run identity, so its evidence cannot be bound to a build',
    );
    return;
  }
  const revision = typeof identity.revision === 'string' ? identity.revision : '';
  if (!FULL_SHA.test(revision)) {
    failures.push(
      `the summary's identity.revision is not a full 40-character commit SHA (${revision || '<absent>'})`,
    );
  } else if (!text(expected.revision)) {
    failures.push(
      'the gate was not given the revision to match, so it cannot bind this evidence to the checked-out commit',
    );
  } else if (revision !== expected.revision) {
    failures.push(
      `the summary certifies revision ${revision}, not the revision this job checked out (${String(expected.revision)})`,
    );
  }

  const image = typeof identity.sandboxImage === 'string' ? identity.sandboxImage : '';
  if (image === '') {
    failures.push('the summary records no sandbox image, so repository gates ran uncontainered');
  } else if (!DIGEST_IMAGE.test(image)) {
    failures.push(`the summary's sandbox image ${image} is not pinned to an immutable digest`);
  } else if (!text(expected.sandboxImage)) {
    failures.push(
      'the gate was not given the sandbox image to match, so it cannot bind this evidence to a container',
    );
  } else if (image !== expected.sandboxImage) {
    failures.push(
      `the summary ran repository gates in sandbox image ${image}, not the image this job preloaded (${String(expected.sandboxImage)})`,
    );
  }

  const fixture = typeof identity.fixtureBaseSha === 'string' ? identity.fixtureBaseSha : '';
  if (fixture === '') {
    failures.push('the summary records no fixture base SHA, so the customer history is unnamed');
  } else if (!FULL_SHA.test(fixture)) {
    failures.push(
      `the summary's fixture base SHA is not a full 40-character commit SHA (${fixture})`,
    );
  }

  if (!text(identity.platform)) {
    failures.push('the summary records no platform identity');
  }
  if (!text(identity.nodeVersion)) {
    failures.push('the summary records no Node runtime identity');
  }
}

/**
 * Freshness, which is the only defence against a green job reading a stale artifact.
 * The summary must sit inside the window the job itself knows about: started after the
 * checkout it claims, finished before the gate read it.
 */
function checkFreshness(summary, expected, failures) {
  const started = readTime(summary.startedAt);
  if (started === null) {
    failures.push(
      `the summary's startedAt is not a readable timestamp (${String(summary.startedAt ?? '<absent>')})`,
    );
  }
  const finished = readTime(summary.finishedAt);
  if (summary.finishedAt === undefined || summary.finishedAt === null) {
    failures.push('the summary records no finishedAt, so the run was cut short before it ended');
  } else if (finished === null) {
    failures.push(
      `the summary's finishedAt is not a readable timestamp (${String(summary.finishedAt)})`,
    );
  }

  const notBefore = readTime(expected.notBefore);
  if (
    expected.notBefore === undefined ||
    expected.notBefore === null ||
    expected.notBefore === ''
  ) {
    failures.push(
      'the gate was not given the time this run started, so evidence written before it could pass',
    );
  } else if (notBefore === null) {
    failures.push(
      `the gate's notBefore is not a readable timestamp (${String(expected.notBefore)})`,
    );
  } else if (started !== null && started < notBefore) {
    failures.push(
      `the summary started at ${String(summary.startedAt)}, before this gate's run began at ${String(expected.notBefore)}, so it may be evidence from an earlier run`,
    );
  }

  const now = readTime(expected.now);
  if (expected.now === undefined || expected.now === null || expected.now === '') {
    failures.push('the gate was not given the current time, so it cannot bound the evidence');
  } else if (now !== null && finished !== null && finished > now) {
    failures.push(
      `the summary finished at ${String(summary.finishedAt)}, after the gate read it at ${String(expected.now)}`,
    );
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function readTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
