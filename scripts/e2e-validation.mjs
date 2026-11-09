import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  changesOutsideAllowlist,
  inspectFixtureAcceptance,
  liveQualificationFailures,
  MAX_MODEL_COMPLETIONS,
} from './lib/live-qualification.mjs';
import { budgetConfigRefusals, ledgerRefusals, liveChildEnv } from './lib/live-budget.mjs';
import { countLedgerReservations } from './lib/live-failure-budget.mjs';
import {
  COMPACT_ALLOWED_PATHS,
  inspectCompactAcceptance,
} from './lib/compact-qualification.mjs';
import {
  PACK_FILE_NAMES,
  buildPublicationBundle,
  writePublicationBundle,
} from './lib/publication-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'dist', 'bin.js');
// A compact standalone repo demonstrates the issue-to-draft-PR path without
// inheriting this product's large, unrelated repository-wide CI. The original
// full-repository qualification remains available and is never reclassified.
const FIXTURE_PROFILE =
  process.argv[2] === 'live' ? (process.env.MERGESUTRA_E2E_FIXTURE ?? 'full') : 'full';
if (FIXTURE_PROFILE !== 'full' && FIXTURE_PROFILE !== 'compact') {
  process.stderr.write('Unrecognized fixture profile; select full or compact.\\n');
  process.exit(64);
}
const FIXTURE_REPO =
  FIXTURE_PROFILE === 'compact' ? 'Pavithran-R-A/mergesutra-e2e-fixture' : 'Pavithran-R-A/mergesutra';
const FIXTURE_NUMBER = FIXTURE_PROFILE === 'compact' ? 1 : 8;
const FIXTURE_URL = `https://github.com/${FIXTURE_REPO}.git`;
const ISSUE_URL = `https://github.com/${FIXTURE_REPO}/issues/${FIXTURE_NUMBER}`;
const FIXTURE_BRANCH = 'main';
const ALLOWED_MODELS = new Set(['qwen-3.8-27b', 'deepseek-v4.1-flash']);
const LIVE_DEADLINE_MS = 25 * 60_000;

const mode = process.argv[2];
if (mode !== 'no-key' && mode !== 'live') {
  process.stderr.write('usage: node scripts/e2e-validation.mjs <no-key|live>\n');
  process.exit(64);
}

const startedAt = Date.now();
const scratch = await mkdtemp(path.join(tmpdir(), `mergesutra-${mode}-e2e-`));
const fixture = path.join(scratch, 'fixture');
const exportRoot = path.join(ROOT, '.mergesutra', 'live-validation-export');
const logRoot = path.join(exportRoot, `${mode}-logs`);
await rm(exportRoot, { recursive: true, force: true });
await mkdir(logRoot, { recursive: true });

const secret = process.env.BHARATCODE_API_KEY ?? '';
const configuredModel = process.env.BHARATCODE_MODEL ?? '';
let budgetNotes = [];

if (mode === 'live') {
  if (secret.length < 8) fail('BHARATCODE_API_KEY is not configured; no model request was sent.');
  if (!ALLOWED_MODELS.has(configuredModel)) {
    fail(
      `BHARATCODE_MODEL must be one of ${[...ALLOWED_MODELS].join(', ')}; no model request was sent.`,
    );
  }
  // The ceiling has to be installed before the first child starts, not merely configured
  // somewhere upstream: the product counts only when both names reach it, so a chain whose
  // ledger went missing spends freely and still prints a number at the end. Both checks run
  // here, on the parent's own environment, because every child is built from it.
  const configuration = budgetConfigRefusals({ env: process.env });
  if (configuration.length > 0) {
    fail(`${configuration.join('; ')}; no model request was sent.`);
  }
  const ledger = await ledgerRefusals({ ledger: process.env.BHARATCODE_REQUEST_LEDGER });
  if (ledger.refusals.length > 0) {
    fail(`${ledger.refusals.join('; ')}; no model request was sent.`);
  }
  budgetNotes = ledger.notes;
} else {
  delete process.env.BHARATCODE_API_KEY;
  delete process.env.BHARATCODE_KEY;
  delete process.env.BHARATCODE_MODEL;
}

const steps = [];
let rawLeak = false;

function sanitized(text) {
  let out = text;
  if (secret) out = out.split(secret).join('[REDACTED]');
  return out
    .replace(/\bbc_live_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '[REDACTED]');
}

function hasRawSecret(text) {
  if (secret && text.includes(secret)) return true;
  return (
    /\bbc_live_[A-Za-z0-9_-]{8,}/.test(text) ||
    /\bsk-[A-Za-z0-9_-]{8,}/.test(text) ||
    /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/.test(text)
  );
}

function remainingMs() {
  if (mode !== 'live') return 8 * 60_000;
  return Math.max(1_000, LIVE_DEADLINE_MS - (Date.now() - startedAt));
}

function childEnv({ publicGit = false } = {}) {
  // The names stripped for repository-facing children live in `live-budget.mjs`, next to the
  // rule they exist to protect: the budget pair must survive into every child, because a
  // stage that cannot see the ledger is a stage that spends without counting.
  return liveChildEnv({ env: process.env, publicGit });
}

function exec(label, file, args, options = {}) {
  if (mode === 'live' && Date.now() - startedAt >= LIVE_DEADLINE_MS) {
    fail('live validation hit the 25-minute wall-clock ceiling before the next command');
  }
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? childEnv(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: Math.min(options.timeoutMs ?? remainingMs(), remainingMs()),
    maxBuffer: 8 << 20,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (hasRawSecret(stdout) || hasRawSecret(stderr)) rawLeak = true;
  const record = {
    label,
    file,
    args,
    exitCode: result.status,
    signal: result.signal,
    stdout: sanitized(stdout),
    stderr: sanitized(stderr),
  };
  steps.push(record);
  return record;
}

async function writeStep(record, index) {
  const name = String(index + 1).padStart(2, '0') + '-' + record.label.replace(/[^a-z0-9]+/gi, '-');
  await writeFile(
    path.join(logRoot, `${name}.log`),
    [
      `exit=${String(record.exitCode)}`,
      `signal=${record.signal ?? ''}`,
      '',
      '[stdout]',
      record.stdout,
      '',
      '[stderr]',
      record.stderr,
      '',
    ].join('\n'),
    'utf8',
  );
}

function assertExit(record, allowed) {
  if (!allowed.includes(record.exitCode)) {
    const detail = [
      `${record.label} exited ${String(record.exitCode)}; expected one of ${allowed.join(', ')}`,
      record.stdout.trim() ? `stdout: ${record.stdout.trim().slice(0, 1200)}` : '',
      record.stderr.trim() ? `stderr: ${record.stderr.trim().slice(0, 1200)}` : '',
    ]
      .filter(Boolean)
      .join(' | ');
    fail(detail);
  }
}

function parseJson(record) {
  try {
    return JSON.parse(record.stdout.trim());
  } catch {
    fail(`${record.label} did not produce parseable JSON`);
  }
}

function cli(label, args, allowed) {
  const record = exec(label, process.execPath, [BIN, '--json', ...args]);
  assertExit(record, allowed);
  return { record, json: parseJson(record) };
}

function git(label, args, cwd = ROOT, options = {}) {
  return exec(label, 'git', args, { cwd, ...options });
}

async function trackedSnapshot(repo) {
  const listing = git('fixture-ls-files', ['ls-files', '-z'], repo);
  assertExit(listing, [0]);
  const names = listing.stdout.split('\0').filter(Boolean).sort();
  const out = {};
  for (const name of names) {
    const bytes = await readFile(path.join(repo, name));
    out[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return out;
}

async function scanTree(root) {
  const findings = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full);
      if (info.size > 2 * 1024 * 1024) continue;
      const bytes = await readFile(full);
      if (bytes.includes(0)) continue;
      const text = bytes.toString('utf8');
      if (hasRawSecret(text)) findings.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return findings;
}

function fail(message) {
  const safe = sanitized(String(message));
  process.stderr.write(`LIVE_VALIDATION_FAILURE: ${safe}\n`);
  throw new Error(safe);
}

/**
 * How many completion slots the ledger actually holds.
 *
 * Only names shaped exactly like the markers `reserveCompletion` writes are counted, so a
 * stray file in the directory is not reported as a paid request. The ledger path itself never
 * appears in the result or in anything derived from it: the summary is uploaded as an
 * artifact, and a local operator's ledger sits wherever their home directory is.
 *
 * An unreadable directory returns null rather than 0. A count that could not be taken must
 * not read as a run that asked for nothing.
 */
async function countReservations() {
  return countLedgerReservations({
    mode,
    ledgerDirectory: process.env.BHARATCODE_REQUEST_LEDGER,
  });
}

/**
 * Turn the live run's own page into the artifact the write-scoped job consumes.
 *
 * Nothing here is a second opinion about the run: the patch is re-measured with
 * the product's Stage 7 code, the pack is re-hashed with Stage 8's identity, and
 * the digest is re-derived from the candidate Stage 10 printed. A disagreement
 * stops the export instead of shipping an artifact whose parts describe different
 * things. The artifact carries exact bytes, so it is also the last place a raw
 * credential could leave the machine — decoded file content, the record and the
 * pack are scanned before the bundle is allowed to exist.
 */
async function exportPublicationBundle({ prJson, fixture, exportRoot }) {
  const candidate = prJson?.candidate;
  const digest = prJson?.digest;
  if (!candidate || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    fail(
      'the real-model run produced no approval digest, so it has no page that could be ' +
        'published; no publication bundle was written',
    );
  }

  const { describePatch } = await import('../dist/verify/patch.js');
  const { packIdentityOf } = await import('../dist/report/pack.js');
  const { publicationDigestOf } = await import('../dist/pr/digest.js');

  const record = prJson.record;
  const runId = record?.runId;
  const workspaceRelative = record?.implementation?.workspace?.relativePath;
  const baseSha = record?.implementation?.workspace?.baseSha;
  if (
    typeof runId !== 'string' ||
    typeof workspaceRelative !== 'string' ||
    !workspaceRelative.startsWith('.mergesutra/worktrees/') ||
    typeof baseSha !== 'string'
  ) {
    fail('the pr-stage record does not name the implementation workspace it measured');
  }
  if (candidate.baseSha !== baseSha) {
    fail('the candidate and the recorded workspace name different base commits');
  }
  const workspace = path.resolve(fixture, workspaceRelative);
  if (!workspace.startsWith(path.resolve(fixture) + path.sep)) {
    fail('the implementation workspace escaped the fixture clone');
  }

  const patch = await describePatch({ workspace, baseSha });
  if (patch.identity !== candidate.patchIdentity) {
    fail(
      'the workspace moved after the page was assembled; the candidate digest describes bytes that are gone',
    );
  }
  if (publicationDigestOf(candidate) !== digest) {
    fail('the reported approval digest does not describe the reported candidate');
  }

  const runsRoot = path.join(ROOT, '.mergesutra', 'runs');
  const recordText = await readFile(path.join(runsRoot, `${runId}.json`), 'utf8');
  const packText = {};
  for (const name of PACK_FILE_NAMES) {
    packText[name] = await readFile(path.join(runsRoot, runId, name), 'utf8');
  }
  const packIdentity = packIdentityOf(packText);
  if (packIdentity !== candidate.evidencePackIdentity) {
    fail('the evidence pack on disk is not the pack the page names');
  }
  if (hasRawSecret(recordText) || hasRawSecret(JSON.stringify(packText))) {
    fail(
      'a credential-shaped value reached the run record or evidence pack; no bundle was written',
    );
  }

  const sourceRunUrl =
    process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const bundle = await buildPublicationBundle({
    runId,
    repository: candidate.repository,
    baseSha: candidate.baseSha,
    targetBranch: candidate.targetBranch,
    proposedBranch: candidate.proposedBranch,
    patchIdentity: patch.identity,
    evidencePackIdentity: packIdentity,
    publicationDigest: digest,
    candidate,
    patch,
    workspace,
    recordText,
    packText,
    sourceRunUrl,
  });

  const leaked = bundle.patch.files
    .filter((file) => typeof file.contentBase64 === 'string')
    .filter((file) => hasRawSecret(Buffer.from(file.contentBase64, 'base64').toString('utf8')))
    .map((file) => file.path);
  if (leaked.length > 0 || hasRawSecret(JSON.stringify(bundle.candidate))) {
    fail('a credential-shaped value reached the publication bundle; the bundle was not written');
  }

  const written = await writePublicationBundle(path.join(exportRoot, 'publication-bundle'), bundle);
  // Relative to the uploaded export root: the artifact is public to anyone who can
  // read the run, so it must not carry the hosted runner's directory layout.
  return {
    directory: path.relative(exportRoot, written.dir).split(path.sep).join('/'),
    file: path.relative(exportRoot, written.file).split(path.sep).join('/'),
    runId: bundle.identity.runId,
    repository: bundle.identity.repository,
    baseSha: bundle.identity.baseSha,
    targetBranch: bundle.identity.targetBranch,
    proposedBranch: bundle.identity.proposedBranch,
    patchIdentity: bundle.identity.patchIdentity,
    evidencePackIdentity: bundle.identity.evidencePackIdentity,
    publicationDigest: bundle.identity.publicationDigest,
    changedPaths: bundle.identity.changedPaths,
    deletedPaths: bundle.identity.deletedPaths,
    sourceRunUrl: bundle.identity.sourceRunUrl,
  };
}

async function main() {
  const publicProbe = git(
    'fixture-public-probe',
    ['ls-remote', '--exit-code', FIXTURE_URL, `refs/heads/${FIXTURE_BRANCH}`],
    ROOT,
    { env: childEnv({ publicGit: true }), timeoutMs: 60_000 },
  );
  if (publicProbe.exitCode !== 0) {
    fail('the public main branch is not anonymously readable; hosted validation cannot continue');
  }

  const advertisedFixtureSha = publicProbe.stdout.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(advertisedFixtureSha)) {
    fail('the public main branch did not advertise a full commit SHA');
  }

  const clone = git(
    'fixture-clone',
    ['clone', '--no-tags', '--single-branch', '--branch', FIXTURE_BRANCH, FIXTURE_URL, fixture],
    ROOT,
    {
      env: childEnv({ publicGit: true }),
      timeoutMs: 120_000,
    },
  );
  assertExit(clone, [0]);
  const head = git('fixture-head', ['rev-parse', 'HEAD'], fixture);
  assertExit(head, [0]);
  const fixtureSha = head.stdout.trim();
  if (fixtureSha !== advertisedFixtureSha) {
    fail('fixture main moved while validation was cloning it; retry against one stable head');
  }
  const branch = git('fixture-branch', ['branch', '--show-current'], fixture);
  assertExit(branch, [0]);
  if (branch.stdout.trim() !== FIXTURE_BRANCH) {
    fail('fixture clone is not on the repository default main branch');
  }

  const before = await trackedSnapshot(fixture);
  const beforeStatus = git('fixture-status-before', ['status', '--porcelain'], fixture);
  assertExit(beforeStatus, [0]);

  const version = exec('version', process.execPath, [BIN, '--version']);
  assertExit(version, [0]);

  let runId;
  let finalRecord = null;
  let prJson = null;
  let verifyExit = null;
  let planRecord = null;
  let implementRecord = null;
  let verifyRecord = null;
  let reviewRecord = null;
  let fixtureProof = null;
  let publicationBundle = null;

  if (mode === 'no-key') {
    const doctor = exec('doctor-connect', process.execPath, [BIN, 'doctor', '--connect']);
    assertExit(doctor, [1]);

    cli('issue', ['issue', ISSUE_URL, '--repo', fixture], [0]);
    const inspect = cli('inspect', ['inspect', fixture], [0]);
    const contract = cli('contract', ['contract', inspect.json.record.runId], [0]);
    runId = contract.json.record.runId;

    const plan = exec('plan-no-key', process.execPath, [BIN, '--json', 'plan', runId]);
    assertExit(plan, [78]);

    const verify = exec('verify-no-key', process.execPath, [
      BIN,
      '--json',
      'verify',
      runId,
      '--repo',
      fixture,
    ]);
    assertExit(verify, [1, 4]);

    const status = cli('status', ['status', runId, '--repo', fixture], [0]);
    finalRecord = status.json.record;

    const report = cli('report', ['report', runId], [0, 3]);
    finalRecord = report.json.record;

    const pr = exec('pr-no-key', process.execPath, [BIN, '--json', 'pr', runId, '--repo', fixture]);
    assertExit(pr, [4]);
    prJson = parseJson(pr);

    const resume = exec('resume-preview', process.execPath, [BIN, '--json', 'resume', runId]);
    assertExit(resume, [0]);
  } else {
    const doctor = exec('doctor-connect', process.execPath, [BIN, 'doctor', '--connect']);
    assertExit(doctor, [0]);

    cli('issue', ['issue', ISSUE_URL, '--repo', fixture], [0]);
    const inspect = cli('inspect', ['inspect', fixture], [0]);
    // These five bindings are reviewed release-harness policy, not model output.
    // Their executable oracle is outside the issue's allowlisted edit paths.
    // An issue sentence is not evidence until Stage 7 executes its exact gate.
    const trustedCheck =
      FIXTURE_PROFILE === 'compact'
        ? 'node --test scripts/e2e-acceptance-check.mjs'
        : 'node --test scripts/stage14-acceptance-check.mjs';
    const bindings = [1, 2, 3, 4, 5].flatMap((number) => [
      '--bind-check',
      `AC-${number}=${trustedCheck}`,
    ]);
    const contract = cli(
      'contract',
      ['contract', inspect.json.record.runId, '--by', 'MergeSutra release operator', ...bindings],
      [0],
    );
    runId = contract.json.record.runId;

    const plan = cli('plan', ['plan', runId], [0]);
    planRecord = plan.json.record;
    finalRecord = planRecord;
    runId = plan.json.record.runId;

    const implement = cli(
      'implement',
      [
        'implement',
        runId,
        '--repo',
        fixture,
        '--max-steps',
        '8',
        '--max-writes',
        '4',
        '--max-commands',
        '3',
      ],
      [3, 4],
    );
    implementRecord = implement.json.record;
    finalRecord = implementRecord;
    if (implement.record.exitCode === 4) {
      fail('implementation was blocked; evidence was captured but the live chain cannot proceed');
    }

    const workspaceRelative = implement.json.record.implementation?.workspace?.relativePath;
    if (
      typeof workspaceRelative !== 'string' ||
      !workspaceRelative.startsWith('.mergesutra/worktrees/')
    ) {
      fail('implementation did not report a confined MergeSutra worktree');
    }
    const workspace = path.resolve(fixture, workspaceRelative);
    if (!workspace.startsWith(path.resolve(fixture) + path.sep)) {
      fail('implementation workspace escaped the fixture clone');
    }
    const install = exec('workspace-install', 'npm', ['ci'], {
      cwd: workspace,
      env: childEnv({ publicGit: true }),
      timeoutMs: 180_000,
    });
    assertExit(install, [0]);

    const consentProbe = cli('verify-consent-probe', ['verify', runId, '--repo', fixture], [4]);
    finalRecord = consentProbe.json.record;
    const gates = consentProbe.json.record.verificationPlan?.gates ?? [];
    const npmTest = gates.filter(
      (gate) =>
        Array.isArray(gate.argv) &&
        gate.argv.length === 2 &&
        gate.argv[0] === 'npm' &&
        gate.argv[1] === 'test',
    );
    if (npmTest.length !== 1) {
      fail(`expected exactly one npm test gate; observed ${String(npmTest.length)}`);
    }
    const gateId = npmTest[0].id;
    const repositoryGateIds = gates
      .filter(
        (gate) =>
          gate.requirementLevel === 'REPOSITORY_REQUIRED' ||
          gate.requirementLevel === 'REPOSITORY_SUGGESTED' ||
          gate.requirementLevel === 'USER_REQUESTED',
      )
      .map((gate) => gate.id);
    if (!repositoryGateIds.includes(gateId)) {
      fail('the npm test gate was not included in the repository consent set');
    }

    const operatorGates = gates.filter(
      (gate) =>
        gate.provenance?.source === 'USER_SUPPLIED' &&
        Array.isArray(gate.argv) &&
        gate.argv.join(' ') === trustedCheck,
    );
    if (
      operatorGates.length !== 1 ||
      JSON.stringify(operatorGates[0].relevantCriteria) !==
        JSON.stringify(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'])
    ) {
      fail('the five explicit issue acceptance bindings did not survive into Stage 7');
    }

    const allowFlags = repositoryGateIds.flatMap((id) => ['--allow', id]);
    const verify = cli('verify', ['verify', runId, '--repo', fixture, ...allowFlags], [0, 1, 2]);
    verifyExit = verify.record.exitCode;
    verifyRecord = verify.json.record;
    finalRecord = verifyRecord;

    const review = cli(
      'review',
      ['review', runId, '--repo', fixture, '--max-review-cycles', '1', '--max-repair-cycles', '1'],
      [3, 4],
    );
    reviewRecord = review.json.record;
    finalRecord = reviewRecord;

    const status = cli('status', ['status', runId, '--repo', fixture], [0]);
    finalRecord = status.json.record;
    const report = cli('report', ['report', runId], [0, 3, 4]);
    finalRecord = report.json.record;

    const pr = exec('pr', process.execPath, [BIN, '--json', 'pr', runId, '--repo', fixture]);
    assertExit(pr, [3, 4]);
    prJson = parseJson(pr);
  }

  const implementation = implementRecord?.implementation ?? finalRecord?.implementation ?? null;

  if (mode === 'live') {
    // The CLI deliberately records incomplete work as evidence rather than lying
    // about success. A successful workflow must prove the actual fixture task.
    const changed = implementation?.changes?.map((entry) => entry.relativePath) ?? [];
    if (
      changesOutsideAllowlist(changed, FIXTURE_PROFILE === 'compact' ? COMPACT_ALLOWED_PATHS : undefined)
        .length > 0
    ) {
      fail('the model changed a file outside the controlled fixture allowlist');
    }

    // These checks execute only in the isolated worktree, with all secrets and
    // GitHub tokens removed. Repository CI by itself does not cover AC-1..AC-5.
    const workspace = path.join(fixture, '.mergesutra', 'worktrees', runId);
    fixtureProof = await (FIXTURE_PROFILE === 'compact'
      ? inspectCompactAcceptance
      : inspectFixtureAcceptance)({
      workspace,
      run: exec,
      env: childEnv({ publicGit: true }),
      readFile,
      changedPaths: changed,
    });

    if (prJson?.outcome !== 'PR_CANDIDATE_RECORDED') {
      fail(
        `the real-model chain ended '${String(prJson?.outcome)}', not with a showable ` +
          'candidate page; the publication workflow needs a page and a digest',
      );
    }
    publicationBundle = await exportPublicationBundle({ prJson, fixture, exportRoot });
  }

  const after = await trackedSnapshot(fixture);
  const afterStatus = git('fixture-status-after', ['status', '--porcelain'], fixture);
  assertExit(afterStatus, [0]);
  const worktrees = git('fixture-worktrees', ['worktree', 'list', '--porcelain'], fixture);
  assertExit(worktrees, [0]);

  const fixtureUnchanged = JSON.stringify(before) === JSON.stringify(after);
  const statusUnchanged = beforeStatus.stdout === afterStatus.stdout;
  if (!fixtureUnchanged || !statusUnchanged) {
    fail('the primary fixture clone changed; validation is not confined to its worktree');
  }

  const rawArtifactFindings = await scanTree(path.join(ROOT, '.mergesutra'));
  if (rawArtifactFindings.length > 0 || rawLeak) {
    await writeFile(
      path.join(exportRoot, 'security-failure.json'),
      JSON.stringify(
        {
          mode,
          secretLeakDetected: true,
          artifactPaths: rawArtifactFindings,
          outputLeakDetected: rawLeak,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    fail('a credential-shaped value reached validation output or a raw run artifact');
  }

  for (let index = 0; index < steps.length; index += 1) {
    await writeStep(steps[index], index);
  }

  const plan = planRecord?.plan ?? finalRecord?.plan ?? null;
  const review = reviewRecord?.review ?? finalRecord?.review ?? null;
  const evidence = verifyRecord?.acceptanceEvidence ?? finalRecord?.acceptanceEvidence ?? null;
  const completionCount =
    (plan?.provenance?.attempts ?? 0) +
    (implementation?.summary?.modelRequests ?? 0) +
    (review?.attempts ?? 0);

  // The guard's own side of the count, read off the ledger rather than off the stages. Each
  // marker is one completion that left this process, so this number is what the ceiling was
  // actually enforced against — and it is the only figure here that a stage could not have
  // mis-reported. A failure to read the directory is recorded as null rather than as zero: a
  // missing count must not look like a run that asked for nothing.
  const reservationsWritten = await countReservations();

  const summary = {
    mode,
    sourceSha: process.env.GITHUB_SHA ?? null,
    mergeSutraVersion: version.stdout.trim(),
    fixture: {
      profile: FIXTURE_PROFILE,
      repository: FIXTURE_REPO,
      branch: FIXTURE_BRANCH,
      issue: FIXTURE_NUMBER,
      sha: fixtureSha,
      trackedBytesUnchanged: fixtureUnchanged,
      statusUnchanged,
      worktrees: worktrees.stdout.trim().split(/\r?\n/),
    },
    model: mode === 'live' ? configuredModel : null,
    gatewayModel: {
      plan: plan?.provenance?.model ?? null,
      implementation: implementation?.model ?? null,
      review: review?.modelId ?? null,
    },
    usage: {
      planAttempts: plan?.provenance?.attempts ?? 0,
      promptTokens: plan?.provenance?.promptTokens ?? null,
      completionTokens: plan?.provenance?.completionTokens ?? null,
      implementationRequests: implementation?.summary?.modelRequests ?? 0,
      reviewAttempts: review?.attempts ?? 0,
      completionsObserved: completionCount,
      hardCeilingForThisChain: MAX_MODEL_COMPLETIONS,
    },
    // Which of the two numbers came from enforcement and which from bookkeeping. The stages
    // report what they believe they asked; the ledger is what the transport actually let
    // through, and the preflight ran before either number existed. Null in the no-key run,
    // where nothing spends and no ceiling is installed.
    budget:
      mode === 'live'
        ? {
            ceilingEnforcedBeforeTransport: MAX_MODEL_COMPLETIONS,
            reservationsWrittenToLedger: reservationsWritten,
            completionRetriesAllowed: Number(process.env.BHARATCODE_MAX_RETRIES),
            workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
            preflightNotes: budgetNotes,
          }
        : null,
    implementation: implementation
      ? {
          status: implementation.status,
          termination: implementation.termination,
          writes: implementation.summary.writes,
          commands: implementation.summary.commands,
          changedFiles: implementation.changes.map((change) => change.relativePath),
        }
      : null,
    verification: {
      exitCode: verifyExit,
      criteria:
        evidence?.criteria?.map((entry) => ({
          id: entry.criterionId,
          status: entry.status,
          sufficiency: entry.sufficiency,
          gateIds: entry.gateIds,
          limitations: entry.limitations,
        })) ?? [],
    },
    review: review
      ? {
          attempts: review.attempts,
          modelId: review.modelId,
          findings: review.findings.map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            category: finding.category,
            disposition: finding.disposition,
            criterionIds: finding.criterionIds,
          })),
          repairPlanPresent: finalRecord?.repairPlan !== null,
        }
      : null,
    fixtureAcceptance: fixtureProof,
    publication: prJson
      ? {
          outcome: prJson.outcome,
          readiness: prJson.readiness,
          digest: prJson.digest,
          approved: prJson.approved,
          published: prJson.published,
        }
      : null,
    publicationBundle,
    steps: steps.map((step) => ({
      label: step.label,
      exitCode: step.exitCode,
      signal: step.signal,
    })),
    security: {
      outputLeakDetected: rawLeak,
      artifactFindings: rawArtifactFindings,
    },
    elapsedMs: Date.now() - startedAt,
  };

  await writeFile(
    path.join(exportRoot, `${mode}-summary.json`),
    JSON.stringify(summary, null, 2) + '\n',
  );
  process.stdout.write('MERGESUTRA_VALIDATION_SUMMARY\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (mode === 'live') {
    // The ceiling is a property of the ledger, not of the report. The guard wrote one marker
    // per request it let through, so a count past the ceiling means it was bypassed rather
    // than that a stage mis-added its own turns — and a ledger that cannot be read means this
    // run cannot say what it spent at all. Both are reported as unqualified after the fact,
    // which is the honest direction: the spend already happened, and what is being refused
    // here is the certificate, not the request.
    if (reservationsWritten === null) {
      fail(
        'the request ledger could not be read after the run, so this chain cannot say how many ' +
          'completions its guard allowed',
      );
    }
    if (reservationsWritten > MAX_MODEL_COMPLETIONS) {
      fail(
        `${String(reservationsWritten)} completion reservations are in the ledger and this chain's ceiling is ` +
          `${String(MAX_MODEL_COMPLETIONS)}: the pre-request guard was bypassed, not exceeded`,
      );
    }
    const failures = liveQualificationFailures({
      completionCount,
      elapsedMs: Date.now() - startedAt,
      deadlineMs: LIVE_DEADLINE_MS,
      verifyExit,
      implementation,
      fixtureProof,
      review,
      repairPlanPresent: Boolean(finalRecord?.repairPlan),
      requiredChangedPaths:
        FIXTURE_PROFILE === 'compact' ? ['src/slugify.js', 'test/slugify.test.js'] : undefined,
    });
    for (const failure of failures) fail(failure);
  }
}

try {
  await main();
} catch (error) {
  for (let index = 0; index < steps.length; index += 1) {
    await writeStep(steps[index], index).catch(() => undefined);
  }
  // A failure before the success summary still consumed a transport reservation.
  // Read the authoritative ledger; an inaccessible count is unknown, never zero.
  // Do not expose the private directory, credentials or raw model response.
  const reservationsWritten = await countReservations();
  await writeFile(
    path.join(exportRoot, `${mode}-failure.json`),
    JSON.stringify(
      {
        mode,
        sourceSha: process.env.GITHUB_SHA ?? null,
        error: sanitized(error instanceof Error ? error.message : String(error)),
        steps: steps.map((step) => ({
          label: step.label,
          exitCode: step.exitCode,
          signal: step.signal,
        })),
        budget:
          mode === 'live'
            ? {
                ceilingEnforcedBeforeTransport: MAX_MODEL_COMPLETIONS,
                reservationsWrittenToLedger: reservationsWritten,
                completionRetriesAllowed: Number(process.env.BHARATCODE_MAX_RETRIES),
                workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
              }
            : null,
        outputLeakDetected: rawLeak,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  ).catch(() => undefined);
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
