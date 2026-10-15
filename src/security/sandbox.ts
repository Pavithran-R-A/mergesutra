import path from 'node:path';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AppError } from '../core/errors.js';
import { createRunner, type Runner, type RunnerOptions } from '../core/runner.js';
import { isBareProgram } from './command-safety.js';

/**
 * A narrow, opt-in Docker execution boundary for repository-controlled programs.
 *
 * A Git worktree and a scrubbed environment are NOT an OS sandbox. This
 * runner starts an unprivileged, offline container with only the worktree
 * mounted. It does not mount the user's home, Docker socket, Git credentials
 * or the primary checkout. It never falls back to host execution.
 *
 * Callers must use a separate, trusted runner for MergeSutra-owned Git reads.
 * Production Stage 6/7 wiring and adversarial engine-backed qualification
 * are separate release gates; merely constructing this runner closes neither.
 */
export interface SandboxedRunnerOptions extends RunnerOptions {
  /** Root of the single run-owned workspace; may not be a symlink. */
  readonly workspace: string;
  /** Image must be already present locally and pinned by digest. */
  readonly image: string;
  /** Absolute trusted Docker CLI path; never resolve Docker via repository-controlled PATH. */
  readonly dockerExecutable: string;
  /** Only for deterministic transport tests; defaults to a scrubbed host runner. */
  readonly hostRun?: Runner;
}

const DIGEST_IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const SANDBOX_ROOT = '/workspace';

function unavailable(reason: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `SANDBOX_UNAVAILABLE: ${reason}. No repository command was executed.`,
    remediation:
      'Preload a digest-pinned Linux image into a trusted local Docker Engine, ' +
      'or leave the repository execution blocked. Never fall back to host execution.',
  });
}

/**
 * Build exactly the Docker flags this security boundary permits.
 * No caller-supplied Docker options, host environment, network or capabilities.
 */
export function sandboxDockerArgv(input: {
  workspace: string;
  cwd: string;
  image: string;
  file: string;
  args: readonly string[];
  uid?: number;
  gid?: number;
}): string[] {
  if (!DIGEST_IMAGE.test(input.image)) throw unavailable('container image must use @sha256 digest');
  if (!path.isAbsolute(input.workspace) || !path.isAbsolute(input.cwd)) {
    throw unavailable('workspace and command directory must be absolute paths');
  }
  let workspace: string;
  try {
    // A run-owned root is never a caller-chosen alias to a different directory.
    // Resolving it silently would defeat the promise made to the operator.
    if (lstatSync(input.workspace).isSymbolicLink()) {
      throw unavailable('workspace root cannot be a symlink');
    }
    workspace = realpathSync(input.workspace);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable('workspace root is unavailable');
  }
  // Both paths must exist at invocation, not merely be lexically inside the root.
  const cwd = realpathSync(input.cwd);
  const relative = path.relative(workspace, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unavailable('command directory resolves outside its workspace');
  }
  if (workspace.includes(',') || /[\r\n\0]/.test(workspace)) {
    throw unavailable('workspace path cannot be expressed safely as a bind mount');
  }
  if (!isBareProgram(input.file) || input.args.some((a) => a.includes('\0'))) {
    throw unavailable('executable name or arguments cannot be passed safely');
  }
  const uid = input.uid ?? process.getuid?.() ?? 1000;
  const gid = input.gid ?? process.getgid?.() ?? 1000;
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0) {
    throw unavailable('invalid unprivileged execution identity');
  }
  // A host running as root does not grant container root. Such a setup may
  // require adjusting worktree ownership for this unprivileged UID instead.
  const identity = `${uid === 0 ? 1000 : uid}:${gid === 0 ? 1000 : gid}`;
  const within = relative ? `/${relative.split(path.sep).join('/')}` : '';
  return [
    'run',
    '--rm',
    '--pull=never',
    '--network=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--read-only',
    '--pids-limit=64',
    '--memory=512m',
    '--cpus=1',
    '--tmpfs=/tmp:rw,nosuid,noexec,size=64m',
    '--user',
    identity,
    '--mount',
    `type=bind,source=${workspace},target=${SANDBOX_ROOT}`,
    '--workdir',
    `${SANDBOX_ROOT}${within}`,
    '--env=HOME=/tmp',
    '--env=XDG_CONFIG_HOME=/tmp',
    '--env=npm_config_cache=/tmp/npm-cache',
    '--env=CI=1',
    // Run exactly the program the caller named. An image's own entrypoint is
    // free to reinterpret an argv it does not recognise — the official `node`
    // images prepend `node`, so a gate that asked for `git status` would have
    // `node git status` executed instead, and its exit code recorded as the
    // gate's. Naming the entrypoint removes the image from that decision; a
    // missing program then fails at container creation instead of running
    // something else.
    '--entrypoint',
    input.file,
    input.image,
    ...input.args,
  ];
}

/**
 * A Docker CLI launch must not inherit settings that can redirect it to a
 * remote daemon, load credentials, change its context, or select plugins.
 * An absolute docker executable is selected separately by the operator.
 */
export function dockerClientEnvironment(configDir: string): NodeJS.ProcessEnv {
  return {
    DOCKER_CONFIG: configDir,
    HOME: configDir,
    USERPROFILE: configDir,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

/** Create a fail-closed runner; a missing Docker daemon/image never runs on the host. */
export function createSandboxedRunner(options: SandboxedRunnerOptions): Runner {
  // Reject invalid images before even attempting a Docker command.
  if (!DIGEST_IMAGE.test(options.image))
    throw unavailable('container image must use @sha256 digest');
  if (!path.isAbsolute(options.dockerExecutable)) {
    throw unavailable('Docker executable must have an absolute, operator-selected path');
  }
  let dockerExecutable: string;
  try {
    dockerExecutable = realpathSync(options.dockerExecutable);
    if (!statSync(dockerExecutable).isFile()) throw unavailable('Docker binary is not a file');
    const workspace = realpathSync(options.workspace);
    const relative = path.relative(workspace, dockerExecutable);
    if (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ) {
      throw unavailable('Docker executable resolves inside the untrusted workspace');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable('selected trusted Docker executable is unavailable');
  }
  const hostRun: Runner =
    options.hostRun ??
    (async (file, args) => {
      // Never let DOCKER_HOST, DOCKER_CONTEXT, DOCKER_CONFIG, proxy variables,
      // or a user's Docker auth settings redirect a supposedly local launch.
      // Every operation gets a private, empty client configuration directory.
      const configDir = await mkdtemp(path.join(tmpdir(), 'mergesutra-docker-client-'));
      try {
        return await createRunner({
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          env: dockerClientEnvironment(configDir),
        })(file, args);
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    });

  return async (file, args) => {
    const argv = sandboxDockerArgv({
      workspace: options.workspace,
      cwd: options.cwd ?? options.workspace,
      image: options.image,
      file,
      args,
    });
    // Unlike `docker run`, image inspect is read-only and cannot pull from
    // the network; it ensures a missing image returns NOT_EXECUTED.
    const probe = await hostRun(dockerExecutable, ['image', 'inspect', options.image]);
    if (probe.code !== 0) throw unavailable('local Docker image or daemon is unavailable');
    const result = await hostRun(dockerExecutable, argv);
    // Docker failures have ambiguous origin (daemon error versus program
    // failure). Never claim the command passed unless the container exited 0.
    return result;
  };
}
