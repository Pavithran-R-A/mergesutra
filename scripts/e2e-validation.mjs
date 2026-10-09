import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'dist', 'bin.js');
const FIXTURE_URL = 'https://github.com/Pavithran-R-A/mergesutra.git';
const ISSUE_URL = 'https://github.com/Pavithran-R-A/mergesutra/issues/8';
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

if (mode === 'live') {
  if (secret.length < 8) fail('BHARATCODE_API_KEY is not configured; no model request was sent.');
  if (!ALLOWED_MODELS.has(configuredModel)) {
    fail(
      `BHARATCODE_MODEL must be one of ${[...ALLOWED_MODELS].join(', ')}; no model request was sent.`,
    );
  }
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
  const env = { ...process.env, NO_COLOR: '1' };
  if (publicGit) {
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.GITHUB_PAT;
    delete env.BHARATCODE_API_KEY;
    delete env.BHARATCODE_KEY;
    delete env.BHARATCODE_MODEL;
  }
  return env;
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
    const contract = cli('contract', ['contract', inspect.json.record.runId], [0]);
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

  if (mode === 'live') {
    // The CLI deliberately records incomplete work as evidence rather than lying
    // about success. A successful workflow must prove the actual fixture task.
    const changed = implementation?.changes?.map((entry) => entry.relativePath) ?? [];
    const permitted = new Set([
      'fixtures/stage14-e2e/src/slugify.js',
      'fixtures/stage14-e2e/check.mjs',
      'fixtures/stage14-e2e/README.md',
    ]);
    const unexpected = changed.filter((entry) => !permitted.has(entry));
    if (unexpected.length > 0) {
      fail('the model changed a file outside the controlled fixture allowlist');
    }

    // These checks execute only in the isolated worktree, with all secrets and
    // GitHub tokens removed. Repository CI by itself does not cover AC-1..AC-5.
    const workspace = path.join(fixture, '.mergesutra', 'worktrees', runId);
    const scriptPath = path.join(workspace, 'fixtures', 'stage14-e2e', 'check.mjs');
    const checkSource = await readFile(scriptPath, 'utf8');
    const requiredInputs = ['  Hello  World  ', 'a--b', '--x--'];
    const missingAssertions = requiredInputs.filter((input) => {
      const escaped = input.replace(/[.*+?^\${}()|[\]\\]/g, '\\  const after = await trackedSnapshot(fixture);');
      return !new RegExp(`assert\\.(?:equal|strictEqual)\\(\\s*slugify\\(\\s*['"]${escaped}['"]`).test(checkSource);
    });
    const fixturePkg = JSON.parse(
      await readFile(path.join(workspace, 'fixtures', 'stage14-e2e', 'package.json'), 'utf8'),
    );
    const dependencyFree =
      Object.keys(fixturePkg.dependencies ?? {}).length === 0 &&
      Object.keys(fixturePkg.devDependencies ?? {}).length === 0;

    const independent = exec(
      'fixture-independent-acceptance',
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import assert from 'node:assert/strict';",
          "import { slugify } from './fixtures/stage14-e2e/src/slugify.js';",
          "assert.equal(slugify('  Hello  World  '), 'hello-world');",
          "assert.equal(slugify('a--b'), 'a-b');",
          "assert.equal(slugify('--x--'), 'x');",
        ].join('\\n'),
      ],
      { cwd: workspace, env: childEnv({ publicGit: true }), timeoutMs: 15_000 },
    );
    const fixtureCheck = exec(
      'fixture-check-file',
      process.execPath,
      ['fixtures/stage14-e2e/check.mjs'],
      { cwd: workspace, env: childEnv({ publicGit: true }), timeoutMs: 15_000 },
    );
    fixtureProof = {
      directBehaviorsPass: independent.exitCode === 0,
      checkedScriptPass: fixtureCheck.exitCode === 0,
      checkContainsAllThreeAssertions: missingAssertions.length === 0,
      dependencyFree,
      changesWithinFixture: unexpected.length === 0,
      changedPaths: changed,
    };
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
  const implementation = implementRecord?.implementation ?? finalRecord?.implementation ?? null;
  const review = reviewRecord?.review ?? finalRecord?.review ?? null;
  const evidence = verifyRecord?.acceptanceEvidence ?? finalRecord?.acceptanceEvidence ?? null;
  const completionCount =
    (plan?.provenance?.attempts ?? 0) +
    (implementation?.summary?.modelRequests ?? 0) +
    (review?.attempts ?? 0);

  const summary = {
    mode,
    sourceSha: process.env.GITHUB_SHA ?? null,
    mergeSutraVersion: version.stdout.trim(),
    fixture: {
      repository: 'Pavithran-R-A/mergesutra',
      branch: FIXTURE_BRANCH,
      issue: 8,
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
      hardCeilingForThisChain: 12,
    },
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
    if (completionCount > 12) fail('observed model requests exceeded the chain ceiling');
    if (Date.now() - startedAt > LIVE_DEADLINE_MS)
      fail('live chain exceeded the 25-minute wall-clock ceiling');
    if (verifyExit !== 0) fail('deterministic verification did not pass');
    if (implementation?.status !== 'COMPLETED_BY_MODEL') {
      fail('the implementation loop did not finish the requested fixture task');
    }
    if (!fixtureProof?.directBehaviorsPass || !fixtureProof?.checkedScriptPass ||
        !fixtureProof?.checkContainsAllThreeAssertions || !fixtureProof?.dependencyFree ||
        !fixtureProof?.changedPaths?.includes('fixtures/stage14-e2e/check.mjs') ||
        !fixtureProof?.changedPaths?.includes('fixtures/stage14-e2e/src/slugify.js')) {
      fail('the independent fixture acceptance criteria were not all satisfied');
    }
    if (!review || review.findings.length > 0) {
      fail('the model review reported findings or could not be completed cleanly');
    }
    if (finalRecord?.repairPlan) {
      fail('review produced a repair plan; human digest approval is required before any repair');
    }
  }
}

try {
  await main();
} catch (error) {
  for (let index = 0; index < steps.length; index += 1) {
    await writeStep(steps[index], index).catch(() => undefined);
  }
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
