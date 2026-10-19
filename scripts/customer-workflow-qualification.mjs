#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, cp, readFile, readdir, rm, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_BASE_SHA,
  CUSTOMER_ISSUE_URL,
  CUSTOMER_REPOSITORY_URL,
  buildCustomerEnvironment,
  customerState,
  git,
  independentPatchIdentity,
  normalizePath,
  parseWorktrees,
  rederiveProductPatchIdentity,
  trackedSnapshot,
} from './lib/customer-environment.mjs';
import { runCustomerOracle } from './lib/customer-oracle.mjs';
import { digestForPath, startScriptedGateway } from './lib/scripted-gateway.mjs';

/**
 * Stage 17 — does an ordinary customer get all the way through this product?
 *
 * Everything else in this repository qualifies a *part*. This script runs the
 * whole thing as a person would: it clones a real repository over the network,
 * puts the working checkout in a real linked worktree, files nothing and edits
 * nothing by hand, and then calls the compiled CLI as a child process for every
 * stage in the documented order. The model is replaced by a scripted HTTP
 * endpoint so the workflow is reproducible and no API credit is spent — which
 * qualifies the workflow, and says deliberately nothing about the model.
 *
 * Three promises the measurements are built to keep:
 *
 * - the customer is not damaged. Every scenario snapshots the tracked bytes, the
 *   branch, HEAD, the dirty state, the worktree registration and the shared Git
 *   metadata before and after, and fails if any of them moved outside the run's
 *   own workspace;
 * - a green result means something. Acceptance is decided by an oracle that lives
 *   outside the workspace the model can write, and the patch is measured a second
 *   time by Git itself rather than only by the digest MergeSutra computed;
 * - an exit code is read from the process, not from a pipeline, and a refusal is
 *   recorded as a refusal. Scenario 2 and scenario 7 want the product to *stop*,
 *   and a product that refused everything would pass them — which is exactly why
 *   scenario 1 has to reach the end.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'dist', 'bin.js');
const EXPORT_ROOT = path.join(ROOT, '.mergesutra', 'customer-qualification');
const DEFAULT_IMAGE =
  'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';
const SCRIPTED_MODEL = 'scripted-customer-model';
const SCENARIOS = [
  'journey',
  'failed-assertion',
  'interruption',
  'repair',
  'stale-patch',
  'forged-metadata',
  'no-sandbox',
  'repeated',
];

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const only = requested.length > 0 ? requested : SCENARIOS;
const unknown = only.find((name) => !SCENARIOS.includes(name));
if (unknown) {
  process.stderr.write(
    `unknown scenario: ${unknown}\nusage: node scripts/customer-workflow-qualification.mjs [${SCENARIOS.join('|')}]\n`,
  );
  process.exitCode = 64;
}

/** The scripted replacement for the customer's own module, and for its tests. */
const FIXED_SLUGIFY = `/**
 * Turn a title into a URL slug.
 *
 * Lowercase, each run of non-alphanumeric characters becomes a single hyphen,
 * and the hyphens left by leading or trailing separators are trimmed away.
 */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

/** The same fix with only the leading edge trimmed — the incomplete patch. */
const HALF_SLUGIFY = `export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '');
}
`;

const FULL_TESTS = `import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../src/slugify.js';

test('lowercases the input', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses a run of separators into one hyphen', () => {
  assert.equal(slugify('a--b'), 'a-b');
});

test('replaces punctuation with a hyphen', () => {
  assert.equal(slugify('a.b,c'), 'a-b-c');
});

test('trims hyphens left by surrounding spaces', () => {
  assert.equal(slugify('  Hello  World  '), 'hello-world');
});

test('keeps a collapsed run between words', () => {
  assert.equal(slugify('a--b'), 'a-b');
});

test('trims hyphens from both ends of a punctuation-wrapped title', () => {
  assert.equal(slugify('--x--'), 'x');
});
`;

const HALF_TESTS = FULL_TESTS.replace(
  "test('trims hyphens from both ends of a punctuation-wrapped title', () => {\n  assert.equal(slugify('--x--'), 'x');\n});",
  "test('trims hyphens from both ends of a punctuation-wrapped title', () => {\n  assert.equal(slugify('--x--'), '-x');\n});",
);

/**
 * A suite that is green against the half-fix and therefore incomplete.
 *
 * `HALF_TESTS` expects `-x` and so fails; this one simply never asks about the two
 * criteria the half-fix misses, which is the customer situation the reviewer
 * journey exists for: `npm test` exits `0`, the repository's own gate is
 * satisfied, and criteria 1 and 3 of the issue are still unmet. Nothing here
 * blesses the buggy value — the gap is an omitted case, because a repair that
 * *changes* a baseline assertion is refused by the write guard by design, and this
 * journey has to end with the gap actually closed. Only an oracle outside the
 * workspace, or a reviewer reading the diff, can see it.
 */
const GREEN_TESTS = `import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../src/slugify.js';

test('lowercases the input', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses a run of separators into one hyphen', () => {
  assert.equal(slugify('a--b'), 'a-b');
});

test('replaces punctuation with a hyphen', () => {
  assert.equal(slugify('a.b,c'), 'a-b-c');
});
`;

/** The same file after the repair: the three cases above, plus the two that were missing. */
const REPAIRED_TESTS = `${GREEN_TESTS}
test('trims the hyphens left by surrounding spaces', () => {
  assert.equal(slugify('  Hello  World  '), 'hello-world');
});

test('trims hyphens from both ends of a punctuation-wrapped title', () => {
  assert.equal(slugify('--x--'), 'x');
});
`;

/** The only two files a correct run on this issue may have changed. */
const EXPECTED_PATCH_FILES = ['src/slugify.js', 'test/slugify.test.js'];

/**
 * The requirement this qualification states rather than copies, and the command
 * that proves it.
 *
 * Every criterion lifted out of the issue arrives with a `manual` verification
 * step, which Stage 7 honestly reports as needing a human — so before Stage 17
 * no customer run had put a machine-proven PASS on a criterion at all. The
 * operator route is the one that can, and it was only ever proven in a unit
 * test. This row drives it through the real chain so the journey evidence shows
 * a bound criterion reaching VERIFIED against the repository's own gate.
 */
const OPERATOR_CRITERION = "The repository's own npm test suite passes on the run branch.";
const OPERATOR_CHECK = 'npm test';
const OPERATOR_BY = 'Stage 17 qualification operator';

/**
 * The half of AC-5 that GitHub's ~80-column wrap put on an indented continuation
 * line. Stage 17 found the contract handing over "… devDependencies — this is a"
 * and nothing after it; the tail is what a reader checks to see the wrap folded
 * back in.
 */
const AC5_WRAPPED_TAIL = 'five-line change, not a new library.';

async function runRequested(names) {
  mkdirSync(EXPORT_ROOT, { recursive: true });
  const summary = {
    startedAt: new Date().toISOString(),
    mergeSutraVersion: version(),
    scenarios: [],
  };
  let failed = 0;
  for (const name of names) {
    const outcome = await runScenario(name).catch((error) => ({
      scenario: name,
      verdict: 'ERROR',
      reason: error instanceof Error ? error.message : String(error),
    }));
    summary.scenarios.push(outcome);
    if (outcome.verdict !== 'PASS') failed += 1;
    process.stdout.write(
      `SCENARIO ${name}: ${outcome.verdict}\n${(
        outcome.problems ?? (outcome.reason ? [outcome.reason] : [])
      )
        .map((problem) => `  - ${problem}\n`)
        .join('')}`,
    );
  }
  summary.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(EXPORT_ROOT, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
    'utf8',
  );
  process.stdout.write(
    `CUSTOMER_WORKFLOW_${failed === 0 ? 'PASS' : 'FAIL'} scenarios=${String(names.length)} notPass=${String(failed)}\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

function version() {
  const run = spawnSync(process.execPath, [BIN, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return (run.stdout ?? '').trim();
}

/* ------------------------------------------------------------------ scenarios */

const SCENARIO_RUNNERS = {
  journey: scenarioJourney,
  'failed-assertion': scenarioFailedAssertion,
  interruption: scenarioInterruption,
  repair: scenarioRepair,
  'stale-patch': scenarioStalePatch,
  'forged-metadata': scenarioForgedMetadata,
  'no-sandbox': scenarioNoSandbox,
  repeated: scenarioRepeated,
};

/**
 * The scenarios that end with the customer's issue actually solved.
 *
 * A run that recovers from an interruption or a repair is only worth reporting if
 * the bytes it lands on are correct — a recovery that returns a still-broken patch
 * is a failure with extra steps. The three that deliberately stop early
 * (`failed-assertion`, `stale-patch`, `forged-metadata`, `no-sandbox`) are judged
 * on the stop, and their oracle rows are recorded, not required.
 */
const ORACLE_MUST_PASS = ['journey', 'interruption', 'repair', 'repeated'];

async function runScenario(name) {
  const root = await mkdtemp(path.join(tmpdir(), `mergesutra-s17-${name}-`));
  const logRoot = path.join(EXPORT_ROOT, name);
  const clearedExport = await removeTree(logRoot);
  mkdirSync(logRoot, { recursive: true });
  const journal = createJournal(logRoot);

  try {
    const environment = await buildCustomerEnvironment({
      root,
      onFail: (message) => {
        throw new Error(message);
      },
    });
    const before = await customerState(environment);
    journal.write('environment.json', {
      customerRepository: CUSTOMER_REPOSITORY_URL,
      customerIssue: CUSTOMER_ISSUE_URL,
      pinnedBaseSha: CUSTOMER_BASE_SHA,
      history: environment.history,
      primaryCheckout: environment.workspace,
      primaryCheckoutIsLinkedWorktree: true,
      gitdirPointer: environment.gitdirPointer,
      trackedFiles: before.workspaceTracked,
      sandboxImage: sandboxImage(),
    });

    const result = await SCENARIO_RUNNERS[name]({ environment, journal, root });
    const after = await customerState(environment);
    const damage = customerDamage(before, after, environment);
    // Both sides of the comparison, not just the verdict. `damage` says nothing
    // was found; only the bytes either side of the run let a reader check that
    // the check looked at something.
    journal.write('damage.json', { before, after, damage });
    const exported = await exportRunEvidence(environment, logRoot);
    const oracle = await runCustomerOracle({
      workspace: result.oracleWorkspace ?? environment.workspace,
      npmCache: path.join(root, 'oracle-npm-cache'),
    });
    const secrets = await scanEvidence(logRoot);
    const problems = [
      ...(!clearedExport.ok
        ? [
            `${clearedExport.remaining} file(s) of an earlier export of this scenario survived cleanup (${clearedExport.lastError}), so ${path.basename(logRoot)}/ may mix two runs`,
          ]
        : []),
      ...(!result.ok ? [result.reason || 'the scenario did not reach its expected outcome'] : []),
      ...damage.map((problem) => `customer damage: ${problem}`),
      ...secrets.map((file) => `credential-shaped text in ${file}`),
      ...(ORACLE_MUST_PASS.includes(name) && !oracle.passed
        ? [`the independent oracle rejected the final bytes: ${oracleFailures(oracle)}`]
        : []),
    ];
    return {
      scenario: name,
      verdict: problems.length === 0 ? 'PASS' : 'FAIL',
      reason: result.ok ? result.reason : result.reason || 'failed',
      problems,
      observations: result.observations ?? {},
      exitCodes: journal.exitCodes(),
      oracle: oracle.results,
      stages: journal.stages,
      damage,
      productStateFiles: exported.length,
      secrets,
    };
  } finally {
    // A disposable directory this script created, left behind on a disk with
    // gigabytes free, is this harness's problem, not the product's — so it is
    // said out loud rather than hidden by a swallowed error.
    const cleanup = await removeTree(root);
    if (!cleanup.ok) {
      process.stderr.write(
        `warning: disposable workspace not removed: ${root} (${cleanup.remaining} file(s) left, ${cleanup.lastError})\n`,
      );
    }
  }
}

/**
 * Delete a tree this harness created, waiting for the operating system to let go.
 *
 * A scenario's disposable workspace is the working directory of processes the
 * product spawned — a gate container, an `npm test` — and Windows keeps the
 * directory claimed until the last of those has finished going away, which is a
 * moment or two after the CLI this harness waited for has already exited. That
 * delay belongs to this script's own housekeeping, not to the product, so the
 * answer is to wait and retry with a bound, and to report what is left rather
 * than to claim a reason this script cannot observe. The bound is what this host
 * needs: an export directory whose run had been over for two full minutes still
 * refused `rmdir` for the whole of a six-second budget and went on the next try,
 * so twelve half-seconds is measured-not-enough, not a product symptom.
 */
async function removeTree(target) {
  // The cause is part of the answer. On Windows a directory that is some live
  // process's working directory cannot be removed at all, and an EBUSY here has
  // exactly one useful response — find out who is standing in it — so a bare count
  // would send the next reader hunting for a lock that does not exist.
  let lastError = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    lastError = await rm(target, { recursive: true, force: true }).catch((error) => error);
    const remaining = await readdir(target, { recursive: true }).catch(() => null);
    if (remaining === null || remaining.length === 0)
      return { ok: true, remaining: 0, lastError: null };
    await sleep(500);
  }
  const left = await readdir(target, { recursive: true }).catch(() => ['unreadable']);
  return {
    ok: false,
    remaining: left.length,
    lastError: lastError ? `${lastError.code ?? 'ERROR'} ${lastError.syscall ?? ''}` : 'no error',
  };
}

function oracleFailures(oracle) {
  return oracle.results
    .filter((entry) => entry.verdict !== 'PASS')
    .map((entry) => `${entry.id} ${entry.verdict}: ${entry.detail}`)
    .join('; ');
}

/**
 * Copy what the product itself left behind, before the disposable workspace goes.
 *
 * The scenario's logs record what each stage printed; they are not the run's own
 * evidence. The run store, the evidence pack and the run worktree are what a
 * reviewer would reopen, and the temp directory is deleted at the end of every
 * scenario, so the copy is the only way this qualification can cite the pack a
 * run actually wrote instead of a paraphrase of it.
 */
async function exportRunEvidence(environment, logRoot) {
  const dir = path.join(environment.workspace, '.mergesutra');
  const entries = await readdir(dir, { recursive: true }).catch(() => []);
  if (entries.length === 0) {
    await writeFile(
      path.join(logRoot, 'product-state-manifest.json'),
      JSON.stringify({ present: false, note: `${normalizePath(dir)} held no files` }, null, 2) +
        '\n',
      'utf8',
    );
    return [];
  }
  await cp(dir, path.join(logRoot, 'product-state'), { recursive: true, force: true });
  const manifest = {
    present: true,
    source: normalizePath(dir),
    files: entries.map((entry) => path.relative(dir, String(entry)).replaceAll('\\', '/')).sort(),
  };
  await writeFile(
    path.join(logRoot, 'product-state-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  return manifest.files;
}

/**
 * Read every byte this scenario wrote as evidence and look for a credential in it.
 *
 * The logs travel to the security register and, in the customer's hands, to their
 * own issue tracker — so a token that survived redaction anywhere in the pack or
 * the transcripts would be this qualification's failure, not a later one's.
 */
async function scanEvidence(logRoot) {
  const found = [];
  const names = await readdir(logRoot, { recursive: true }).catch(() => []);
  for (const name of names) {
    const file = path.join(logRoot, String(name));
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (leaked(text)) found.push(path.relative(logRoot, file).replaceAll('\\', '/'));
  }
  return found;
}

/** The full documented chain, ending in a locally approved publication candidate. */
async function scenarioJourney({ environment, journal }) {
  const steps = [];
  const observations = {};

  await withGateway(journal, environment, planResponder(), async (baseUrl) => {
    steps.push(await invoke(journal, environment, 'doctor', ['doctor', '--connect'], { baseUrl }));
  });
  steps.push(
    await invoke(journal, environment, 'issue', [
      'issue',
      CUSTOMER_ISSUE_URL,
      '--repo',
      environment.workspace,
    ]),
  );

  const inspect = await invoke(journal, environment, 'inspect', ['inspect', environment.workspace]);
  observations.issueCarried = inspect.json?.record?.issueRef?.canonical ?? null;
  observations.linkedWorktree = inspect.json?.record?.local?.isLinkedWorktree ?? null;
  steps.push(inspect);

  const contract = await invoke(journal, environment, 'contract', [
    'contract',
    runIdOf(inspect),
    '--criterion',
    OPERATOR_CRITERION,
    '--check',
    OPERATOR_CHECK,
    '--by',
    OPERATOR_BY,
  ]);
  observations.contractCriteria = (contract.json?.record?.acceptanceContract?.criteria ?? []).map(
    (criterion) => `${criterion.id} ${criterion.statement}`,
  );
  // Read back, not hardcoded. `contract` numbers issue criteria before the ones a
  // human states, so if the fixture ever edits its acceptance list this row moves
  // its number and the assertions below still follow it.
  const stated = (contract.json?.record?.acceptanceContract?.criteria ?? []).find(
    (criterion) => criterion.source.kind === 'human',
  );
  observations.statedCriterion = stated
    ? {
        id: stated.id,
        statement: stated.statement,
        by: stated.source.by ?? null,
        plan: (stated.verificationPlan ?? []).map(
          (step) => `${step.kind}${'command' in step ? ` ${step.command}` : ''}`,
        ),
      }
    : null;
  steps.push(contract);

  await withGateway(journal, environment, planResponder(), async (baseUrl) => {
    steps.push(
      await invoke(journal, environment, 'plan', ['plan', runIdOf(contract)], { baseUrl }),
    );
  });
  const planRun = runIdOf(steps.find((step) => step.label === 'plan'));

  steps.push(
    await invoke(journal, environment, 'verify-consent-probe', [
      'verify',
      planRun,
      '--repo',
      environment.workspace,
    ]),
  );

  await withGateway(
    journal,
    environment,
    implementResponder([
      { path: 'src/slugify.js', content: FIXED_SLUGIFY, criterionIds: ['AC-1', 'AC-2', 'AC-3'] },
      {
        path: 'test/slugify.test.js',
        content: FULL_TESTS,
        criterionIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
      },
    ]),
    async (baseUrl) => {
      steps.push(
        await invoke(
          journal,
          environment,
          'implement',
          ['implement', planRun, '--repo', environment.workspace],
          {
            baseUrl,
          },
        ),
      );
    },
  );
  const implement = steps.find((step) => step.label === 'implement');
  observations.implementationStatus = implement.json?.record?.implementation?.status ?? null;
  observations.implementationOutcome = implement.json?.record?.outcome ?? null;

  const verify = await verifyWithRepositoryConsent(journal, environment, planRun);
  steps.push(verify.attempt);
  steps.push(verify.consent);
  observations.gates = verify.gates;
  observations.verifyOutcome = verify.consent.json?.record?.outcome ?? null;
  // Recorded, not asserted: what the product concluded per criterion, and which
  // criteria each gate claims to be evidence for. Together these are the reading
  // of whether a machine-proven patch actually reaches the customer's list.
  observations.criteriaVerdicts = criterionVerdicts(verify.consent.json?.record);
  observations.gateBindings = gateCriterionBindings(verify.consent.json?.record);
  observations.gateReceipts = gateExitCodes(verify.consent.json?.record);

  await withGateway(journal, environment, reviewResponder([]), async (baseUrl) => {
    steps.push(
      await invoke(
        journal,
        environment,
        'review',
        ['review', planRun, '--repo', environment.workspace],
        {
          baseUrl,
        },
      ),
    );
  });

  steps.push(
    await invoke(journal, environment, 'status', [
      'status',
      planRun,
      '--repo',
      environment.workspace,
    ]),
  );
  steps.push(await invoke(journal, environment, 'report', ['report', planRun]));

  const pr = await invoke(journal, environment, 'pr', [
    'pr',
    planRun,
    '--repo',
    environment.workspace,
  ]);
  steps.push(pr);
  const digest = pr.json?.digest ?? null;
  observations.publicationDigest = digest;
  if (digest) {
    steps.push(
      await invoke(journal, environment, 'pr-approve', [
        'pr',
        planRun,
        '--repo',
        environment.workspace,
        '--approve',
        digest,
      ]),
    );
  }

  const workspace = workspacePath(environment, planRun);
  const patch = independentPatchIdentity(workspace, environment.baseSha);
  const rederived = rederiveProductPatchIdentity(workspace, environment.baseSha);
  const recorded = verify.consent.json?.record?.verification?.patchIdentity ?? null;
  const precondition = verify.consent.json?.record?.verification?.patchPrecondition ?? null;
  observations.independentPatch = patch;
  // Not "the same digest from two tools": Stage 7 digests file *contents*, while
  // this harness's diff measurement digests Git's rendered diff, so those numbers
  // are allowed to differ and comparing them would be a category error. What is
  // comparable is the claim underneath both: the recorded identity must reproduce
  // from the bytes now on disk when the canonical form Stage 7 documents is
  // re-implemented here in another process (which a stored digest could not do if
  // it had been invented, copied, or left behind by a moved workspace), and the
  // file list Git reads must be exactly the two files this run means to change.
  observations.recordedPatchIdentity = recorded;
  observations.rederivedPatchIdentity = rederived.digest;
  observations.patchIdentityCurrent = recorded !== null && recorded === rederived.digest;
  observations.patchFiles = rederived.files;
  observations.patchScopeAgrees = sameSet(rederived.files, patch.changed, EXPECTED_PATCH_FILES);
  observations.preconditionStatus = precondition?.status ?? null;
  observations.preconditionMatches =
    precondition?.status === 'MATCHED' &&
    precondition.expectedIdentity === recorded &&
    precondition.observedIdentity === recorded;
  observations.oracleWorkspace = workspace;

  return {
    oracleWorkspace: workspace,
    observations,
    ...journeyVerdict(steps, verify.consent, observations),
  };
}

function sameSet(...lists) {
  const keys = lists.map((list) => [...new Set(list)].sort().join('\n'));
  return keys[0].length > 0 && keys.every((key) => key === keys[0]);
}

/** A model that fixes two of three behaviours: the gates must fail, not shrug. */
async function scenarioFailedAssertion({ environment, journal }) {
  const chain = await implementHalfFix(journal, environment);
  const verify = await verifyWithRepositoryConsent(journal, environment, chain.planRun);
  const observations = {
    implementationStatus: chain.implement.json?.record?.implementation?.status ?? null,
    verifyOutcome: verify.consent.json?.record?.outcome ?? null,
    criteria: criterionVerdicts(verify.consent.json?.record),
    gateBindings: gateCriterionBindings(verify.consent.json?.record),
  };
  const gateReceipt = gateExitCodes(verify.consent.json?.record);
  observations.gateReceipts = gateReceipt;
  // The failure has to reach the criterion, not stop at the command: exit 1 with
  // every criterion still claiming PASS would be the same lie in a different place.
  const claimedPass = observations.criteria.filter((line) => line.includes(' PASS'));
  const ok =
    verify.consent.exitCode === 1 &&
    observations.verifyOutcome === 'VERIFICATION_FAIL' &&
    gateReceipt.some((line) => line.includes('=FAIL')) &&
    claimedPass.length === 0;
  return {
    ok,
    oracleWorkspace: chain.workspace,
    observations,
    reason: ok
      ? 'failed acceptance assertion produced a failed verification and no criterion claimed a pass'
      : `expected VERIFICATION_FAIL exit=1 with a failed gate and no PASS criterion, got ${String(
          observations.verifyOutcome,
        )} exit=${String(verify.consent.exitCode)} receipts=${JSON.stringify(gateReceipt)} claimedPass=${JSON.stringify(claimedPass)}`,
  };
}

/** Kill the loop mid-flight, then recover: read-only status, preview, consented resume. */
async function scenarioInterruption({ environment, journal }) {
  const chain = await planOnly(journal, environment);
  let killed;
  let served = 0;
  const gateway = await startScriptedGateway({
    model: SCRIPTED_MODEL,
    respond: implementResponder([
      { path: 'src/slugify.js', content: FIXED_SLUGIFY, criterionIds: ['AC-1', 'AC-2', 'AC-3'] },
      { path: 'test/slugify.test.js', content: FULL_TESTS, criterionIds: ['AC-4'] },
    ]),
    onCall: () => {
      served += 1;
      if (served === 2 && killed) killed();
    },
  });
  const child = spawnCli(
    environment,
    ['implement', chain.planRun, '--repo', environment.workspace],
    {
      baseUrl: gateway.baseUrl,
    },
  );
  const done = collect(child);
  killed = () => child.kill('SIGKILL');
  const run = await done;
  await gateway.close();
  journal.record({
    label: 'implement-killed',
    argv: ['implement', chain.planRun],
    ...run,
    servedCalls: served,
  });

  // What is on disk before `status` is asked about it decides whether that
  // screen's sentence about the workspace is a fact or an assumption, so the
  // harness measures the three things the sentence speaks to — the directory the
  // run's own id names, the worktree registration beside it, and the operation
  // lock — and only then reads the screen.
  const interruptedWorkspace = path.join(
    environment.workspace,
    '.mergesutra',
    'worktrees',
    chain.planRun,
  );
  const lockDirectory = path.join(
    environment.workspace,
    '.mergesutra',
    'runs',
    `${chain.planRun}.lock`,
  );
  const afterKill = {
    workspaceDirectory: {
      path: interruptedWorkspace,
      exists: existsSync(interruptedWorkspace),
      entries: existsSync(interruptedWorkspace)
        ? readdirSync(interruptedWorkspace).filter((name) => name !== '.git')
        : [],
    },
    worktrees: parseWorktrees(
      git(['worktree', 'list', '--porcelain'], environment.workspace).stdout,
    ),
    lock: { path: lockDirectory, exists: existsSync(lockDirectory) },
  };
  journal.write('after-kill-disk.json', afterKill);

  const status = await invoke(journal, environment, 'status-after-kill', [
    'status',
    chain.planRun,
    '--repo',
    environment.workspace,
  ]);
  const preview = await invoke(journal, environment, 'resume-preview', ['resume', chain.planRun]);
  const execute = await withGateway(
    journal,
    environment,
    implementResponder([
      { path: 'src/slugify.js', content: FIXED_SLUGIFY, criterionIds: ['AC-1', 'AC-2', 'AC-3'] },
      { path: 'test/slugify.test.js', content: FULL_TESTS, criterionIds: ['AC-4'] },
    ]),
    async (baseUrl) =>
      invoke(
        journal,
        environment,
        'resume-execute',
        ['resume', chain.planRun, '--repo', environment.workspace, '--execute'],
        { baseUrl },
      ),
  );
  const verify = await verifyWithRepositoryConsent(journal, environment, chain.planRun);

  const observations = {
    servedCallsBeforeKill: served,
    killSignal: run.signal,
    killedExitCode: run.exitCode,
    workspaceExistsAfterKill: afterKill.workspaceDirectory.exists,
    workspaceContentAfterKill: afterKill.workspaceDirectory.entries,
    worktreesRegisteredAfterKill: afterKill.worktrees.map((entry) => entry.path),
    lockPresentAfterKill: afterKill.lock.exists,
    statusExit: status.exitCode,
    statusOutcome: status.json?.record?.outcome ?? null,
    // The screen's own word for the directory measured just above. Stage 17 found
    // `status` answering `NOT_CREATED` — "never prepared a workspace of its own" —
    // about a run whose worktree was standing there and registered in Git, because
    // the observation only ever looked for a record. `PRESENT_UNRECORDED` is the
    // answer that survives contact with the disk, and asserting it here also proves
    // the directory this harness spells is the one Stage 5 prepared.
    statusWorkspaceState: status.json?.workspace?.state ?? null,
    statusWorkspacePath: status.json?.workspace?.path ?? null,
    resumePreviewExit: preview.exitCode,
    resumePreviewOutcome: preview.json?.record?.outcome ?? preview.json?.outcome ?? null,
    resumeExecuteExit: execute.exitCode,
    resumeExecuteOutcome: execute.json?.record?.outcome ?? null,
    verifyOutcome: verify.consent.json?.record?.outcome ?? null,
  };
  // Recovery is not "a command ran after the kill": it is the interrupted loop
  // finishing the work, and the finished work then passing the gates.
  const recovered =
    run.signal === 'SIGKILL' &&
    served >= 1 &&
    status.exitCode === 0 &&
    // The disk measured above says a workspace exists, Git has registered it, and
    // the run's record names none of it, so `PRESENT_UNRECORDED` at that exact
    // path is the only status answer consistent with both. `NOT_CREATED` here
    // would mean the screen told the customer nothing was left while a checkout
    // stood under their nose — and the resume that follows finished real work in
    // it.
    observations.statusWorkspaceState === 'PRESENT_UNRECORDED' &&
    observations.statusWorkspacePath === interruptedWorkspace &&
    preview.exitCode === 0 &&
    execute.exitCode === 3 &&
    verify.consent.exitCode === 0 &&
    observations.verifyOutcome === 'VERIFICATION_PASS';
  return {
    ok: recovered,
    oracleWorkspace: chain.workspace,
    observations,
    reason: recovered
      ? 'interrupted run resumed, re-verified and passed'
      : `resume did not recover the run: ${JSON.stringify(observations)}`,
  };
}

/** Reviewer finds an incomplete patch; the operator approves the digest; it re-verifies. */
async function scenarioRepair({ environment, journal }) {
  const chain = await implementHalfFix(journal, environment, { tests: GREEN_TESTS });
  // The half-fix here is green-but-incomplete: its suite never asks about the two
  // criteria the bug survives in, so `npm test` exits 0, the gate is satisfied and
  // the run has receipts. `review` refuses to be a second opinion with nothing to
  // weigh it against, which is why the documented order is implement → verify →
  // review and this scenario follows it. The repair has to *add* the missing cases
  // rather than rewrite an existing one, because a whole-file edit that drops a
  // baseline assertion is refused by the write guard, by design.
  const verifyBefore = await verifyWithRepositoryConsent(journal, environment, chain.planRun);
  const review = await withGateway(
    journal,
    environment,
    reviewResponder([
      {
        severity: 'BLOCKER',
        category: 'CORRECTNESS',
        statement:
          "slugify('--x--') returns 'x-' and slugify('  Hello  World  ') returns 'hello-world-', so a trailing hyphen survives and AC-1 and AC-3 are not met.",
        impact: 'A title wrapped in punctuation still produces a slug with a trailing hyphen.',
        evidence:
          'The final replacement strips a leading run of hyphens only; the trailing run is left in place.',
        file: 'src/slugify.js',
        criterionIds: ['AC-1', 'AC-3'],
        proposedAction:
          'In src/slugify.js strip the trailing run of hyphens as well as the leading one, which is what AC-1 and AC-3 ask for.',
      },
      {
        severity: 'BLOCKER',
        category: 'TEST_GAP',
        statement:
          'The test file has no case for the spaced title or for the doubled-hyphen input, so AC-4 is unmet and the repository gate reports success over the behaviour AC-1 and AC-3 forbid.',
        impact: 'Nothing in the repository would notice if the trailing hyphen came back.',
        evidence:
          'The file holds three cases, none of which passes a value with surrounding punctuation.',
        file: 'test/slugify.test.js',
        criterionIds: ['AC-4'],
        proposedAction:
          'In test/slugify.test.js add a case for the spaced title and one for the doubled-hyphen input, keeping the cases already there, which is what AC-4 asks for.',
      },
    ]),
    async (baseUrl) =>
      invoke(
        journal,
        environment,
        'review',
        ['review', chain.planRun, '--repo', environment.workspace, '--max-repair-cycles', '1'],
        { baseUrl },
      ),
  );
  const repairPlan = review.json?.record?.repairPlan ?? null;
  journal.write('repair-plan.json', { plan: repairPlan });

  // The digest a human would be asked to approve is not printed as a top-level
  // field of `repair --json`; it is the refusal's own `decision.expectedDigest`,
  // which is the same value the stage will recompute before it edits anything.
  // Reading it here is what lets the approval be for *this frozen plan* rather
  // than for a string this harness invented.
  const unapproved = await invoke(journal, environment, 'repair-unapproved', [
    'repair',
    chain.planRun,
    '--repo',
    environment.workspace,
  ]);
  const digest = unapproved.json?.decision?.expectedDigest ?? null;
  journal.write('repair-approval.json', { digest, decision: unapproved.json?.decision ?? null });

  // A digest that is not this plan's, offered while the plan is still unexecuted:
  // the only honest reading is a refusal that edits nothing, so the patch identity
  // is measured on both sides of it.
  const identityBeforeForge = independentPatchIdentity(chain.workspace, environment.baseSha).digest;
  const forged = await invoke(journal, environment, 'repair-forged-approval', [
    'repair',
    chain.planRun,
    '--repo',
    environment.workspace,
    '--approve-plan',
    'b'.repeat(64),
  ]);
  const identityAfterForge = independentPatchIdentity(chain.workspace, environment.baseSha).digest;

  let applied = null;
  if (digest) {
    applied = await withGateway(
      journal,
      environment,
      implementResponder([
        {
          path: 'src/slugify.js',
          content: FIXED_SLUGIFY,
          criterionIds: ['AC-1', 'AC-3'],
        },
        {
          path: 'test/slugify.test.js',
          content: REPAIRED_TESTS,
          criterionIds: ['AC-4'],
        },
      ]),
      async (baseUrl) =>
        invoke(
          journal,
          environment,
          'repair-approved',
          ['repair', chain.planRun, '--repo', environment.workspace, '--approve-plan', digest],
          { baseUrl },
        ),
    );
  }
  const verify = applied
    ? await verifyWithRepositoryConsent(journal, environment, chain.planRun)
    : null;

  const observations = {
    gateVerdictOnIncompletePatch: verifyBefore.consent.json?.record?.outcome ?? null,
    reviewExit: review.exitCode,
    reviewOutcome: review.json?.record?.outcome ?? null,
    findingDispositions: (review.json?.record?.review?.findings ?? []).map(
      (finding) => `${finding.id} ${finding.disposition}`,
    ),
    repairPlanTargets: repairPlan?.expectedFiles ?? [],
    repairPlanFindings: (repairPlan?.findings ?? []).map((finding) => finding.findingId),
    repairPlanDigest: digest,
    unapprovedRepairExit: unapproved.exitCode,
    unapprovedRepairExecuted: unapproved.json?.executed ?? null,
    forgedApprovalExit: forged.exitCode,
    forgedApprovalStatus: forged.json?.decision?.status ?? null,
    forgedExecuted: forged.json?.executed ?? null,
    forgedPatchUnchanged: identityBeforeForge === identityAfterForge,
    approvedRepairExit: applied?.exitCode ?? null,
    approvedRepairOutcome: applied?.json?.record?.outcome ?? null,
    approvedRepairExecuted: applied?.json?.executed ?? null,
    repairTermination:
      applied?.json?.record?.repairExecutions?.[0]?.implementation?.termination?.kind ?? null,
    repairScopeOutcome: applied?.json?.record?.repairExecutions?.[0]?.scope?.outcome ?? null,
    reVerifyExit: verify?.consent.exitCode ?? null,
    reVerifyOutcome: verify?.consent.json?.record?.outcome ?? null,
  };
  // Chain: the review found the gap and froze a plan naming both files; editing
  // without an approval is refused; a digest that is not the plan's is refused and
  // edits nothing; the approved repair runs, stays inside the planned scope; and
  // re-verifying with consent then passes on the repaired bytes.
  const ok =
    observations.gateVerdictOnIncompletePatch === 'VERIFICATION_PASS' &&
    digest !== null &&
    observations.reviewOutcome === 'REVIEW_RECORDED' &&
    observations.findingDispositions.length === 2 &&
    observations.findingDispositions.every((entry) => entry.endsWith('VALID_REPAIR_CANDIDATE')) &&
    observations.repairPlanTargets.join(',') === 'src/slugify.js,test/slugify.test.js' &&
    unapproved.exitCode === 3 &&
    observations.unapprovedRepairExecuted === false &&
    observations.forgedExecuted === false &&
    observations.forgedPatchUnchanged === true &&
    applied?.json?.executed === true &&
    observations.repairScopeOutcome === 'WITHIN_PLANNED_SCOPE' &&
    verify?.consent.exitCode === 0 &&
    observations.reVerifyOutcome === 'VERIFICATION_PASS';
  return {
    ok,
    oracleWorkspace: chain.workspace,
    observations,
    reason: ok
      ? 'reviewer finding led to a digest-approved repair that then verified clean'
      : `repair journey incomplete: ${JSON.stringify(observations)}`,
  };
}

/** Bytes moved under an approval that was already given: the evidence and the digest both have to expire. */
async function scenarioStalePatch({ environment, journal }) {
  const chain = await implementFullFix(journal, environment);
  const verify = await verifyWithRepositoryConsent(journal, environment, chain.planRun);
  await withGateway(journal, environment, reviewResponder([]), async (baseUrl) =>
    invoke(
      journal,
      environment,
      'review',
      ['review', chain.planRun, '--repo', environment.workspace],
      { baseUrl },
    ),
  );
  // The pack comes before the candidate: `pr` refuses to build a publication
  // proposal while a reviewer would be asked to approve claims with nothing behind
  // them, so skipping this step would measure the wrong thing.
  const report = await invoke(journal, environment, 'report', ['report', chain.planRun]);
  const before = independentPatchIdentity(chain.workspace, environment.baseSha);
  const candidate = await invoke(journal, environment, 'pr-before-edit', [
    'pr',
    chain.planRun,
    '--repo',
    environment.workspace,
  ]);
  const digest = candidate.json?.digest ?? null;
  // An approval that exists before the edit is the only kind worth expiring: a
  // refusal to accept a digest that never matched anything proves nothing about
  // staleness.
  const approved = digest
    ? await invoke(journal, environment, 'pr-approve', [
        'pr',
        chain.planRun,
        '--repo',
        environment.workspace,
        '--approve',
        digest,
      ])
    : null;

  // The customer (or a later tool) edits the workspace after the evidence was
  // gathered. Nothing here is a MergeSutra action: it is exactly the drift the
  // stale-evidence rule exists to catch.
  await writeFile(path.join(chain.workspace, 'src', 'slugify.js'), HALF_SLUGIFY, 'utf8');
  const after = independentPatchIdentity(chain.workspace, environment.baseSha);

  const status = await invoke(journal, environment, 'status-after-edit', [
    'status',
    chain.planRun,
    '--repo',
    environment.workspace,
  ]);
  const pr = await invoke(journal, environment, 'pr-after-edit', [
    'pr',
    chain.planRun,
    '--repo',
    environment.workspace,
  ]);
  const reused = await invoke(journal, environment, 'pr-reuse-old-approval', [
    'pr',
    chain.planRun,
    '--repo',
    environment.workspace,
    '--approve',
    String(digest ?? 'c'.repeat(64)),
  ]);
  const wrong = await invoke(journal, environment, 'pr-forged-approval', [
    'pr',
    chain.planRun,
    '--repo',
    environment.workspace,
    '--approve',
    'a'.repeat(64),
  ]);

  const observations = {
    verifyOutcome: verify.consent.json?.record?.outcome ?? null,
    verifyExit: verify.consent.exitCode,
    reportExit: report.exitCode,
    patchChangedByHand: before.digest !== after.digest,
    patchIdentityBeforeEdit: before.digest,
    patchIdentityAfterEdit: after.digest,
    candidateOutcome: candidate.json?.record?.outcome ?? null,
    candidateReadiness: candidate.json?.readiness ?? null,
    candidateDigest: digest,
    approvalIssuedExit: approved?.exitCode ?? null,
    approvalIssued: approved?.json?.approved === true,
    approvalPublished: approved?.json?.published === true,
    statusExit: status.exitCode,
    statusOutcome: status.json?.record?.outcome ?? null,
    statusWorkspaceState: status.json?.workspace?.state ?? null,
    statusPatchComparison: status.json?.patch?.status ?? null,
    statusStale: /stale/i.test(textOf(status)),
    prExit: pr.exitCode,
    prOutcome: pr.json?.record?.outcome ?? null,
    prReadiness: pr.json?.readiness ?? null,
    prVerificationCurrent: readinessCheck(pr, 'verification-current'),
    prPackCurrent: readinessCheck(pr, 'pack-current'),
    reusedApprovalExit: reused.exitCode,
    reusedApprovalAccepted: reused.json?.approved === true,
    reusedApprovalPublished: reused.json?.published === true,
    forgedApprovalExit: wrong.exitCode,
    forgedApproved: wrong.json?.approved === true,
  };
  // The customer edits the workspace after the receipts and the approval. Every
  // consequence of that has to be a refusal that says why: the current bytes are
  // no longer the verified ones, the pack is no longer current, and neither the
  // digest approved before the edit nor a made-up one is accepted after it. Nothing
  // in this scenario may publish, because publication is a different issue.
  const ok =
    observations.verifyOutcome === 'VERIFICATION_PASS' &&
    observations.verifyExit === 0 &&
    observations.candidateDigest !== null &&
    observations.approvalIssued &&
    observations.approvalPublished === false &&
    observations.patchChangedByHand &&
    observations.statusExit === 0 &&
    observations.statusStale &&
    observations.statusWorkspaceState === 'PRESENT_PATCH_CHANGED' &&
    observations.statusPatchComparison === 'STALE' &&
    observations.prExit === 4 &&
    observations.prReadiness === 'NOT_READY_FOR_PUBLICATION' &&
    NOT_SATISFIED.includes(observations.prVerificationCurrent) &&
    observations.reusedApprovalAccepted === false &&
    observations.reusedApprovalPublished === false &&
    observations.forgedApproved === false &&
    reused.exitCode !== 0 &&
    wrong.exitCode !== 0;
  return {
    ok,
    oracleWorkspace: chain.workspace,
    observations,
    reason: ok
      ? 'a hand edit after verification expired the evidence and both the old and a forged digest were refused'
      : `staleness not enforced: ${JSON.stringify(observations)}`,
  };
}

/**
 * Replace the body of a linked worktree's `.git` pointer file.
 *
 * `writeFile` is refused here with `EPERM: open`, and only here: on Windows the
 * `O_TRUNC` create-and-open path that `writeFile` uses is denied on the pointer
 * Git writes for a linked worktree, while an `r+` open of the same file succeeds.
 * So open it read-write and truncate the handle. The file is never absent and
 * keeps its inode, which matters because this scenario forges a customer's real
 * Git metadata and then restores it byte for byte.
 */
async function overwriteGitPointer(file, text) {
  const handle = await open(file, 'r+');
  try {
    await handle.truncate(0);
    await handle.write(text, 0, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Worktree metadata that no longer describes the directory holding it.
 *
 * Two forgeries a hostile repository or a half-finished tool could really leave
 * behind: a `gitdir:` pointer to a metadata directory that does not exist, and a
 * pointer naming the *parent clone's* metadata — the shape that would let a run
 * workspace read, or worse write, the customer's repository through a path
 * MergeSutra believes it owns. Both are applied to the run workspace, the directory
 * whose patch the stage measures; the first is then applied to the customer's own
 * checkout, which is the directory `--repo` names.
 *
 * Those two cases are not the same promise, so they are not asserted the same way:
 *
 * - a forged pointer on the thing under measurement has to stop the stage, name the
 *   metadata as untrustworthy, and record no verification round at all. Reporting a
 *   measurement of whatever repository the forgery resolves to would be the failure,
 *   not a remedy;
 * - `verify` never lets Git discover a repository from a directory it does not own,
 *   so the customer's own checkout metadata is not on the path that decides this
 *   run. Forging it must therefore move nothing: the same decision, the same patch
 *   identity, the same workspace measured. A refusal there would be the product
 *   claiming knowledge of a pointer it does not read; a changed digest would be it
 *   having followed the forgery.
 *
 * Both readings need a baseline that actually passes, so the chain here is the
 * green-but-incomplete one and consent is granted before any forgery is applied.
 */
async function scenarioForgedMetadata({ environment, journal }) {
  const chain = await implementHalfFix(journal, environment, { tests: GREEN_TESTS });
  const baseline = await verifyWithRepositoryConsent(journal, environment, chain.planRun);
  const allow = consentFlags(baseline.attempt);
  const forgeries = [
    {
      label: 'run-workspace',
      case: 'must-refuse',
      file: path.join(chain.workspace, '.git'),
      forged: `gitdir: ${path.join(environment.parent, '.git', 'worktrees', 'not-a-worktree')}\n`,
    },
    {
      label: 'run-workspace-points-at-parent',
      case: 'must-refuse',
      file: path.join(chain.workspace, '.git'),
      forged: `gitdir: ${path.join(environment.parent, '.git')}\n`,
    },
    {
      label: 'primary-checkout',
      case: 'must-be-unmoved',
      file: path.join(environment.workspace, '.git'),
      forged: `gitdir: ${path.join(environment.parent, '.git', 'worktrees', 'not-a-worktree')}\n`,
    },
  ];
  const observations = {
    baselineExit: baseline.consent.exitCode,
    baselineOutcome: baseline.consent.json?.record?.outcome ?? null,
    baselinePatchIdentity: baseline.consent.json?.record?.verification?.patchIdentity ?? null,
    baselineMeasuredWorkspace: workspaceTail(baseline.consent.json?.record?.verification),
    allowFlags: allow.join(' '),
  };
  const restored = [];
  for (const forgery of forgeries) {
    // One forgery at a time, with the customer's own bytes put back before the
    // next is applied. Two of these three land on the same pointer, so a loop
    // that forged and never restored would make the third measurement say
    // nothing about the third forgery — it would only repeat the second.
    const original = await readFile(forgery.file, 'utf8');
    await overwriteGitPointer(forgery.file, forgery.forged);
    try {
      const status = await invoke(journal, environment, `status-${forgery.label}`, [
        'status',
        chain.planRun,
        '--repo',
        environment.workspace,
      ]);
      const verify = await invoke(journal, environment, `verify-${forgery.label}`, [
        'verify',
        chain.planRun,
        '--repo',
        environment.workspace,
        ...allow,
      ]);
      const said = textOf(verify);
      const round = verify.json?.record?.verification;
      observations[`${forgery.label}:statusExit`] = status.exitCode;
      observations[`${forgery.label}:statusWorkspaceState`] = status.json?.workspace?.state ?? null;
      observations[`${forgery.label}:verifyExit`] = verify.exitCode;
      observations[`${forgery.label}:verifyOutcome`] = verify.json?.record?.outcome ?? null;
      observations[`${forgery.label}:roundRecorded`] = Boolean(round);
      observations[`${forgery.label}:patchPrecondition`] = round?.patchPrecondition?.status ?? null;
      observations[`${forgery.label}:preconditionReason`] =
        round?.patchPrecondition?.reason?.slice(0, 300) ?? null;
      observations[`${forgery.label}:gateStatuses`] = (round?.gates ?? []).map(
        (gate) => `${gate.gateId}:${gate.status}`,
      );
      observations[`${forgery.label}:measuredPatchIdentity`] = round?.patchIdentity ?? null;
      observations[`${forgery.label}:measuredWorkspace`] = workspaceTail(round);
      observations[`${forgery.label}:text`] = said.slice(0, 900);
      observations[`${forgery.label}:refused`] = verify.exitCode !== 0;
      observations[`${forgery.label}:namesUntrustworthyMetadata`] =
        /not trustworthy|no Git metadata|undescribable|cannot name a patch/i.test(said);
    } finally {
      await overwriteGitPointer(forgery.file, original);
      restored.push({
        forgery: forgery.label,
        worktree: path.basename(path.dirname(forgery.file)),
        exact: (await readFile(forgery.file, 'utf8')) === original,
      });
    }
  }
  observations.restored = restored;

  const ownWorkspaceTail = workspaceTail({ workspace: chain.workspace });
  const everyForgeryHolds = forgeries.every((forgery) => {
    const at = (field) => observations[`${forgery.label}:${field}`];
    if (forgery.case === 'must-refuse') {
      return (
        at('refused') &&
        at('namesUntrustworthyMetadata') &&
        at('roundRecorded') === false &&
        at('statusWorkspaceState') === 'UNREADABLE'
      );
    }
    return (
      at('refused') === false &&
      at('verifyExit') === observations.baselineExit &&
      at('verifyOutcome') === observations.baselineOutcome &&
      at('measuredPatchIdentity') === observations.baselinePatchIdentity &&
      at('measuredWorkspace') === ownWorkspaceTail
    );
  });
  const ok =
    observations.baselineExit === 0 &&
    observations.baselineOutcome === 'VERIFICATION_PASS' &&
    observations.baselinePatchIdentity !== null &&
    observations.baselineMeasuredWorkspace === ownWorkspaceTail &&
    everyForgeryHolds &&
    restored.length === forgeries.length &&
    restored.every((entry) => entry.exact);
  return {
    ok,
    oracleWorkspace: chain.workspace,
    observations,
    reason: ok
      ? 'a consented verify that passes untouched refused both forgeries on the measured workspace without recording a round, left the customer-checkout forgery unmoved, and every pointer came back byte-for-byte'
      : `forged metadata not refused, or the customer-checkout forgery moved the measurement, or the baseline did not pass: ${JSON.stringify(observations)}`,
  };
}

/**
 * No sandbox means no repository command at all — and proof nothing ran on the host.
 *
 * The chain is built with the sandbox in place, because a customer reaches this
 * failure after the work exists, not before. Then `verify` is invoked with the two
 * sandbox settings absent, which is what a machine without a preloaded image or a
 * Docker engine looks like. The stage has to stop without claiming a pass, name
 * `SANDBOX_UNAVAILABLE`, and leave the tripwire directory it was given as its host
 * npm cache empty — that directory is the only evidence that survives the process,
 * and an empty one says `npm test` never ran here.
 *
 * One thing does run, and it is not a fallback. MergeSutra's own trailing-whitespace
 * check (`git diff --check`, a constant argv in `src/verify/patch.ts`, attributed to
 * `MERGESUTRA_BUILTIN`) is a measurement of the patch, not a command under review,
 * and it reads Git metadata that a sandbox mount deliberately does not get; S16-4
 * measured both readings. So the boundary this scenario tests is stated structurally
 * rather than as a bare count of receipts: every gate the *repository* authored must
 * show `NOT_EXECUTED` with no exit code, and anything that did execute must be that
 * one documented built-in argv and nothing a plan could name.
 */
async function scenarioNoSandbox({ environment, journal }) {
  const chain = await implementHalfFix(journal, environment);
  const tripwire = path.join(environment.root, 'host-npm-cache');
  mkdirSync(tripwire, { recursive: true });
  const withoutConsent = await invoke(
    journal,
    environment,
    'verify-without-consent-no-sandbox',
    ['verify', chain.planRun, '--repo', environment.workspace],
    { sandbox: false, extraEnv: { npm_config_cache: tripwire } },
  );
  const allow = consentFlags(withoutConsent);
  const verify = await invoke(
    journal,
    environment,
    'verify-without-sandbox',
    ['verify', chain.planRun, '--repo', environment.workspace, ...allow],
    { sandbox: false, extraEnv: { npm_config_cache: tripwire } },
  );
  const created = await readdir(tripwire).catch(() => []);
  const text = textOf(verify);
  const round = verify.json?.record?.verification;
  const sources = new Map(
    (verify.json?.record?.verificationPlan?.gates ?? []).map((gate) => [
      gate.id,
      gate.provenance?.source ?? 'UNKNOWN',
    ]),
  );
  const outcomes = round?.gates ?? [];
  const executed = outcomes.filter((gate) => gate.receipt?.termination !== 'NOT_EXECUTED');
  const observations = {
    exitCode: verify.exitCode,
    outcome: verify.json?.record?.outcome ?? null,
    gatesNamed: allow.filter((entry) => entry !== '--allow').length,
    sandboxUnavailableNamed: text.includes('SANDBOX_UNAVAILABLE'),
    saysNoRepositoryCommandExecuted: text.includes('No repository command was executed'),
    remediationSaysNoHostFallback: text.includes('Never fall back to host execution'),
    gateReceipts: gateExitCodes(verify.json?.record),
    gateProvenanceAndTermination: outcomes.map(
      (gate) => `${gate.gateId} ${sources.get(gate.gateId)} ${gate.receipt?.termination}`,
    ),
    executedArgv: executed.map((gate) => (gate.receipt?.argv ?? []).join(' ')),
    repositoryGatesExecuted: executed
      .filter((gate) => sources.get(gate.gateId) !== 'MERGESUTRA_BUILTIN')
      .map((gate) => gate.gateId),
    repositoryGateExitCodes: outcomes
      .filter((gate) => sources.get(gate.gateId) !== 'MERGESUTRA_BUILTIN')
      .map((gate) => `${gate.gateId}=${String(gate.receipt?.exitCode)}`),
    limitations: verify.json?.record?.limitations ?? null,
    hostNpmCacheEntries: created,
  };
  const ok =
    observations.exitCode === 3 &&
    observations.outcome === 'VERIFICATION_INCONCLUSIVE' &&
    observations.sandboxUnavailableNamed &&
    observations.saysNoRepositoryCommandExecuted &&
    observations.repositoryGatesExecuted.length === 0 &&
    observations.executedArgv.every((argv) => argv === 'git diff --check') &&
    created.length === 0;
  return {
    ok,
    oracleWorkspace: chain.workspace,
    observations,
    reason: ok
      ? 'the absent sandbox left every repository gate un-executed with an empty host npm cache, and only the documented built-in patch measurement ran'
      : `sandbox refusal not proven: ${JSON.stringify(observations)}`,
  };
}

/**
 * Do it twice: the customer's files survive, no second body of work appears, and consent is not inherited.
 *
 * Running a stage again is the ordinary thing a customer does when they are not
 * sure it worked the first time. Three things have to hold: the repository they
 * handed over still has every tracked file it had, the loop produces the same
 * bounded patch rather than a second one nobody asked for, and the consent granted
 * for the first verification is not silently still in force for the next.
 */
async function scenarioRepeated({ environment, journal }) {
  const chain = await implementFullFix(journal, environment);
  const first = await verifyWithRepositoryConsent(journal, environment, chain.planRun);
  const trackedAfterFirst = await trackedSnapshot(environment.workspace);
  const patchAfterFirst = independentPatchIdentity(chain.workspace, environment.baseSha);

  const second = await withGateway(
    journal,
    environment,
    implementResponder([
      { path: 'src/slugify.js', content: FIXED_SLUGIFY, criterionIds: ['AC-1', 'AC-2', 'AC-3'] },
      { path: 'test/slugify.test.js', content: FULL_TESTS, criterionIds: ['AC-4'] },
    ]),
    async (baseUrl) =>
      invoke(
        journal,
        environment,
        'implement-again',
        ['implement', chain.planRun, '--repo', environment.workspace],
        { baseUrl },
      ),
  );
  const trackedAfterSecond = await trackedSnapshot(environment.workspace);
  const patchAfterSecond = independentPatchIdentity(chain.workspace, environment.baseSha);
  const withoutConsent = await invoke(journal, environment, 'verify-without-consent-again', [
    'verify',
    chain.planRun,
    '--repo',
    environment.workspace,
  ]);
  const records = await readdir(path.join(environment.workspace, '.mergesutra', 'runs')).catch(
    () => [],
  );

  const lost = Object.keys(trackedAfterFirst).filter((name) => !(name in trackedAfterSecond));
  const observations = {
    trackedFilesBefore: Object.keys(trackedAfterFirst).length,
    trackedFilesAfter: Object.keys(trackedAfterSecond).length,
    lostFiles: lost,
    firstVerifyExit: first.consent.exitCode,
    firstVerifyOutcome: first.consent.json?.record?.outcome ?? null,
    secondImplementExit: second.exitCode,
    // The same run id, not a new one: a second body of work nobody asked for would
    // arrive as a second run record with its own workspace.
    secondImplementRunId: second.json?.record?.runId ?? null,
    patchUnchangedBySecondRun: patchAfterFirst.digest === patchAfterSecond.digest,
    patchFiles: patchAfterFirst.files,
    runRecords: records.filter((name) => String(name).endsWith('.json')).length,
    verifyWithoutConsentExit: withoutConsent.exitCode,
    consentInherited: withoutConsent.exitCode === 0,
  };
  const ok =
    observations.firstVerifyExit === 0 &&
    observations.firstVerifyOutcome === 'VERIFICATION_PASS' &&
    lost.length === 0 &&
    observations.secondImplementRunId === chain.planRun &&
    observations.patchUnchangedBySecondRun &&
    !observations.consentInherited &&
    patchAfterFirst.files.length === 2;
  return {
    ok,
    oracleWorkspace: chain.workspace,
    observations,
    reason: ok
      ? 'a repeated run lost no customer file, stayed on the same run id with the same patch, and inherited no consent'
      : `repeat run not safe: ${JSON.stringify(observations)}`,
  };
}

/* ---------------------------------------------------------------- stage helpers */

async function planOnly(journal, environment) {
  await invoke(journal, environment, 'issue', [
    'issue',
    CUSTOMER_ISSUE_URL,
    '--repo',
    environment.workspace,
  ]);
  const inspect = await invoke(journal, environment, 'inspect', ['inspect', environment.workspace]);
  const contract = await invoke(journal, environment, 'contract', ['contract', runIdOf(inspect)]);
  const plan = await withGateway(journal, environment, planResponder(), async (baseUrl) =>
    invoke(journal, environment, 'plan', ['plan', runIdOf(contract)], { baseUrl }),
  );
  const planRun = runIdOf(plan);
  return { planRun, workspace: workspacePath(environment, planRun) };
}

async function implementHalfFix(journal, environment, { sandbox = true, tests = HALF_TESTS } = {}) {
  const chain = await planOnly(journal, environment);
  const implement = await withGateway(
    journal,
    environment,
    implementResponder([
      { path: 'src/slugify.js', content: HALF_SLUGIFY, criterionIds: ['AC-1', 'AC-2', 'AC-3'] },
      { path: 'test/slugify.test.js', content: tests, criterionIds: ['AC-4'] },
    ]),
    async (baseUrl) =>
      invoke(
        journal,
        environment,
        'implement',
        ['implement', chain.planRun, '--repo', environment.workspace],
        { baseUrl, sandbox },
      ),
  );
  return { ...chain, implement };
}

/**
 * The same loop with a patch that is actually correct.
 *
 * Scenarios that go on to publish a candidate or to have bytes drift under an
 * approval need a run that reached `VERIFICATION_PASS` first; a stale-evidence
 * test built on a failed verification would only prove that failure sticks.
 */
async function implementFullFix(journal, environment) {
  const chain = await planOnly(journal, environment);
  const implement = await withGateway(
    journal,
    environment,
    implementResponder([
      { path: 'src/slugify.js', content: FIXED_SLUGIFY, criterionIds: ['AC-1', 'AC-2', 'AC-3'] },
      {
        path: 'test/slugify.test.js',
        content: FULL_TESTS,
        criterionIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
      },
    ]),
    async (baseUrl) =>
      invoke(
        journal,
        environment,
        'implement',
        ['implement', chain.planRun, '--repo', environment.workspace],
        { baseUrl },
      ),
  );
  return { ...chain, implement };
}

/**
 * Verify twice, the way the product demands: once with no consent (which must stop),
 * then once with the repository's own gates named one at a time.
 */
async function verifyWithRepositoryConsent(journal, environment, runId) {
  const attempt = await invoke(journal, environment, 'verify-without-consent', [
    'verify',
    runId,
    '--repo',
    environment.workspace,
  ]);
  const consent = await invoke(journal, environment, 'verify-with-consent', [
    'verify',
    runId,
    '--repo',
    environment.workspace,
    ...consentFlags(attempt),
  ]);
  const gates = (attempt.json?.record?.verificationPlan?.gates ?? []).filter((gate) =>
    REPOSITORY_REQUIREMENTS.includes(gate.requirementLevel),
  );
  return {
    attempt,
    consent,
    gates: gates.map(
      (gate) => `${gate.id} ${gate.requirementLevel} ${(gate.argv ?? []).join(' ')}`,
    ),
  };
}

/** The requirement levels whose gates a human has to name before they may run. */
const REPOSITORY_REQUIREMENTS = ['REPOSITORY_REQUIRED', 'REPOSITORY_SUGGESTED', 'USER_REQUESTED'];

/**
 * The `--allow` flags that consent every repository gate this plan named.
 *
 * Read from the plan the product itself produced, never typed here: a harness that
 * guessed a gate id would silently consent to nothing, and the stage would stop for
 * consent rather than for the thing under test.
 */
function consentFlags(attempt) {
  return (attempt.json?.record?.verificationPlan?.gates ?? [])
    .filter((gate) => REPOSITORY_REQUIREMENTS.includes(gate.requirementLevel))
    .flatMap((gate) => ['--allow', gate.id]);
}

async function invoke(journal, environment, label, args, options = {}) {
  const run = await runCli(journal, environment, label, args, options);
  return { label, args, ...run };
}

/**
 * One CLI call, with the exit code taken from the child process itself.
 *
 * Nothing here pipes the output through another command: `spawnSync().status` is
 * the number the process exited with, which is the only number this report quotes.
 */
function runCli(journal, environment, label, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawnCli(environment, args, options);
    collect(child).then((run) => {
      journal.record({
        label,
        argv: ['mergesutra', '--json', ...args],
        cwd: environment.workspace,
        ...run,
      });
      resolve({
        exitCode: run.exitCode,
        signal: run.signal,
        stdout: run.stdout,
        stderr: run.stderr,
        json: parseJson(run.stdout),
      });
    });
  });
}

/**
 * The value this harness hands the CLI for the model key. It is a sentinel, not a
 * credential: the only listener is the scripted gateway on loopback, and the
 * release-boundary scan in `tests/security/credential-boundary.test.ts` counts a
 * quoted literal after that environment name as a credential-shaped line, so the
 * word lives here and the assignment below carries a name.
 */
const SCRIPTED_GATEWAY_KEY = 'scripted-gateway-not-a-real-credential';

function spawnCli(environment, args, options = {}) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    BHARATCODE_API_BASE: options.baseUrl ?? 'http://127.0.0.1:1',
    BHARATCODE_API_KEY: SCRIPTED_GATEWAY_KEY,
    BHARATCODE_MODEL: SCRIPTED_MODEL,
    BHARATCODE_TIMEOUT_MS: '20000',
    BHARATCODE_MAX_RETRIES: '0',
    ...(options.sandbox === false ? {} : sandboxEnv()),
    ...(options.extraEnv ?? {}),
  };
  delete env.BHARATCODE_KEY;
  if (options.sandbox === false) {
    delete env.MERGESUTRA_SANDBOX_IMAGE;
    delete env.MERGESUTRA_DOCKER_EXECUTABLE;
  }
  return spawn(process.execPath, [BIN, '--json', ...args], {
    cwd: environment.workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
}

function collect(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: String(error) });
    });
    child.on('close', (code, signal) => {
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
}

async function withGateway(journal, environment, responder, body) {
  const gateway = await startScriptedGateway({
    model: SCRIPTED_MODEL,
    respond: responder,
    onCall: (index, text) => journal.modelCall(index, text),
  });
  try {
    return await body(gateway.baseUrl);
  } finally {
    journal.modelCalls(gateway.calls.length);
    await gateway.close();
  }
}

function sandboxEnv() {
  return {
    MERGESUTRA_SANDBOX_IMAGE: sandboxImage(),
    MERGESUTRA_DOCKER_EXECUTABLE: dockerExecutable(),
  };
}

function sandboxImage() {
  return process.env.MERGESUTRA_SANDBOX_IMAGE ?? DEFAULT_IMAGE;
}

function dockerExecutable() {
  const configured = process.env.MERGESUTRA_DOCKER_EXECUTABLE;
  if (configured) return configured;
  const probe = spawnSync('docker', ['version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  const candidate = probe.error ? null : whichDocker();
  if (!candidate) {
    throw new Error('no absolute Docker executable; set MERGESUTRA_DOCKER_EXECUTABLE');
  }
  return candidate;
}

function whichDocker() {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(lookup, ['docker'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  const first = (found.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first && path.isAbsolute(first) ? first : null;
}

/* ------------------------------------------------------------------- responders */

/**
 * The criterion ids the plan prompt lists, in order.
 *
 * `plan` refuses a plan that does not account for every id in the contract
 * ("Account for EVERY criterion id listed below", src/plan/prompt.ts), and Stage
 * 17 measured that refusal working on the real topology when the operator added
 * a sixth criterion. A scripted planner that recites a fixed list therefore has
 * to read the list it was actually shown, or it stops being a model answer and
 * becomes a harness artefact. An empty reading throws rather than sending a plan
 * that the product will (correctly) reject for an unrelated-looking reason.
 */
function criteriaListedInPlanPrompt(messages) {
  const text = (messages ?? [])
    .map((message) => (typeof message?.content === 'string' ? message.content : ''))
    .join('\n');
  const ids = [...text.matchAll(/^- (AC-\d+) \[[a-z]+\] /gm)].map((match) => match[1]);
  if (ids.length === 0) {
    throw new Error(
      'the plan prompt listed no criterion id; the scripted planner cannot account for a contract it cannot read',
    );
  }
  return [...new Set(ids)];
}

/**
 * The scripted answer to `plan`. AC-1 to AC-4 are what the two edits show; every
 * other id in the contract is named as unaddressed with a reason, which is what
 * the product demands and what this patch honestly delivers.
 */
function planResponder() {
  return (messages) => {
    const listed = criteriaListedInPlanPrompt(messages);
    const covered = ['AC-1', 'AC-2', 'AC-3', 'AC-4'].filter((id) => listed.includes(id));
    return JSON.stringify({
      summary: 'Trim the hyphens that leading and trailing separators leave behind.',
      rootCause:
        'slugify replaces every run of non-alphanumeric characters with a hyphen and then stops, so a separator run at either end of the input survives as an edge hyphen.',
      changes: [
        {
          file: 'src/slugify.js',
          action: 'modify',
          reason: 'remove a run of hyphens from both ends after collapsing separators',
          criterionIds: ['AC-1', 'AC-2', 'AC-3'],
        },
        {
          file: 'test/slugify.test.js',
          action: 'modify',
          reason: 'assert each of the three inputs the issue names, keeping the existing coverage',
          criterionIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
        },
      ],
      validationCommands: [
        {
          argv: ['npm', 'test'],
          purpose: 'run the package test script',
          criterionIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
        },
      ],
      criteriaCovered: covered,
      criteriaUnaddressed: listed
        .filter((id) => !covered.includes(id))
        .map((id) => ({
          id,
          reason:
            id === 'AC-5'
              ? 'the plan edits no manifest, so nothing adds a dependency to prove absent'
              : 'no file this plan changes can show this; the validation command is what a reviewer runs',
        })),
      proposedCriteria: [],
      risks: ['A title that is entirely punctuation now slugs to an empty string.'],
      assumptions: ['No caller depends on the trailing hyphen.'],
      questionsForHuman: [],
    });
  };
}

/**
 * Read-then-write, as a model must: a whole-file replacement is only allowed to
 * replace bytes it was actually shown, so the precondition comes from the
 * transcript rather than from a value this harness already knows.
 */
function implementResponder(files) {
  return (messages) => {
    const written = acceptedTargets(messages);
    const pending = files.find((entry) => !written.has(entry.path));
    if (pending) {
      const digest = digestForPath(messages, pending.path);
      if (!digest) {
        return JSON.stringify({
          action: 'READ_FILE',
          path: pending.path,
          reason: 'obtain the current whole-file digest before replacing it',
        });
      }
      return JSON.stringify({
        action: 'WRITE_FILE',
        path: pending.path,
        replaces: { expectedSha256: digest },
        content: pending.content,
        criterionIds: pending.criterionIds,
        reason: `apply the planned change to ${pending.path}`,
      });
    }
    if (acceptedChecks(messages) === 0) {
      return JSON.stringify({
        action: 'RUN_CHECK',
        argv: ['npm', 'test'],
        criterionIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
        reason: 'run the package test script before finishing',
      });
    }
    return JSON.stringify({
      action: 'FINISH',
      summary: 'both planned files are written and the package test script has been run',
      criteriaBelievedComplete: ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
    });
  };
}

/**
 * The reference manifest, read back out of the request the product built.
 *
 * `src/review/prompt.ts` prints one line per reference — `CTX-nnn type: <kind>
 * file: <path> [<presentation>] — …` — and `src/review/disposition.ts` refuses a
 * finding that cites none of them. A scripted reviewer therefore has to do what a
 * model does with a manifest: look up the id of the material it is describing. The
 * harness inventing an id would be the invention this check exists to catch.
 */
const REFERENCE_LINE = /^(CTX-\d+) type: (\S+) (file|criterionId|gateId): (\S+) \[([A-Z_]+)\]/gm;
const UNSENT_CONTENT = new Set(['WITHHELD', 'NOT_SENT']);

function manifestReferences(messages) {
  const text = messages.map((message) => String(message?.content ?? '')).join('\n');
  const references = [];
  for (const match of text.matchAll(REFERENCE_LINE)) {
    references.push({
      ref: match[1],
      targetKind: match[3],
      target: match[4],
      presentation: match[5],
    });
  }
  return references;
}

function reviewResponder(findings) {
  return (messages) => {
    const references = manifestReferences(messages);
    const anchored = findings.map((finding) => {
      const cited = [];
      if (finding.file !== undefined) {
        const entry = references.find(
          (reference) =>
            reference.targetKind === 'file' &&
            reference.target === finding.file &&
            !UNSENT_CONTENT.has(reference.presentation),
        );
        if (!entry) {
          throw new Error(
            `the review manifest sent no content for ${finding.file}, so a scripted finding cannot cite it`,
          );
        }
        cited.push(entry.ref);
      }
      for (const id of finding.criterionIds ?? []) {
        const entry = references.find(
          (reference) => reference.targetKind === 'criterionId' && reference.target === id,
        );
        if (entry) cited.push(entry.ref);
      }
      if (cited.length === 0) {
        throw new Error(`finding for ${String(finding.file)} cites nothing in the manifest`);
      }
      return { ...finding, contextRefs: [...new Set(cited)] };
    });
    return JSON.stringify({
      summary: anchored.length
        ? 'the patch leaves a criterion of the issue unmet'
        : 'the patch matches the plan and no criterion is left unmet',
      findings: anchored,
    });
  };
}

const WRITE_ECHO = /"action"\s*:\s*"WRITE_FILE"[\s\S]*?"path"\s*:\s*"([^"]+)"/;

function acceptedTargets(messages) {
  const written = new Set();
  for (let index = 1; index < messages.length; index += 1) {
    const outcome = String(messages[index]?.content ?? '');
    if (!outcome.startsWith('OUTCOME (accepted')) continue;
    const match = WRITE_ECHO.exec(String(messages[index - 1]?.content ?? ''));
    if (match) written.add(match[1]);
  }
  return written;
}

function acceptedChecks(messages) {
  let count = 0;
  for (let index = 1; index < messages.length; index += 1) {
    const outcome = String(messages[index]?.content ?? '');
    if (!outcome.startsWith('OUTCOME')) continue;
    if (/"action"\s*:\s*"RUN_CHECK"/.test(String(messages[index - 1]?.content ?? ''))) count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------- evidence */

function createJournal(logRoot) {
  const stages = [];
  let sequence = 0;

  return {
    stages,
    record(entry) {
      sequence += 1;
      const name = `${String(sequence).padStart(2, '0')}-${entry.label}`;
      const safe = {
        ...entry,
        stdout: sanitize(entry.stdout),
        stderr: sanitize(entry.stderr),
      };
      stages.push({ label: entry.label, exitCode: entry.exitCode, signal: entry.signal ?? null });
      writeEvidence(path.join(logRoot, `${name}.log`), renderLog(safe));
    },
    note(name, text) {
      writeEvidence(path.join(logRoot, `note-${name}.txt`), String(text) + '\n');
    },
    modelCall(index, text) {
      writeEvidence(path.join(logRoot, `model-answer-${String(index)}.json`), text + '\n');
    },
    modelCalls(count) {
      // How many requests this gateway served, one row per gateway the scenario
      // started, so a stage that quietly made no call cannot look like one that
      // made many.
      sequence += 1;
      writeEvidence(
        path.join(logRoot, `${String(sequence).padStart(2, '0')}-model-calls.txt`),
        `${String(count)} request(s) answered by the scripted gateway\n`,
      );
    },
    write(name, payload) {
      writeEvidence(path.join(logRoot, name), JSON.stringify(payload, null, 2) + '\n');
    },
    exitCodes() {
      return stages.map((stage) => `${stage.label}=${String(stage.exitCode)}`);
    },
  };
}

function writeEvidence(file, text) {
  try {
    // Synchronous on purpose: an interrupted scenario still has to leave a log.
    writeFileSync(file, text, 'utf8');
  } catch {
    /* a journal must never be the reason a scenario fails */
  }
}

function renderLog(entry) {
  return [
    `label=${entry.label}`,
    `argv=${JSON.stringify(entry.argv ?? entry.args ?? [])}`,
    `exit=${String(entry.exitCode)}`,
    `signal=${entry.signal ?? ''}`,
    '',
    '[stdout]',
    entry.stdout ?? '',
    '',
    '[stderr]',
    entry.stderr ?? '',
    '',
  ].join('\n');
}

const SECRET_PATTERNS = [
  /\bbc_live_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
];

function sanitize(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/**
 * Does this text carry the shape of a credential?
 *
 * Patterns, not values: the harness must not learn which token the operator happens
 * to have in its environment, only that something token-shaped reached the evidence
 * this qualification writes out.
 */
function leaked(text) {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/* --------------------------------------------------------------------- verdicts */

/**
 * The journey's own claim about what it saw, stated as checks rather than prose.
 *
 * Every one of these is read from a process this script spawned: an exit code the
 * child returned, or a field of the record the child wrote. The documented lifecycle
 * codes are asserted explicitly — `implement`, `review` and `pr` exit 3 because the
 * product's contract says a model's claim and a stored review are not a completion,
 * and a 3 here is a stage that worked, not one that crashed.
 */
function journeyVerdict(steps, consent, observations) {
  const byLabel = new Map(steps.map((step) => [step.label, step]));
  const required = [
    'doctor',
    'issue',
    'inspect',
    'contract',
    'plan',
    'implement',
    'verify-with-consent',
    'review',
    'status',
    'report',
    'pr',
  ];
  const problems = [];
  for (const label of required) {
    if (!byLabel.has(label)) problems.push(`${label} was never invoked`);
  }
  const expectExit = (label, wanted) => {
    const step = byLabel.get(label);
    if (!step) return;
    if (step.exitCode !== wanted) {
      problems.push(
        `${label} exited ${String(step.exitCode)}, the contract says ${String(wanted)}`,
      );
    }
  };
  // `report` prints what the run has earned so far. After a review the record's
  // outcome is REVIEW_RECORDED, which the product documents as exit 3 — an honest
  // "not yet concluded", not a crash — so the report of a reviewed run exits 3.
  for (const label of ['doctor', 'issue', 'inspect', 'contract', 'plan', 'status']) {
    expectExit(label, 0);
  }
  expectExit('implement', 3);
  expectExit('review', 3);
  expectExit('report', 3);
  expectExit('pr', 3);
  if (consent.exitCode !== 0) problems.push(`consented verify exited ${String(consent.exitCode)}`);
  if (observations.issueCarried === null) {
    problems.push('the intake issue never reached the inspect run');
  }
  if (observations.linkedWorktree !== true) {
    problems.push('the run did not observe a linked-worktree checkout');
  }
  if (observations.verifyOutcome !== 'VERIFICATION_PASS') {
    problems.push(`verification did not pass: ${String(observations.verifyOutcome)}`);
  }
  // Two different fields, both needed: the loop's own status says the *model*
  // claimed it was finished, and the run outcome is the product's word for that
  // same claim. Neither says the work is correct — that is the verify above.
  if (observations.implementationStatus !== 'COMPLETED_BY_MODEL') {
    problems.push(`implementation loop status: ${String(observations.implementationStatus)}`);
  }
  if (observations.implementationOutcome !== 'IMPLEMENTED_BY_MODEL') {
    problems.push(`implement run outcome: ${String(observations.implementationOutcome)}`);
  }
  // GitHub wraps a long acceptance item and indents the second half. Until Stage
  // 17 the derivation read line by line, so this fixture's AC-5 arrived as
  // "… devDependencies — this is a" — an obligation the planner, the implementer
  // and the reviewer all received and none of them could evaluate. The tail is
  // what a reader checks to see the wrap folded back in.
  const wrapped = (observations.contractCriteria ?? []).find((row) => row.startsWith('AC-5 '));
  if (wrapped === undefined || !wrapped.endsWith(AC5_WRAPPED_TAIL)) {
    problems.push(`AC-5 did not reach the contract whole: ${String(wrapped)}`);
  }
  // A criterion lifted out of the issue carries a `manual` step and honestly
  // answers NOT_AVAILABLE, so before Stage 17 no customer journey had put a
  // machine-proven PASS on any criterion. The operator route — a stated criterion
  // with a named check — is the only way through, and it had only ever been proven
  // inside one process. This asserts the binding survives contract, plan and a
  // sandboxed verify on the real topology, and lands on the repository's own gate.
  const stated = observations.statedCriterion;
  if (!stated) {
    problems.push('the contract recorded no criterion stated by the operator');
  } else {
    if (!stated.plan.includes(`test ${OPERATOR_CHECK}`)) {
      problems.push(
        `criterion ${stated.id} carries no bound command: ${JSON.stringify(stated.plan)}`,
      );
    }
    const verdict = (observations.criteriaVerdicts ?? []).find((row) =>
      row.startsWith(`${stated.id} `),
    );
    if (verdict === undefined) {
      problems.push(`no evidence verdict reached the operator criterion ${stated.id}`);
    } else if (!new RegExp(`^${stated.id} PASS/VERIFIED gateIds=\\["VG-\\d+"\\]`).test(verdict)) {
      problems.push(`operator criterion is not machine-verified: ${verdict}`);
    }
  }
  if (!observations.oracleWorkspace) problems.push('no workspace to judge');
  if (observations.patchIdentityCurrent !== true) {
    problems.push(
      `the patch identity on record (${String(observations.recordedPatchIdentity)}) does not re-derive from the bytes now in the run workspace (${String(observations.rederivedPatchIdentity)})`,
    );
  }
  if (observations.preconditionMatches !== true) {
    problems.push(
      `Stage 7's own precondition for the verified patch is not MATCHED: ${String(observations.preconditionStatus)}`,
    );
  }
  if (observations.patchScopeAgrees !== true) {
    problems.push(
      `Git reads the patch as ${JSON.stringify(observations.patchFiles)}, not the ${JSON.stringify(EXPECTED_PATCH_FILES)} this run was asked to change`,
    );
  }
  if (prApproved(byLabel) === false) problems.push('no locally approved publication candidate');
  return {
    ok: problems.length === 0,
    reason:
      problems.length === 0
        ? 'the documented chain ran end to end on a linked-worktree checkout'
        : problems.join('; '),
  };
}

function prApproved(byLabel) {
  const approved = byLabel.get('pr-approve');
  if (!approved) return false;
  return approved.json?.approved === true && approved.exitCode === 3;
}

/** What the customer must never lose, compared before and after the scenario. */
function customerDamage(before, after, environment) {
  const problems = [];
  if (before.workspaceHead !== after.workspaceHead) {
    problems.push(`primary HEAD moved ${before.workspaceHead} -> ${after.workspaceHead}`);
  }
  if (before.workspaceBranch !== after.workspaceBranch) {
    problems.push(`primary branch moved ${before.workspaceBranch} -> ${after.workspaceBranch}`);
  }
  if (before.parentHead !== after.parentHead) {
    problems.push(`parent clone HEAD moved ${before.parentHead} -> ${after.parentHead}`);
  }
  if (before.parentStatus !== after.parentStatus) {
    problems.push('the parent clone gained or lost a change');
  }
  problems.push(...worktreeDamage(before.worktrees, after.worktrees, environment));
  if (before.gitdirPointer !== after.gitdirPointer) {
    problems.push(
      `the checkout's gitdir pointer changed (${before.gitdirPointer} -> ${after.gitdirPointer})`,
    );
  }
  for (const name of Object.keys(before.workspaceTracked)) {
    const was = before.workspaceTracked[name];
    const now = after.workspaceTracked[name];
    if (now === undefined) problems.push(`tracked file lost: ${name}`);
    else if (name === 'package.json' && was !== now)
      problems.push(`${name} changed before any stage could write it`);
  }
  if (before.workspaceStatus.trim() && !after.workspaceStatus.trim()) {
    problems.push('a pre-existing dirty state was cleaned by the run');
  }
  return problems;
}

/**
 * The worktree registration, compared checkout by checkout.
 *
 * A count would be the wrong instrument: Stage 5 registers the run's own worktree
 * under `<primary>/.mergesutra/worktrees/` and leaves it there — that is documented
 * residue of a run (Stage 12's register says so), and calling it customer damage
 * would let the harness blame the product for the workspace it was told to use.
 * What must not move is anything that was registered before the run began: the
 * customer's own checkouts, with their HEADs and their branches.
 */
function worktreeDamage(before, after, environment) {
  const problems = [];
  // Git canonicalises the path it registers, so on Windows the same directory can
  // be spelled two ways (`…\PAVITH~1\…` and `…\Pavithran R A\…`). Both sides of
  // this comparison go through the filesystem first; comparing the strings as they
  // were typed would call a run's own worktree "registered outside this run".
  const runResidue = `${longPath(normalizePath(environment.workspace))}/.mergesutra/worktrees/`;
  const byPath = new Map(after.map((entry) => [longPath(entry.path), entry]));
  const seen = new Set(before.map((entry) => longPath(entry.path)));
  for (const entry of before) {
    const now = byPath.get(longPath(entry.path));
    if (!now) {
      problems.push(`worktree unregistered: ${entry.path}`);
    } else if (now.head !== entry.head || now.branch !== entry.branch) {
      problems.push(
        `worktree ${entry.path} moved ${entry.head}/${entry.branch} -> ${now.head}/${now.branch}`,
      );
    }
  }
  for (const entry of after) {
    if (seen.has(longPath(entry.path))) continue;
    if (!longPath(normalizePath(entry.path)).startsWith(runResidue)) {
      problems.push(`worktree registered outside this run: ${entry.path}`);
    }
  }
  return problems;
}

/** The path as the filesystem spells it, lower-cased; falls back to the given text. */
function longPath(text) {
  const lowered = String(text).toLowerCase();
  try {
    return normalizePath(realpathSync.native(String(text))).toLowerCase();
  } catch {
    return lowered;
  }
}

/* ----------------------------------------------------------------------- shared */

function workspacePath(environment, runId) {
  return path.join(environment.workspace, '.mergesutra', 'worktrees', runId);
}

function runIdOf(step) {
  const id = step?.json?.record?.runId ?? step?.json?.runId ?? null;
  if (typeof id !== 'string') throw new Error(`${step?.label ?? 'a stage'} produced no run id`);
  return id;
}

function textOf(step) {
  return `${step.stdout ?? ''}\n${step.stderr ?? ''}`;
}

/** One named readiness condition, as the product itself reported it. */
function readinessCheck(step, name) {
  const check = (step.json?.checks ?? []).find((entry) => entry.name?.includes(name));
  return check?.status ?? null;
}

/**
 * Which directory a verification round measured, by its last three path segments.
 *
 * The temp tree this product runs in is spelled both in full and in the 8.3 short
 * form Windows hands out, so a whole-path comparison fails on a measurement that
 * was always of the right place. The tail — `.mergesutra/worktrees/<run id>` — is
 * spelled one way, and naming the wrong repository cannot hide inside it.
 */
function workspaceTail(verification) {
  const workspace = verification?.workspace;
  if (typeof workspace !== 'string') return null;
  return workspace.toLowerCase().split(/[\\/]/).slice(-3).join('/');
}

/**
 * A readiness condition that is not met.
 *
 * The screen marks a met condition `INFO`, an unmet one `WARN`, and reserves `FAIL`
 * for a step that could not be carried out at all, so either of the last two is the
 * gap; insisting on one word would turn a display choice into a requirement.
 */
const NOT_SATISFIED = ['WARN', 'FAIL'];

function parseJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
}

function gateExitCodes(record) {
  return (record?.verification?.gates ?? []).map((gate) => {
    const receipt = gate.receipt ?? {};
    return `${gate.gateId}=${String(receipt.result ?? gate.status)}${
      receipt.exitCode === null || receipt.exitCode === undefined
        ? ''
        : ` exit=${String(receipt.exitCode)}`
    }`;
  });
}

/**
 * What Stage 7 concluded about each criterion, in its own words.
 *
 * The contract's `criteria[].status` is the obligation's lifecycle field and stays
 * `PENDING` in the record; the verdict a reviewer quotes is the evidence mapping,
 * so this reads the mapping. A gate that ran and failed must never leave a
 * criterion looking passed, and a gate that ran and passed must not leave one
 * looking available unless something actually bound the two together.
 */
function criterionVerdicts(record) {
  return (record?.evidence?.criteria ?? []).map(
    (criterion) =>
      `${criterion.criterionId} ${criterion.status}/${criterion.sufficiency} gateIds=${JSON.stringify(
        criterion.gateIds ?? [],
      )}`,
  );
}

/** Which criteria each planned gate claims to be evidence for. */
function gateCriterionBindings(record) {
  return (record?.verificationPlan?.gates ?? []).map(
    (gate) => `${gate.id} ${gate.command} -> ${JSON.stringify(gate.relevantCriteria ?? [])}`,
  );
}

/* -------------------------------------------------------------------- dispatch */

// Last, not first: the scenario table is a module-level `const`, and running the
// qualification from the top of the file would reach it before it is initialised.
if (unknown === undefined) {
  await runRequested(only);
}
