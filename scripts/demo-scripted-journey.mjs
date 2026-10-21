import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { digestForPath, startScriptedGateway } from './lib/scripted-gateway.mjs';
import {
  CUSTOMER_BASE_SHA,
  CUSTOMER_ISSUE_URL,
  CUSTOMER_REPOSITORY_URL,
} from './lib/customer-environment.mjs';
import { runCustomerOracle } from './lib/customer-oracle.mjs';

/**
 * A competition demonstration of the production CLI, from a real GitHub issue to
 * an approved publication page, with the model replaced below the process
 * boundary.
 *
 * The subject is the public customer fixture
 * `Pavithran-R-A/mergesutra-e2e-fixture`, whose issue #1 asks for one small,
 * checkable change and whose whole gate is `npm test`. The earlier attempt at
 * this repository's own issue #8 ran the full 17-gate plan inside a 512 MB
 * container and honestly ended `VERIFICATION_FAIL`; the fixture exists for
 * exactly this journey, so the demonstration uses it rather than pretending the
 * heavy plan passed.
 *
 * The only substitution is the model: `startScriptedGateway` answers the same
 * HTTP request the BharatCode adapter sends, and every other byte on screen is
 * produced by `dist/bin.js`, real Git, and the repository's own gate running in
 * the digest-pinned container. This is therefore a demonstration of the
 * *workflow*, not of a model's competence — the real-model evidence is the
 * separate, dated live run named in the README.
 *
 * The journey stops after `pr --approve <digest>`. `pr --publish` is shown in
 * the screen's next-step line and is deliberately never invoked: no branch is
 * pushed and no draft pull request is opened by this harness.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'dist', 'bin.js');
const REPOSITORY_URL = CUSTOMER_REPOSITORY_URL;
const ISSUE_URL = CUSTOMER_ISSUE_URL;
const BRANCH = 'main';
const SCRIPTED_MODEL = 'scripted-demo-model';
const SCRIPTED_KEY = 'scripted-demo-not-a-real-credential';
const DEFAULT_IMAGE =
  'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';
const ALLOWED_PATHS = ['src/slugify.js', 'test/slugify.test.js'];

const SLUGIFY_SOURCE = `/**
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

const TEST_SOURCE = `import assert from 'node:assert/strict';
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

test('trims the hyphens left by surrounding spaces', () => {
  assert.equal(slugify('  Hello  World  '), 'hello-world');
});

test('trims hyphens from both ends of a punctuation-wrapped title', () => {
  assert.equal(slugify('--x--'), 'x');
});
`;

const FILES = [
  {
    path: 'src/slugify.js',
    content: SLUGIFY_SOURCE,
    criterionIds: ['AC-1', 'AC-2', 'AC-3'],
  },
  {
    path: 'test/slugify.test.js',
    content: TEST_SOURCE,
    criterionIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
  },
];

const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next !== undefined && !next.startsWith('--')) {
    options.set(token, next);
    index += 1;
  } else {
    options.set(token, true);
  }
}

const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, '');
const outRoot = path.resolve(
  options.get('--out') ?? path.join(os.tmpdir(), `mergesutra-demo-${stamp}`),
);
const clonePath = path.join(outRoot, 'fixture');
const logRoot = path.join(outRoot, 'logs');
const transcriptPath = path.join(outRoot, 'transcript.txt');
const summaryPath = path.join(outRoot, 'summary.json');
const procedurePath = path.join(outRoot, 'PROCEDURE.md');

const transcript = [];
const steps = [];
const durations = {};
let gateway;
let callCount = 0;
const callKinds = { plan: 0, implement: 0, review: 0 };
let fixtureBefore = null;
let runId = null;
let digest = null;

function sanitize(text) {
  return String(text)
    .split(SCRIPTED_KEY)
    .join('[REDACTED]')
    .replace(/\bbc_live_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '[REDACTED]');
}

function emit(title, body = '') {
  const text = `${title}\n${body}`.replace(/\n+$/, '');
  transcript.push(text);
  process.stdout.write(`\n${text}\n`);
}

function section(title, note = '') {
  emit(`\n${'='.repeat(78)}\n${title}${note ? `\n${note}` : ''}\n${'='.repeat(78)}`);
}

function fail(message) {
  const safe = sanitize(message);
  emit(`DEMONSTRATION_FAILURE: ${safe}`);
  throw new Error(safe);
}

function whichDocker() {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(lookup, ['docker'], { encoding: 'utf8', windowsHide: true });
  return (found.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && path.isAbsolute(line));
}

function dockerExecutable() {
  const configured = process.env.MERGESUTRA_DOCKER_EXECUTABLE;
  if (configured) return configured;
  const resolved = whichDocker();
  if (!resolved) fail('no absolute Docker executable; set MERGESUTRA_DOCKER_EXECUTABLE');
  return resolved;
}

function sandboxEnv() {
  return {
    MERGESUTRA_SANDBOX_IMAGE: process.env.MERGESUTRA_SANDBOX_IMAGE ?? DEFAULT_IMAGE,
    MERGESUTRA_DOCKER_EXECUTABLE: dockerExecutable(),
  };
}

function cliEnv(baseUrl) {
  return {
    ...process.env,
    NO_COLOR: '1',
    BHARATCODE_API_BASE: baseUrl,
    BHARATCODE_API_KEY: SCRIPTED_KEY,
    BHARATCODE_MODEL: SCRIPTED_MODEL,
    BHARATCODE_TIMEOUT_MS: '20000',
    BHARATCODE_MAX_RETRIES: '0',
    ...sandboxEnv(),
  };
}

function spawnCapture(file, args, { cwd, env, timeoutMs = 600_000, label } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}${String(error)}`,
        timedOut,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut, label });
    });
  });
}

async function cli(label, args, expected, { timeoutMs = 600_000 } = {}) {
  section(`$ mergesutra ${args.join(' ')}`);
  const started = Date.now();
  const result = await spawnCapture(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: cliEnv(gateway.baseUrl),
    timeoutMs,
    label,
  });
  const elapsed = Date.now() - started;
  durations[label] = elapsed;
  const record = {
    label,
    argv: ['mergesutra', ...args],
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    elapsedMs: elapsed,
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  };
  steps.push(record);
  await writeFile(
    path.join(
      logRoot,
      `${String(steps.length).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.log`,
    ),
    `exit=${String(result.exitCode)}\nsignal=${result.signal ?? ''}\ntimedOut=${String(
      result.timedOut,
    )}\n\n[stdout]\n${record.stdout}\n\n[stderr]\n${record.stderr}\n`,
    'utf8',
  );
  // The transcript is the complete record the docs promise: the section header
  // above names the command, and the product's own screen follows it verbatim.
  if (record.stdout.trim().length > 0) emit(record.stdout.replace(/\n+$/, ''));
  if (record.stderr.trim().length > 0) emit(`[stderr]\n${record.stderr.replace(/\n+$/, '')}`);
  if (result.timedOut) fail(`${label} exceeded ${String(timeoutMs)} ms and was stopped`);
  if (!expected.includes(result.exitCode)) {
    fail(
      `${label} exited ${String(result.exitCode)}; expected ${expected.join(
        ' or ',
      )}. Screen above is the product's own output.`,
    );
  }
  return record;
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout;
}

async function trackedSnapshot(repo) {
  const names = git(['ls-files', '-z'], repo).split('\0').filter(Boolean).sort();
  const snapshot = {};
  for (const name of names) {
    snapshot[name] = createHash('sha256')
      .update(await readFile(path.join(repo, name)))
      .digest('hex');
  }
  return snapshot;
}

async function readRecord() {
  const file = path.join(ROOT, '.mergesutra', 'runs', `${runId}.json`);
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Every stage files its own record, and the next stage is addressed by the id a
 * screen just printed. Pinning the intake id would silently ask `plan` to work
 * against a record that never saw a contract, so the id advances after each
 * command exactly as it does for an operator.
 */
function advanceRunId(record) {
  const match = /Run record:\s+.*?((run-\d{8}T\d{6}Z-[0-9a-f]+))\.json/.exec(record.stdout);
  if (!match) fail(`${record.label} printed no run record path`);
  runId = match[1];
  return runId;
}

/* ------------------------------------------------------------------ responders */

function combinedPrompt(messages) {
  return (messages ?? [])
    .map((message) => (typeof message?.content === 'string' ? message.content : ''))
    .join('\n');
}

function criteriaListedInPlanPrompt(messages) {
  const ids = [...combinedPrompt(messages).matchAll(/^- (AC-\d+) \[[a-z]+\] /gm)].map(
    (match) => match[1],
  );
  if (ids.length === 0) {
    fail('the plan prompt listed no criterion id; the scripted planner cannot answer it');
  }
  return [...new Set(ids)];
}

function planAnswer(messages) {
  const listed = criteriaListedInPlanPrompt(messages);
  const covered = ['AC-1', 'AC-2', 'AC-3', 'AC-4'].filter((id) => listed.includes(id));
  return JSON.stringify({
    summary: 'Trim the hyphens that leading and trailing separators leave behind.',
    rootCause:
      'slugify replaces every run of non-alphanumeric characters with a hyphen and then stops, so a separator run at either end survives as an edge hyphen.',
    changes: FILES.map((file) => ({
      file: file.path,
      action: 'modify',
      reason: file.path.endsWith('slugify.js')
        ? 'remove a run of hyphens from both ends after collapsing separators'
        : 'assert each input the issue names, keeping the existing coverage',
      criterionIds: file.criterionIds,
    })),
    validationCommands: [
      {
        argv: ['npm', 'test'],
        purpose: 'run the package test script the issue names',
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
            ? 'the plan edits no manifest, so nothing adds a dependency and the existing absence is unchanged'
            : 'no file this plan changes can show this; the validation command is what a reviewer runs',
      })),
    proposedCriteria: [],
    risks: ['A title that is entirely punctuation now slugs to an empty string.'],
    assumptions: ['No caller depends on the trailing hyphen.'],
    questionsForHuman: [],
  });
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

function implementAnswer(messages) {
  const written = acceptedTargets(messages);
  const pending = FILES.find((file) => !written.has(file.path));
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
      reason: 'run the package test script the issue names before finishing',
    });
  }
  return JSON.stringify({
    action: 'FINISH',
    summary: 'both planned files are written and the package test script has run',
    criteriaBelievedComplete: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'],
  });
}

function reviewAnswer() {
  return JSON.stringify({
    summary:
      'the two edits match the plan: separators are trimmed at both ends, the three inputs are asserted, and the existing punctuation assertion survives',
    findings: [],
  });
}

function responder(messages) {
  const prompt = combinedPrompt(messages);
  callCount += 1;
  if (prompt.includes('REFERENCE MANIFEST')) {
    callKinds.review += 1;
    return reviewAnswer(messages);
  }
  if (prompt.includes('criteriaBelievedComplete')) {
    callKinds.implement += 1;
    return implementAnswer(messages);
  }
  if (prompt.includes('Account for EVERY criterion id listed below')) {
    callKinds.plan += 1;
    return planAnswer(messages);
  }
  return undefined;
}

/* ---------------------------------------------------------------------- setup */

function parseReadinessRows(screen) {
  const rows = [];
  for (const line of screen.split(/\r?\n/)) {
    // The pr screen labels each fact `Readiness · <id>` and uses INFO for a fact
    // that holds, WARN for one that does not. The bare severity-first regex used
    // here once captured the label's first word instead of the check id.
    const match = /^(INFO|PASS|WARN|FAIL|SKIP)\s+Readiness · (\S+)/.exec(line);
    if (match) rows.push({ status: match[1], name: match[2] });
  }
  return rows;
}

function statBlock(clone, workspace) {
  section(
    'Real Git state after the implementation loop',
    'Read from the worktree and the primary clone; not narrated.',
  );
  emit(
    [
      '$ git -C <worktree> status --porcelain',
      git(['status', '--porcelain'], workspace).trim() || '(clean)',
      '',
      '$ git -C <worktree> diff --stat <base>',
      git(['diff', '--stat', 'HEAD'], workspace).trim() || '(no diff)',
      '',
      '$ git -C <worktree> diff <base>',
      git(['diff', 'HEAD'], workspace).trim() || '(no diff)',
      '',
      '$ git -C <primary clone> status --porcelain',
      git(['status', '--porcelain'], clone).trim() || '(clean)',
      '',
      '$ git -C <primary clone> worktree list --porcelain',
      git(['worktree', 'list', '--porcelain'], clone).trim(),
    ].join('\n'),
  );
}

async function main() {
  // Only this run's own evidence directory is refreshed: a stale step log beside a
  // fresh one would make two runs look like one.
  await rm(logRoot, { recursive: true, force: true });
  await rm(transcriptPath, { force: true });
  await rm(summaryPath, { force: true });
  await rm(procedurePath, { force: true });
  await rm(path.join(outRoot, 'failure.json'), { force: true });
  await mkdir(logRoot, { recursive: true });

  section(
    'MergeSutra — Scripted-model demonstration',
    [
      'Issue in. Evidence-backed PR out.',
      '',
      'MODEL: a deterministic local stand-in, answered by scripts/lib/scripted-gateway.mjs.',
      'Everything else is the production CLI (dist/bin.js), real Git, and the repository',
      'own gates in the digest-pinned container. This demonstrates the workflow, not a',
      "model's competence; the dated real-BharatCode run is linked in the README.",
      '',
      'The journey stops after --approve. --publish is never invoked.',
    ].join('\n'),
  );

  const version = await spawnCapture(process.execPath, [BIN, '--version'], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (version.exitCode !== 0) fail('the production CLI did not answer --version');
  const sourceHead = git(['rev-parse', 'HEAD'], ROOT).trim();

  section(
    'Building the customer checkout',
    'A fresh clone of the public repository at the advertised main commit.',
  );
  await rm(clonePath, { recursive: true, force: true });
  emit(
    sanitize(
      spawnSync(
        'git',
        ['clone', '--no-tags', '--single-branch', '--branch', BRANCH, REPOSITORY_URL, clonePath],
        {
          cwd: outRoot,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: 180_000,
        },
      ).stderr,
    ),
  );
  const advertised = spawnSync(
    'git',
    ['ls-remote', '--exit-code', REPOSITORY_URL, `refs/heads/${BRANCH}`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 120_000,
    },
  );
  if (advertised.status !== 0) fail('the public main branch is not readable');
  const advertisedSha = advertised.stdout.trim().split(/\s+/)[0] ?? '';
  const baseSha = git(['rev-parse', 'HEAD'], clonePath).trim();
  if (baseSha !== advertisedSha) fail('main moved while the demonstration was cloning it');
  if (baseSha !== CUSTOMER_BASE_SHA) {
    fail(
      `the fixture's main is at ${baseSha}, but this demonstration is written against ${CUSTOMER_BASE_SHA}`,
    );
  }
  emit(`public main at ${baseSha}`);
  emit(`production CLI ${sanitize(version.stdout.trim())} built from source HEAD ${sourceHead}`);
  fixtureBefore = await trackedSnapshot(clonePath);

  gateway = await startScriptedGateway({
    model: SCRIPTED_MODEL,
    respond: responder,
    onCall: () => undefined,
  });
  emit(`scripted gateway listening at ${gateway.baseUrl} (loopback only)`);

  const doctor = await cli('doctor', ['doctor', '--connect'], [0]);
  if (!/PASS/.test(doctor.stdout)) fail('doctor printed no PASS row');

  section('1. GitHub issue → intake', `Issue #1: ${ISSUE_URL}`);
  const issue = await cli('issue', ['issue', ISSUE_URL, '--repo', clonePath], [0]);
  if (!issue.stdout.includes('INTAKE_COMPLETE')) fail('intake did not report INTAKE_COMPLETE');
  if (!issue.stdout.includes(baseSha)) fail('intake did not pin the advertised base commit');
  advanceRunId(issue);
  emit(`run id: ${runId}`);

  section('2. Repository contract', 'What the repository itself declares, and what it cannot see.');
  const inspect = await cli('inspect', ['inspect', clonePath], [0]);
  // The fixture has a declared `test` script and no CI, so the repository level is
  // DECLARED_ONLY here; the verification plan later labels the same gate
  // REPOSITORY_SUGGESTED, which is consentable.
  if (!/DECLARED_ONLY|REPOSITORY_(?:REQUIRED|SUGGESTED)/.test(inspect.stdout)) {
    fail('inspect found no repository gate');
  }
  advanceRunId(inspect);

  section(
    '3. Acceptance contract',
    'Every criterion is PENDING until a gate runs against these bytes.',
  );
  const contract = await cli('contract', ['contract', runId], [0]);
  if (!contract.stdout.includes('CONTRACT_DERIVED')) fail('contract did not derive');
  if (!contract.stdout.includes('AC-1')) fail('the contract does not contain the issue criteria');
  advanceRunId(contract);

  section('4. Plan', 'BharatCode-shaped request goes over HTTP to the deterministic stand-in.');
  const plan = await cli('plan', ['plan', runId], [0]);
  advanceRunId(plan);

  section(
    '5. Implementation',
    'The loop proposes; MergeSutra executes only what its policy allows.',
  );
  const implement = await cli(
    'implement',
    [
      'implement',
      runId,
      '--repo',
      clonePath,
      '--max-steps',
      '8',
      '--max-writes',
      '4',
      '--max-commands',
      '3',
    ],
    [3],
  );
  if (!implement.stdout.includes('COMPLETED_BY_MODEL'))
    fail('implementation did not complete by model');
  const implemented = await readRecord();
  const workspaceRelative = implemented.implementation?.workspace?.relativePath;
  if (
    typeof workspaceRelative !== 'string' ||
    !workspaceRelative.startsWith('.mergesutra/worktrees/')
  ) {
    fail('implementation did not report a confined MergeSutra worktree');
  }
  const workspace = path.resolve(clonePath, workspaceRelative);
  if (!workspace.startsWith(path.resolve(clonePath) + path.sep)) {
    fail('the implementation workspace escaped the clone');
  }
  const changedPaths = (implemented.implementation?.changes ?? []).map(
    (change) => change.relativePath,
  );
  const outside = changedPaths.filter((entry) => !ALLOWED_PATHS.includes(entry));
  if (outside.length > 0) fail(`the patch left the fixture allowlist: ${outside.join(', ')}`);
  statBlock(clonePath, workspace);

  section(
    '6. Verification — consent first',
    'The product names every repository command and refuses to run one without an explicit --allow.',
  );
  const probe = await cli('verify-consent-probe', ['verify', runId, '--repo', clonePath], [4]);
  if (!/VG-\d{3}/.test(probe.stdout) || !/To run the gates above/.test(probe.stdout)) {
    fail('the consent probe did not print the gate list');
  }
  const probed = await readRecord();
  const gates = probed.verificationPlan?.gates ?? [];
  if (gates.length === 0) fail('the verification plan contains no gates');
  // MergeSutra's own check (`git diff --check`) is the one gate it wrote itself, so
  // the probe has already run it; every other gate is the repository's and needs a
  // named consent.
  const consentLevels = new Set(['REPOSITORY_REQUIRED', 'REPOSITORY_SUGGESTED', 'USER_REQUESTED']);
  const gateIds = gates
    .filter((gate) => consentLevels.has(gate.requirementLevel))
    .map((gate) => gate.id);
  const unresolved = gates.filter(
    (gate) =>
      !consentLevels.has(gate.requirementLevel) &&
      gate.requirementLevel !== 'MERGESUTRA_ADDITIONAL',
  );
  if (unresolved.length > 0) {
    fail(
      `a gate in the plan has no consentable level: ${unresolved
        .map((gate) => `${gate.id} ${String(gate.requirementLevel)}`)
        .join(', ')}`,
    );
  }
  if (gateIds.length === 0) fail('the verification plan names no gate a person can consent to');

  section(
    '7. Verification — run',
    'Each gate runs with --network=none in the pinned image. Exit codes, not prose, decide.',
  );
  const allowFlags = gateIds.flatMap((id) => ['--allow', id]);
  const verify = await cli('verify', ['verify', runId, '--repo', clonePath, ...allowFlags], [0], {
    timeoutMs: 3_600_000,
  });
  if (!/VERIFICATION_PASS/.test(verify.stdout)) fail('verification did not report a pass');
  const verified = await readRecord();
  const evidence = verified.evidence ?? null;
  if (!evidence || !Array.isArray(evidence.criteria)) {
    fail('the verified record carries no criteria evidence');
  }

  section(
    '8. Independent acceptance evidence',
    "The product did not decide the issue's criteria; this harness applies the customer's own oracle to the bytes the patch left.",
  );
  const npmCache = path.join(outRoot, 'oracle-npm-cache');
  await mkdir(npmCache, { recursive: true });
  const proof = await runCustomerOracle({ workspace, npmCache });
  emit(
    [
      'INDEPENDENT CUSTOMER ORACLE (measured from the worktree, not from the product)',
      ...proof.results.map((row) => `  ${row.id} ${row.verdict.padEnd(4)} ${row.detail}`),
      `  changes stay inside ${ALLOWED_PATHS.join(', ')}: ${
        outside.length === 0 ? 'yes' : `no (${outside.join(', ')})`
      }`,
    ].join('\n'),
  );
  if (!proof.passed) fail('the independent acceptance oracle did not pass every criterion');

  section('9. Independent review', 'The reviewer reads the exact patch; it edits nothing.');
  const review = await cli(
    'review',
    ['review', runId, '--repo', clonePath, '--max-review-cycles', '1', '--max-repair-cycles', '1'],
    [3],
  );
  if (!/REVIEW_RECORDED/.test(review.stdout)) fail('review did not record an outcome');
  const reviewed = await readRecord();
  const findings = reviewed.review?.findings ?? [];
  if (findings.length !== 0) fail(`review filed ${String(findings.length)} finding(s)`);
  if (reviewed.repairPlan !== null && reviewed.repairPlan !== undefined) {
    fail('review produced a repair plan; the demonstration expects a clean review');
  }
  emit('review: 0 findings, no repair plan');

  section(
    '10. Status and evidence pack',
    'Read-only observation, then the pack a reviewer can open.',
  );
  await cli('status', ['status', runId, '--repo', clonePath], [0]);
  await cli('report', ['report', runId], [0, 3]);

  section(
    '11. The page, before any approval',
    'Readiness is read from the bytes and the records now.',
  );
  const pr = await cli('pr', ['pr', runId, '--repo', clonePath], [3]);
  if (!/NOT_READY_FOR_PUBLICATION/.test(pr.stdout)) {
    fail('the unapproved page did not report NOT_READY_FOR_PUBLICATION');
  }
  const digestMatch = /--approve ([0-9a-f]{64})/.exec(pr.stdout);
  if (!digestMatch) fail('the page printed no 64-hex approval digest');
  digest = digestMatch[1];
  const beforeRows = parseReadinessRows(pr.stdout);
  const beforeWarn = beforeRows.filter((row) => row.status === 'WARN');
  if (
    beforeRows.length !== 8 ||
    beforeWarn.length !== 1 ||
    beforeWarn[0].name !== 'human-approved'
  ) {
    fail(
      `expected eight readiness facts with exactly human-approved failing; saw ${
        beforeRows.map((row) => `${row.status} ${row.name}`).join(', ') || 'none'
      }`,
    );
  }
  emit(`approval digest: ${digest}`);

  section(
    '12. Digest-bound human approval',
    'The only way to say yes is to type the digest of the page above.',
  );
  const approved = await cli(
    'pr-approve',
    ['pr', runId, '--repo', clonePath, '--approve', digest],
    [3],
  );
  for (const required of [
    'HUMAN_APPROVED_FOR_PR',
    'HUMAN APPROVAL RECORDED',
    'REMOTE PUBLICATION NOT ATTEMPTED',
    'NO REMOTE CHANGE HAS BEEN MADE.',
    `--publish`,
  ]) {
    if (!approved.stdout.includes(required)) {
      fail(`the approval screen did not contain ${JSON.stringify(required)}`);
    }
  }
  const afterRows = parseReadinessRows(approved.stdout);
  const afterWarn = afterRows.filter((row) => row.status !== 'INFO' && row.status !== 'PASS');
  if (afterWarn.length !== 0) {
    fail(
      `approval left a non-passing readiness fact: ${afterWarn
        .map((row) => `${row.status} ${row.name}`)
        .join(', ')}`,
    );
  }
  const approvedFact = afterRows.find((row) => row.name === 'human-approved');
  if (approvedFact === undefined || approvedFact.status === 'WARN') {
    fail('the approval screen did not show human-approved as a fact that now holds');
  }
  emit('publication capability is shown on screen; it was not invoked.');

  section('13. No customer damage', 'The primary clone and its tracked bytes are measured again.');
  const fixtureAfter = await trackedSnapshot(clonePath);
  const unchanged = JSON.stringify(fixtureBefore) === JSON.stringify(fixtureAfter);
  const cloneStatus = git(['status', '--porcelain'], clonePath).trim();
  emit(`tracked bytes unchanged: ${String(unchanged)}`);
  emit(`primary clone status: ${cloneStatus || '(clean)'}`);
  if (!unchanged) fail('the primary clone changed during the demonstration');
  if (cloneStatus !== '') fail('the primary clone is dirty after the demonstration');

  const finalRecord = await readRecord();
  const summary = {
    kind: 'scripted-model-demonstration',
    label:
      'Scripted-model demonstration: the model is a deterministic local stand-in; every command is the production CLI.',
    date: new Date().toISOString(),
    repository: { url: REPOSITORY_URL, branch: BRANCH, baseSha },
    source: { head: sourceHead, cliVersion: sanitize(version.stdout.trim()) },
    model: {
      mode: 'scripted',
      name: SCRIPTED_MODEL,
      requestCount: callCount,
      byStage: callKinds,
    },
    runId,
    stages: steps.map((step) => ({
      label: step.label,
      argv: step.argv,
      exitCode: step.exitCode,
      signal: step.signal,
      elapsedMs: step.elapsedMs,
    })),
    implementation: {
      status: implemented.implementation?.status ?? null,
      changedPaths,
      writes: implemented.implementation?.summary?.writes ?? null,
      commands: implemented.implementation?.summary?.commands ?? null,
    },
    verification: {
      exitCode: verify.exitCode,
      allowedGates: gateIds,
      gates: (probed.verificationPlan?.gates ?? []).map((gate) => ({
        id: gate.id,
        name: gate.name,
        command: gate.command,
        requirementLevel: gate.requirementLevel,
      })),
      criteria: (evidence.criteria ?? []).map((criterion) => ({
        id: criterion.criterionId,
        status: criterion.status,
        sufficiency: criterion.sufficiency,
        gateIds: criterion.gateIds,
      })),
    },
    review: {
      exitCode: review.exitCode,
      findings: findings.length,
      repairPlan: finalRecord.repairPlan !== null && finalRecord.repairPlan !== undefined,
    },
    readiness: {
      beforeApproval: beforeRows,
      afterApproval: afterRows,
      publicationDigest: digest,
    },
    publication: { approved: true, published: false, publishInvoked: false },
    independentOracle: proof,
    customerDamage: { trackedBytesUnchanged: unchanged, primaryCloneStatus: cloneStatus },
    fixturePathsTouched: changedPaths,
    durationsMs: durations,
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(transcriptPath, `${transcript.join('\n\n')}\n`, 'utf8');
  await writeFile(procedurePath, procedureText(), 'utf8');

  section(
    'DEMONSTRATION COMPLETE',
    [
      `run id:            ${runId}`,
      `base commit:       ${baseSha}`,
      `approval digest:   ${digest}`,
      `published:         no (--publish was never invoked)`,
      '',
      `transcript:        ${transcriptPath}`,
      `summary:           ${summaryPath}`,
      `procedure:         ${procedurePath}`,
      `per-command logs:  ${logRoot}`,
      `checkout:          ${clonePath}`,
    ].join('\n'),
  );
}

function procedureText() {
  return `# MergeSutra — Scripted-model demonstration procedure

This is a reproducible **scripted-model demonstration** of the production CLI on
the public customer fixture \`Pavithran-R-A/mergesutra-e2e-fixture\` (issue #1).
The model is a deterministic local HTTP stand-in
(\`scripts/lib/scripted-gateway.mjs\`); BharatCode itself is not called. Every other
step — intake, contract, plan request, bounded loop, sandboxed gate, review,
evidence pack, digest and approval — is the real product.

The journey stops after \`pr --approve <digest>\`. \`pr --publish\` is shown by the
product as the next step and is deliberately not run: no branch is pushed and no
draft pull request is opened.

## Prerequisites

- Node.js 22 or newer, Git, and Docker with the pinned image present:
  \`node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7\`
- A build of the production CLI: \`npm run build\` (creates \`dist/bin.js\`).
- Network access for the public clone. The fixture declares no dependencies, so
  no install step is needed.
- On Windows, Git Bash; set \`MERGESUTRA_DOCKER_EXECUTABLE\` to the absolute
  \`docker.exe\` path if \`where docker\` does not find it.

## Run

\`\`\`bash
npm run build
node scripts/demo-scripted-journey.mjs --out "<an absolute directory outside the repository>"
\`\`\`

The driver:

1. reads the fixture's public \`main\` commit advertised by GitHub and clones it,
   refusing to run if the commit is not the one this demonstration was written for;
2. starts the scripted gateway on loopback;
3. runs \`doctor --connect\`, \`issue\`, \`inspect\`, \`contract\`, \`plan\`,
   \`implement\`, \`verify\` (consent probe then allowed run), \`review\`,
   \`status\`, \`report\`, \`pr\`, and \`pr --approve <digest>\`;
4. re-runs the customer's own oracle (the issue's five criteria) against the
   worktree bytes, outside the product's records;
5. proves the primary clone's tracked bytes did not change;
6. writes \`transcript.txt\`, \`summary.json\`, \`PROCEDURE.md\` and per-command logs.

## What the transcript proves, and what it does not

It proves the workflow's screens, exit codes, digest, and Git/Docker facts are
produced by the committed product. It does **not** prove model quality, model
latency, or a BharatCode network path. The dated real-model evidence is reported
separately in the README, with its own source SHA and limitations.

An earlier attempt drove this repository's own issue #8 instead. Its gate plan is
this repository's full 17-gate plan; under the product's 512 MB, one-CPU sandbox
several gates timed out or aborted, and the run honestly ended
\`VERIFICATION_FAIL\` (exit 3). That evidence is kept beside this one, not edited.
`;
}

try {
  await main();
} catch (error) {
  try {
    await writeFile(
      path.join(outRoot, 'failure.json'),
      `${JSON.stringify(
        {
          kind: 'scripted-model-demonstration',
          error: sanitize(error instanceof Error ? error.message : String(error)),
          steps: steps.map((step) => ({
            label: step.label,
            exitCode: step.exitCode,
            signal: step.signal,
          })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(transcriptPath, `${transcript.join('\n\n')}\n`, 'utf8');
  } catch {
    // The failure still reaches stderr through the throw below.
  }
  throw error;
} finally {
  await gateway?.close().catch(() => undefined);
}
