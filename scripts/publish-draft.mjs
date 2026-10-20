import { spawnSync } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPublicationBundle } from './lib/publication-bundle.mjs';
import { runPublication } from './lib/publication-publish.mjs';

/**
 * The runner behind the write-scoped publication workflow.
 *
 * This process holds the one credential the live-model job must never hold — the
 * workflow's own short-lived GitHub token — and refuses to start if any BharatCode
 * variable is present. It does not speak to GitHub itself. It reconstructs the
 * approved patch in a fresh worktree, re-measures it with the product's own
 * `describePatch`, and then runs the product's `pr --approve <digest> --publish`,
 * whose transport performs the only remote writes this system knows how to make.
 *
 * The workflow checkout is the repository: `prepareWorktree` creates a detached
 * worktree at the bundle's base commit under `.mergesutra/worktrees/<runId>`, which
 * is the path the run record names. The run store is staged in a separate root, so
 * the record and pack the product reads are exactly the bytes the bundle carried.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'bin.js');
const MODEL_VARIABLES = ['BHARATCODE_API_KEY', 'BHARATCODE_KEY', 'BHARATCODE_MODEL'];
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EXIT = { PUBLISHED: 0, REFUSED: 3, FAILED: 4, CONFIG: 78 };
const PUBLISH_TIMEOUT_MS = 10 * 60_000;

const argv = process.argv.slice(2);
const options = parseArguments(argv);
const rootDir = path.resolve(
  options.root ?? path.join(process.env.RUNNER_TEMP ?? ROOT, 'mergesutra-publication'),
);

function parseArguments(args) {
  const allowed = new Set(['--bundle', '--approval', '--repository', '--root']);
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? '';
    const value = args[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith('--')) {
      usage(`unknown or incomplete argument '${printable(name)}'`);
    }
    const key = name.slice(2);
    if (key in parsed) usage(`'${name}' was given more than once`);
    parsed[key] = value;
  }
  if (parsed.bundle === undefined) usage('--bundle is required');
  if (parsed.approval === undefined) usage('--approval is required');
  return parsed;
}

function usage(message) {
  process.stderr.write(`PUBLICATION_RUNNER_USAGE: ${message}\n`);
  process.stderr.write(
    'usage: node scripts/publish-draft.mjs --bundle <dir> --approval <digest> [--repository <dir>] [--root <dir>]\n',
  );
  process.exit(EXIT.CONFIG);
}

function sanitize(text) {
  return String(text)
    .replace(/\bbc_live_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '[REDACTED]');
}

function printable(value) {
  return sanitize(value)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
}

function configRefusal(message) {
  const error = new Error(message);
  error.code = 'PUBLICATION_RUNNER_CONFIG';
  return error;
}

function assertSeparation() {
  const present = MODEL_VARIABLES.filter((name) => (process.env[name] ?? '').length > 0);
  if (present.length > 0) {
    throw configRefusal(
      `This job must never hold a model credential, but ${present.join(', ')} is set; nothing was sent.`,
    );
  }
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 << 20,
  });
  if (result.status !== 0) {
    throw configRefusal(
      `git ${args.join(' ')} exited ${String(result.status)}: ${printable(result.stderr ?? '')}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function originOf(repositoryDir) {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repositoryDir,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

function originMatches(url, repository) {
  const stripped = url.replace(/\.git$/i, '');
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(stripped) ??
    /^git@github\.com:([^/]+\/[^/]+)$/i.exec(stripped) ??
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i.exec(stripped);
  return (match?.[1] ?? '').toLowerCase() === repository.toLowerCase();
}

async function prepareWorktree({ repository }) {
  const configured = options.repository ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const repositoryDir = await realpath(configured).catch(() => null);
  if (repositoryDir === null) {
    throw configRefusal(`The repository directory '${printable(configured)}' does not exist.`);
  }
  const top = await realpath(git(['rev-parse', '--show-toplevel'], repositoryDir));
  if (top !== repositoryDir) {
    throw configRefusal('--repository must name the root of its Git working tree.');
  }
  const origin = originOf(repositoryDir);
  if (!originMatches(origin, repository)) {
    throw configRefusal(
      `The checkout's origin '${printable(origin || '(none)')}' is not ${repository}; nothing was sent.`,
    );
  }
  return { repositoryDir };
}

async function prepare(input) {
  const { repositoryDir } = await prepareWorktree(input);
  const baseSha = input.baseSha;
  if (!SHA40.test(baseSha) || !RUN_ID.test(input.runId)) {
    throw configRefusal('The bundle names a malformed base commit or run id.');
  }
  git(['cat-file', '-e', `${baseSha}^{commit}`], repositoryDir);
  const worktreeDir = path.join(repositoryDir, '.mergesutra', 'worktrees', input.runId);
  const existing = await lstat(worktreeDir).catch(() => null);
  if (existing !== null) {
    throw configRefusal(
      `The workspace '${printable(worktreeDir)}' already exists; this runner will not reuse or delete it.`,
    );
  }
  await mkdir(path.dirname(worktreeDir), { recursive: true });
  git(['worktree', 'add', '--detach', worktreeDir, baseSha], repositoryDir);
  return { repositoryDir, worktreeDir };
}

async function measure({ worktreeDir, baseSha }) {
  const { describePatch } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'verify', 'patch.js')).href
  );
  return describePatch({ workspace: worktreeDir, baseSha });
}

function publish({ runId, repositoryDir, approval }) {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const name of MODEL_VARIABLES) delete env[name];
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      '--json',
      '--no-color',
      'pr',
      runId,
      '--repo',
      repositoryDir,
      '--approve',
      approval,
      '--publish',
    ],
    {
      cwd: rootDir,
      env,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: PUBLISH_TIMEOUT_MS,
      maxBuffer: 16 << 20,
    },
  );
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function writeReceipt(status, reason, bundle, extra = {}) {
  const identity = bundle?.identity ?? {};
  const receipt = {
    schemaVersion: 1,
    status,
    reason: typeof reason === 'string' ? sanitize(reason) : null,
    repository: identity.repository ?? null,
    runId: identity.runId ?? null,
    baseSha: identity.baseSha ?? null,
    targetBranch: identity.targetBranch ?? null,
    proposedBranch: identity.proposedBranch ?? null,
    patchIdentity: identity.patchIdentity ?? null,
    evidencePackIdentity: identity.evidencePackIdentity ?? null,
    approvalDigest: identity.publicationDigest ?? null,
    changedPaths: identity.changedPaths ?? [],
    deletedPaths: identity.deletedPaths ?? [],
    sourceRunUrl: identity.sourceRunUrl ?? null,
    ...extra,
  };
  await mkdir(rootDir, { recursive: true });
  const file = path.join(rootDir, 'publication-result.json');
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write('MERGESUTRA_PUBLICATION_RECEIPT\n');
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

async function main() {
  assertSeparation();

  const expectedRepository = process.env.GITHUB_REPOSITORY ?? '';
  if (!REPOSITORY.test(expectedRepository)) {
    throw configRefusal('GITHUB_REPOSITORY is not configured as owner/name.');
  }
  if (options.approval === undefined || !SHA256.test(options.approval.trim().toLowerCase())) {
    throw configRefusal('--approval must be the 64-character hex digest of the page.');
  }

  // Read and scope-check the bundle before anything is staged or prepared: a
  // bundle for another repository must be refused while the job still has no
  // local side effects at all.
  const bundleDir = path.resolve(options.bundle);
  const bundle = await readPublicationBundle(bundleDir);
  if (bundle.identity.repository.toLowerCase() !== expectedRepository.toLowerCase()) {
    const reason =
      `The bundle publishes to ${bundle.identity.repository}, but this job runs in ` +
      `${expectedRepository}; nothing was sent.`;
    await writeReceipt('REFUSED', reason, bundle);
    process.exitCode = EXIT.REFUSED;
    return;
  }

  const result = await runPublication({
    bundleDir,
    approval: options.approval,
    rootDir,
    workRoot: rootDir,
    deps: { prepareWorktree: prepare, measure, publish },
  });

  if (result.status === 'PUBLISHED') {
    await writeReceipt('PUBLISHED', 'GitHub reported a draft pull request.', bundle, {
      url: result.url,
      number: result.number,
      branch: result.branch,
      commitSha: result.commitSha,
      outcome: result.outcome,
      recordFile: result.recordFile,
    });
    process.exitCode = EXIT.PUBLISHED;
    return;
  }
  if (result.status === 'REFUSED') {
    await writeReceipt('REFUSED', result.reason, bundle);
    process.exitCode = EXIT.REFUSED;
    return;
  }
  await writeReceipt('FAILED', result.reason, bundle, {
    exitCode: result.exitCode ?? null,
    stderr: typeof result.stderr === 'string' ? sanitize(result.stderr) : null,
  });
  process.exitCode = EXIT.FAILED;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`PUBLICATION_RUNNER_FAILURE: ${sanitize(message)}\n`);
  await writeReceipt('FAILED', message, null).catch(() => undefined);
  process.exitCode = error?.code === 'PUBLICATION_BUNDLE_REFUSED' ? EXIT.REFUSED : EXIT.CONFIG;
}
