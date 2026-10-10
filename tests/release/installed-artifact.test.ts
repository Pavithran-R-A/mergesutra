import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAN_SYMLINK } from '../helpers/fixture.js';
import { requireNpmCli } from '../helpers/npmInvocation.js';

/**
 * S13-2 — the artifact a customer actually gets, installed and run.
 *
 * `tests/security/publish-contents.test.ts` already asks npm what it *would* pack and
 * maps each entry back to a source module. That question stops at the manifest: it is
 * answered from the checkout, with the checkout's own `node_modules` reachable, so it
 * cannot see the two things that break for a customer rather than for a developer —
 * a `bin` entry point that does not resolve outside this repository's layout, and a
 * `dist/` that imports something only a devDependency provided.
 *
 * So this suite does the consumer's three steps and nothing else: pack a real tarball,
 * install it into an empty directory that contains no source and no dev tooling, run
 * the command it advertises. Every assertion reads either a byte under that directory
 * or the exit code and output of a process started from it.
 *
 * **This suite reaches the network.** It is the only suite in the repository that does,
 * which is why `vitest.config.ts` excludes this directory and `npm run test:artifact`
 * runs it through its own config — so `npm run check` stays the offline gate its
 * documentation says it is, and the hosted matrix runs the install on every entry.
 * The packing step disables lifecycle scripts deliberately: the previous CI step has
 * already built and verified these bytes, and re-running `prepack` inside a smoke test
 * would make the step measure a build instead of an install.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const execFileAsync = promisify(execFile);
const NPM_CLI = requireNpmCli();
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  main: string;
  files: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

interface PackResult {
  readonly filename: string;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function npm(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [NPM_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runNode(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Run the command the way a customer runs it after an install: by its registered
 * name, resolved through npm.
 *
 * Spawning `node_modules/.bin/mergesutra` directly is not available — on Windows that
 * file is a `.cmd`, and Node refuses to spawn a `.cmd` without a shell, which is a
 * quoting hazard this suite will not take on. `npm exec` is what `npx` is built on, so
 * it exercises the same bin resolution through npm's own platform handling, with an
 * argv array and no shell string.
 */
function runInstalled(name: string, args: readonly string[], cwd: string): Run {
  return npm(['exec', '--silent', '--', name, ...args], cwd);
}

/** Regular files under a tree, posix-relative, skipping the consumer's own dependency tree. */
function relativeFiles(dir: string, base: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...relativeFiles(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

let staging = '';
let consumer = '';
let tarball = '';
let install: Run = { status: null, stdout: '', stderr: '' };

const installedPackage = () => path.join(consumer, 'node_modules', manifest.name);

/** The file the manifest registers as the command, as installed. */
const installedBin = () =>
  path.join(installedPackage(), (Object.values(manifest.bin)[0] ?? '').replace(/^\.\//, ''));

beforeAll(async () => {
  staging = await mkdtemp(path.join(tmpdir(), 'mergesutra-staging-'));
  consumer = await mkdtemp(path.join(tmpdir(), 'mergesutra-consumer-'));
  await writeFile(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'artifact-consumer', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );

  const packed = npm(['pack', '--json', '--ignore-scripts', '--pack-destination', staging], ROOT);
  expect(
    packed.status,
    `npm pack exited ${String(packed.status)}: ${packed.stderr.slice(0, 500)}`,
  ).toBe(0);
  const start = packed.stdout.indexOf('[');
  expect(start, `npm pack --json printed no array: ${packed.stdout.slice(0, 300)}`).toBeGreaterThan(
    -1,
  );
  const reports = JSON.parse(packed.stdout.slice(start)) as PackResult[];
  expect(reports).toHaveLength(1);
  tarball = path.join(staging, reports[0]?.filename ?? '');
  expect(existsSync(tarball), `npm did not write ${tarball}`).toBe(true);

  install = npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], consumer);
});

afterAll(async () => {
  // Only the two directories this file created, by name.
  for (const dir of [staging, consumer]) {
    if (dir !== '') await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('the packed artifact installs where no source is present', () => {
  it('installs, or says what npm said', () => {
    expect(
      install.status,
      `npm install ${path.basename(tarball)} exited ${String(install.status)}:\n${install.stdout.slice(-1500)}\n${install.stderr.slice(-1500)}`,
    ).toBe(0);
  });

  it('carries the version that was packed, not the version of the checkout', () => {
    const installed = JSON.parse(
      readFileSync(path.join(installedPackage(), 'package.json'), 'utf8'),
    ) as { version: string; name: string };
    expect(installed.name).toBe(manifest.name);
    expect(installed.version).toBe(manifest.version);
  });

  it('leaves no tarball in the source tree', () => {
    const strays = readdirSync(ROOT).filter((entry) => entry.endsWith('.tgz'));
    expect(strays, 'npm pack wrote into the checkout').toEqual([]);
  });

  it('resolves every entry point the manifest advertises', () => {
    const advertised = [...new Set([manifest.main, ...Object.values(manifest.bin)])];
    for (const target of advertised) {
      const relative = target.replace(/^\.\//, '');
      expect(
        existsSync(path.join(installedPackage(), relative)),
        `${target} is advertised but not installed`,
      ).toBe(true);
    }
  });

  it('installs none of the development surface', () => {
    const files = relativeFiles(installedPackage(), installedPackage());
    const offenders = files.filter(
      (file) => file === 'src' || file.startsWith('src/') || file.startsWith('tests/'),
    );
    expect(offenders, 'the artifact carries source or test files').toEqual([]);
    expect(files.filter((file) => file.endsWith('.test.ts'))).toEqual([]);
  });

  it('ships the documents the manifest promises beside the code', () => {
    for (const entry of manifest.files) {
      expect(
        existsSync(path.join(installedPackage(), entry)),
        `${entry} is in the shipped surface but missing from the install`,
      ).toBe(true);
    }
  });

  it('pulls in the runtime dependencies and none of the dev tooling', () => {
    const modules = path.join(consumer, 'node_modules');
    for (const name of Object.keys(manifest.dependencies)) {
      expect(existsSync(path.join(modules, name)), `${name} was not installed`).toBe(true);
    }
    for (const name of Object.keys(manifest.devDependencies)) {
      expect(existsSync(path.join(modules, name)), `${name} leaked into a consumer`).toBe(false);
    }
  });
});

describe('the installed command runs as a customer would run it', () => {
  it('prints its version through the bin entry it registers', () => {
    const registered = readdirSync(path.join(consumer, 'node_modules', '.bin'));
    expect(registered, 'npm created no launcher for the advertised command').toContain(
      'mergesutra',
    );
    const result = runInstalled('mergesutra', ['--version'], consumer);
    expect(result.status, `bin exited ${String(result.status)}: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(manifest.version);
  });

  /**
   * The invocation a POSIX customer actually gets.
   *
   * On Linux and macOS npm's launcher is a *symlink* to the manifest's `bin` target,
   * and the kernel starts the script under that link path: `process.argv[1]` names the
   * link while the module's own `import.meta.url` names the file the link resolves to.
   * An entry point that decides whether to do anything by comparing those two strings
   * therefore runs nothing at all — exit code 0, no stdout, no stderr — for every
   * customer on those platforms, while passing on Windows, where npm writes a `.cmd`
   * that calls `node` with the realpath. The measured form of the failure is the worst
   * one a tool can have: it looks like success and prints nothing.
   *
   * The link is made in this file's own staging directory, which `afterAll` removes.
   */
  it.skipIf(!CAN_SYMLINK)(
    'runs when started through a launcher path that is not its realpath',
    async () => {
      const target = installedBin();
      const link = path.join(staging, 'mergesutra-launcher.js');
      await symlink(target, link, 'file');
      const result = runNode([link, '--version'], consumer);
      expect(result.status, `--version exited ${String(result.status)}: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim(), 'started through a symlink the command printed nothing').toBe(
        manifest.version,
      );
    },
  );

  it('reaches the command list through the installed module graph', () => {
    const result = runNode([installedBin(), '--help'], consumer);
    expect(result.status, `--help exited ${String(result.status)}: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Usage: mergesutra');
    expect(result.stdout).toContain('doctor');
  });

  it(
    'provides installed, credential-free help for every shipped CLI command',
    async () => {
      const commands = [
        'doctor',
        'issue',
        'inspect',
        'contract',
        'plan',
        'implement',
        'verify',
        'review',
        'repair',
        'report',
        'pr',
        'status',
        'resume',
        'run',
      ];
      for (const command of commands) {
        const { stdout, stderr } = await execFileAsync(process.execPath, [installedBin(), command, '--help'], {
          cwd: consumer,
          windowsHide: true,
          timeout: 10_000,
          env: {
            ...process.env,
            BHARATCODE_API_KEY: '',
            BHARATCODE_MODEL: '',
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            NO_COLOR: '1',
          },
        });
        expect(stdout, `${command} printed no usable help`).toContain(`mergesutra ${command}`);
        expect(stderr, `${command} logged an exception`).not.toMatch(
          /ERR_MODULE|ERR_REQUIRE|Cannot find module/,
        );
        expect(stdout, `${command} leaked ANSI controls into piped help`).not.toContain(
          String.fromCharCode(27),
        );
      }
    },
    60_000,
  );

  /**
   * The other half of the two-entry design: `main` is importable and stays quiet.
   * One executable file that both exports the library and runs the CLI is what made the
   * symlink failure possible, so this asserts the separation rather than only the fix.
   */
  it('imports as a library without starting a command line', () => {
    const result = runNode(
      [
        '--input-type=module',
        '-e',
        "const m = await import('mergesutra'); process.stdout.write(typeof m.run);",
      ],
      consumer,
    );
    expect(result.status, `import exited ${String(result.status)}: ${result.stderr}`).toBe(0);
    expect(result.stdout, 'importing the library printed a screen').toBe('function');
  });

  /**
   * `doctor` walks the diagnosis path, which imports the CLI surface, the GitHub
   * client and the schema layer — the modules a missing file in the packed `dist/`
   * would break. Its documented exit codes are 0 (nothing failed) and 1 (a row
   * reported FAIL), so the smoke asserts a verdict was produced rather than that
   * the verdict was favourable: on a runner with no BharatCode key, FAIL is correct.
   */
  it('runs a real command from outside this repository and reports, without crashing', () => {
    const result = runInstalled('mergesutra', ['doctor'], consumer);
    expect(
      [0, 1],
      `doctor exited ${String(result.status)}:\n${result.stdout.slice(-800)}\n${result.stderr.slice(-800)}`,
    ).toContain(result.status);
    expect(result.stdout).toContain('MergeSutra doctor');
    expect(result.stdout).toContain('Node');
    expect(result.stderr).not.toMatch(/Cannot find|ERR_MODULE|ERR_REQUIRE|at .*\(.*:\d+:\d+\)/);
  });

  it('does not write into the consumer directory it was run in', () => {
    const strays = readdirSync(consumer).filter(
      (entry) => entry === '.mergesutra' || entry === 'runs',
    );
    expect(strays, 'a read-only command created run state in the consumer project').toEqual([]);
  });
});
