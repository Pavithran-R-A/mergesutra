import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadBharatCodeConfig, summarizeConfig } from '../config/load-config.js';
import { createBharatCodeClient, type BharatCodeClient } from '../bharatcode/client.js';
import { isInsideRoot } from '../security/path-safety.js';
import type { BharatCodeClientConfig } from '../bharatcode/types.js';
import type { RenderOptions, Renderer, Status } from './render.js';
import { DIGEST_IMAGE } from '../security/sandbox.js';
import { terminalSafeDocument } from '../security/terminal-safety.js';
import { createRenderer, resolveColor } from './render.js';
import {
  defaultRunner,
  githubApiRunner,
  safeRun,
  type Runner,
  type RunResult,
} from '../core/runner.js';

/**
 * `mergesutra doctor` — environment diagnosis that never prints the API key value.
 *
 * Each check resolves to a truthful PASS / FAIL / WARN / SKIP with a short,
 * actionable detail. Network reachability to BharatCode is opt-in (`connect`)
 * so default diagnosis works offline.
 */

export type { Runner, RunResult };

export interface DoctorCheck {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

export interface DoctorDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly run?: Runner;
  readonly makeClient?: (config: BharatCodeClientConfig) => BharatCodeClient | undefined;
  readonly connect?: boolean;
  readonly nodeVersion?: string;
  /** Repository working directory; only used to explain a forbidden Docker CLI location. */
  readonly cwd?: string;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const env = deps.env;
  const run = deps.run ?? defaultRunner;
  const ghRun = deps.run ?? githubApiRunner;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const checks: DoctorCheck[] = [];

  // Node
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'Node',
    status: nodeMajor >= MIN_NODE_MAJOR ? 'PASS' : 'FAIL',
    detail:
      nodeMajor >= MIN_NODE_MAJOR
        ? `v${nodeVersion}`
        : `v${nodeVersion} (need >= ${MIN_NODE_MAJOR})`,
  });

  // Git
  const git = await safeRun(run, 'git', ['--version']);
  if (git && git.code === 0) {
    checks.push({ name: 'Git', status: 'PASS', detail: firstLine(git.stdout) || 'available' });
  } else {
    checks.push({
      name: 'Git',
      status: 'FAIL',
      detail: 'git not found on PATH — install Git or add it to PATH.',
    });
  }

  // GitHub CLI + auth
  const gh = await safeRun(ghRun, 'gh', ['--version']);
  if (gh && gh.code === 0) {
    checks.push({
      name: 'GitHub CLI',
      status: 'PASS',
      detail: firstLine(gh.stdout) || 'available',
    });
    const auth = await safeRun(ghRun, 'gh', ['auth', 'status']);
    checks.push(
      auth && auth.code === 0
        ? { name: 'GitHub auth', status: 'PASS', detail: 'signed in' }
        : {
            name: 'GitHub auth',
            status: 'WARN',
            detail: 'gh is installed but not authenticated — run: gh auth login',
          },
    );
  } else {
    checks.push({
      name: 'GitHub CLI',
      status: 'WARN',
      detail: 'gh not found — optional for local repos, required for issue-URL intake.',
    });
  }

  // BharatCode configuration (never prints the key)
  const config = loadBharatCodeConfig(env);
  const summary = summarizeConfig(config);
  checks.push(
    summary.configured
      ? {
          name: 'BharatCode key',
          status: 'PASS',
          detail: `configured (source: ${summary.apiKeySource}, base: ${summary.baseUrl})`,
        }
      : {
          name: 'BharatCode key',
          status: 'FAIL',
          detail: 'BHARATCODE_API_KEY is not set.',
        },
  );

  // Repository execution boundary: Stage 6/7 commands refuse without it, so a
  // diagnosis that stays silent here can call an environment ready while every
  // repository command will fail closed.
  checks.push(sandboxReadiness(env, deps.cwd ?? process.cwd()));

  // Reachability (opt-in, and only meaningful with a key)
  if (!deps.connect) {
    checks.push({ name: 'BharatCode reach', status: 'SKIP', detail: 'pass --connect to test' });
  } else if (!summary.configured) {
    checks.push({ name: 'BharatCode reach', status: 'SKIP', detail: 'not configured' });
  } else {
    const makeClient =
      deps.makeClient ??
      ((loaded: BharatCodeClientConfig) => createBharatCodeClient({ config: loaded }));
    const client = makeClient(config);
    if (!client) {
      checks.push({ name: 'BharatCode reach', status: 'SKIP', detail: 'no client' });
    } else {
      const health = await client.healthCheck();
      checks.push(
        health.reachable
          ? {
              name: 'BharatCode reach',
              status: 'PASS',
              detail: `${health.modelCount ?? 0} model(s) listed`,
            }
          : { name: 'BharatCode reach', status: 'FAIL', detail: health.note ?? 'unreachable' },
      );
    }
  }

  return checks;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}

function sandboxReadiness(env: NodeJS.ProcessEnv, cwd: string): DoctorCheck {
  const name = 'Repository sandbox';
  const image = env.MERGESUTRA_SANDBOX_IMAGE;
  const dockerExecutable = env.MERGESUTRA_DOCKER_EXECUTABLE;
  if (!image && !dockerExecutable) {
    return {
      name,
      status: 'WARN',
      detail:
        'not configured — repository commands will refuse with SANDBOX_UNAVAILABLE. ' +
        'Set MERGESUTRA_SANDBOX_IMAGE=<image>@sha256:<digest> and ' +
        'MERGESUTRA_DOCKER_EXECUTABLE=<absolute path to docker>.',
    };
  }
  if (!image || !dockerExecutable) {
    const missing = image ? 'MERGESUTRA_DOCKER_EXECUTABLE' : 'MERGESUTRA_SANDBOX_IMAGE';
    return {
      name,
      status: 'FAIL',
      detail: `${missing} is not set — repository commands will refuse with SANDBOX_UNAVAILABLE.`,
    };
  }
  if (!DIGEST_IMAGE.test(image)) {
    return {
      name,
      status: 'FAIL',
      detail:
        'MERGESUTRA_SANDBOX_IMAGE must be digest-pinned (<name>@sha256:<64 hex>); ' +
        'a mutable tag is refused.',
    };
  }
  if (!path.isAbsolute(dockerExecutable)) {
    return {
      name,
      status: 'FAIL',
      detail: 'MERGESUTRA_DOCKER_EXECUTABLE must be an absolute path to the Docker CLI.',
    };
  }
  let present = false;
  try {
    present = statSync(dockerExecutable).isFile();
  } catch {
    present = false;
  }
  if (!present) {
    return {
      name,
      status: 'FAIL',
      detail: `MERGESUTRA_DOCKER_EXECUTABLE is not an existing file: ${dockerExecutable}`,
    };
  }
  // Windows has no Unix execute bit; there, existence is all this check can read.
  if (process.platform !== 'win32') {
    try {
      accessSync(dockerExecutable, constants.X_OK);
    } catch {
      return {
        name,
        status: 'FAIL',
        detail:
          `MERGESUTRA_DOCKER_EXECUTABLE is not executable on this host: ${dockerExecutable}. ` +
          'Select an executable Docker CLI.',
      };
    }
  }
  let resolvedDocker: string;
  try {
    resolvedDocker = realpathSync(dockerExecutable);
  } catch {
    return {
      name,
      status: 'FAIL',
      detail: `MERGESUTRA_DOCKER_EXECUTABLE cannot be resolved to a real path: ${dockerExecutable}`,
    };
  }
  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    return {
      name,
      status: 'WARN',
      detail:
        `cannot resolve the working directory (${cwd}), so the Docker CLI's location was not ` +
        'compared with the run-workspace root. Run doctor from inside the repository to check it.',
    };
  }
  const discoveredRoot = findRepositoryRoot(resolvedCwd);
  const inRunWorkspace = discoveredRoot !== null && isRunWorkspaceRoot(discoveredRoot);
  const repositoryRoot = discoveredRoot ?? resolvedCwd;
  const rootLabel =
    discoveredRoot === null
      ? 'the working directory (no Git root was found above it)'
      : inRunWorkspace
        ? 'this run workspace'
        : 'this repository';
  // Running inside a run workspace makes that workspace the nearest `.git`; a
  // Docker CLI inside it is the same conflict the runtime refuses for the run.
  if (inRunWorkspace && discoveredRoot !== null && isInsideRoot(discoveredRoot, resolvedDocker)) {
    return {
      name,
      status: 'FAIL',
      detail:
        `MERGESUTRA_DOCKER_EXECUTABLE resolves inside the run workspace ${discoveredRoot}, ` +
        'which a run mounts; the sandbox refuses a Docker CLI inside its own untrusted ' +
        'workspace. Select an installed Docker CLI outside the repository.',
    };
  }
  const worktrees = path.join(repositoryRoot, '.mergesutra', 'worktrees');
  let resolvedWorktrees: string | null = null;
  try {
    if (statSync(worktrees).isDirectory()) resolvedWorktrees = realpathSync(worktrees);
  } catch {
    resolvedWorktrees = null;
  }
  if (resolvedWorktrees !== null && isInsideRoot(resolvedWorktrees, resolvedDocker)) {
    const relative = path.relative(resolvedWorktrees, resolvedDocker);
    const segments = relative.split(path.sep).filter(Boolean);
    // A run mounts exactly one directory, `<base>/<run-id>`. A linked worktree
    // carries `.git` at its root; a bare directory directly under the base is
    // not a workspace any run created, so it stays a repository-local warning.
    const runWorkspace =
      segments.length >= 2 ? path.join(resolvedWorktrees, segments[0]!) : undefined;
    if (runWorkspace !== undefined && existsSync(path.join(runWorkspace, '.git'))) {
      return {
        name,
        status: 'FAIL',
        detail:
          `MERGESUTRA_DOCKER_EXECUTABLE resolves inside the run workspace ${runWorkspace}, ` +
          'which a run mounts; the sandbox refuses a Docker CLI inside its own untrusted ' +
          'workspace. Select an installed Docker CLI outside the repository.',
      };
    }
  }
  if (isInsideRoot(repositoryRoot, resolvedDocker)) {
    return {
      name,
      status: 'WARN',
      detail:
        `MERGESUTRA_DOCKER_EXECUTABLE resolves inside ${rootLabel}: ${dockerExecutable}. ` +
        'doctor cannot verify that this file is a genuine Docker client, and a Docker CLI ' +
        'inside a run workspace under .mergesutra/worktrees is refused at runtime. Select an ' +
        'installed Docker CLI outside the repository.',
    };
  }
  const cliDescription =
    process.platform === 'win32'
      ? 'existing Docker CLI (Windows has no Unix execute bit, so only existence is checked)'
      : 'executable Docker CLI';
  return {
    name,
    status: 'PASS',
    detail:
      `configured (digest-pinned image; ${cliDescription} outside ${rootLabel}). ` +
      'Image availability is checked when a repository command runs; the sandbox also refuses ' +
      'a Docker CLI that resolves inside a run workspace under .mergesutra/worktrees, and ' +
      'git-based repository gates remain fail-closed.',
  };
}

/**
 * The root Git metadata lives in: `.git` is a directory in a normal checkout and
 * a file in a linked worktree. The repository toplevel Stage 6/7 record is this
 * directory, not whichever subdirectory doctor happened to run in.
 */
function findRepositoryRoot(start: string): string | null {
  let current = start;
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `<repo>/.mergesutra/worktrees/<run-id>` is the directory a run mounts. */
function isRunWorkspaceRoot(candidate: string): boolean {
  const base = path.dirname(candidate);
  return path.basename(base) === 'worktrees' && path.basename(path.dirname(base)) === '.mergesutra';
}

export function formatDoctor(input: readonly DoctorCheck[], renderer: Renderer): string {
  // Display copy: a value this command only read may not carry a byte that steers
  // the terminal it is printed on. See src/security/terminal-safety.ts.
  const checks = terminalSafeDocument(input);
  const lines: string[] = [renderer.heading('MergeSutra doctor'), ''];
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    const padded = check.name.padEnd(width);
    lines.push(`${renderer.status(check.status)} ${padded}  ${check.detail}`);
  }
  const allPass = checks.every((c) => c.status === 'PASS' || c.status === 'SKIP');
  const hasFail = checks.some((c) => c.status === 'FAIL');
  lines.push('');
  lines.push(
    hasFail
      ? renderer.heading('Not ready. Resolve the FAIL items above.')
      : allPass
        ? renderer.heading('Ready.')
        : renderer.heading('Ready with warnings.'),
  );
  return lines.join('\n');
}

export interface DoctorCommandOptions {
  readonly connect?: boolean;
  readonly noColor?: boolean;
}

/** Entry used by the CLI program. Returns a process exit code. */
export async function doctorAction(
  options: DoctorCommandOptions,
  deps: Partial<DoctorDeps> = {},
  write: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const checks = await runDoctor({
    env: deps.env ?? process.env,
    run: deps.run,
    makeClient: deps.makeClient,
    connect: options.connect,
    nodeVersion: deps.nodeVersion,
    cwd: deps.cwd,
  });
  const renderer = createRenderer({ color: resolveColor(options.noColor, process.env) });
  write(formatDoctor(checks, renderer));
  return checks.some((c) => c.status === 'FAIL') ? 1 : 0;
}

export type { RenderOptions };
