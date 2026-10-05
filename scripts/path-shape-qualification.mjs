import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'dist', 'bin.js');

const CREDENTIAL_ENV_NAMES = [
  'BHARATCODE_API_KEY',
  'BHARATCODE_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of CREDENTIAL_ENV_NAMES) delete env[name];
  return env;
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? cleanEnv(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  const allowed = options.allowed ?? [0];
  if (!allowed.includes(result.status ?? -1)) {
    process.stderr.write(
      [
        `command failed: ${file} ${args.join(' ')}`,
        `exit: ${String(result.status)}`,
        result.stdout ?? '',
        result.stderr ?? '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return result;
}

function requireText(text, pattern, label) {
  if (!pattern.test(text)) {
    process.stderr.write(`qualification failed: ${label}\n${text}\n`);
    process.exit(1);
  }
}

const scratch = await mkdtemp(path.join(tmpdir(), 'MergeSutra Qualification '));
const repo = path.join(scratch, 'Repository With Spaces');

try {
  await mkdir(repo, { recursive: true });
  await writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'mergesutra-path-shape-fixture',
        version: '1.0.0',
        scripts: { test: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(path.join(repo, '.gitignore'), '.mergesutra/\n', 'utf8');

  run('git', ['init', '-b', 'main'], { cwd: repo });
  run('git', ['config', 'user.name', 'MergeSutra Qualification'], { cwd: repo });
  run('git', ['config', 'user.email', 'qualification@example.invalid'], { cwd: repo });
  run('git', ['add', 'package.json', '.gitignore'], { cwd: repo });
  run('git', ['commit', '-m', 'fixture'], { cwd: repo });

  const inputPath = process.platform === 'win32' ? repo.replaceAll('\\', '/') : repo;
  const env = cleanEnv({
    HOME: scratch,
    USERPROFILE: scratch,
    NO_COLOR: '1',
  });

  const intake = run(process.execPath, [BIN, '--no-color', 'issue', '--repo', inputPath], {
    cwd: repo,
    env,
    allowed: [3],
  });
  const localLine =
    intake.stdout.split(/\r?\n/).find((line) => line.includes('Local repository')) ?? '';
  requireText(localLine, /~[\\/]Repository With Spaces/, 'HOME/USERPROFILE abbreviation');

  const inspect = run(process.execPath, [BIN, '--no-color', 'inspect', inputPath], {
    cwd: repo,
    env,
    allowed: [0],
  });
  requireText(inspect.stdout, /PASS\s+Repository path/, 'repository path with spaces');
  requireText(inspect.stdout, /PASS\s+Git metadata/, 'real Git discovery');

  const doctor = run(process.execPath, [BIN, '--no-color', 'doctor'], {
    cwd: repo,
    env,
    allowed: [1],
  });
  requireText(doctor.stdout, /PASS\s+Git\s+git version/i, 'Git executable discovery');
  requireText(doctor.stdout, /PASS\s+GitHub CLI\s+gh version/i, 'gh executable discovery');

  const root = path.parse(repo).root;
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]$/.test(root)) {
    process.stderr.write(`qualification failed: Windows temp path has no drive root: ${root}\n`);
    process.exit(1);
  }

  process.stdout.write(
    [
      'MergeSutra path-shape qualification PASS',
      `platform=${process.platform}`,
      `temp-root=${path.parse(scratch).root}`,
      `spaces=covered`,
      `separator-input=${process.platform === 'win32' ? 'forward-slash-on-Windows' : 'POSIX'}`,
      `home-userprofile=covered`,
      `git-discovery=covered`,
      `gh-discovery=covered`,
    ].join('\n') + '\n',
  );
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
