import process from 'node:process';
import { AppError } from '../core/errors.js';
import type { Runner } from '../core/runner.js';
import { createSandboxedRunner } from './sandbox.js';

/**
 * Mandatory boundary for executing commands originating from untrusted
 * repositories or model action protocols.
 *
 * A missing/malformed sandbox configuration is a refusal, NOT permission to
 * silently spawn on the host. The injected Runner seams used by the test
 * fixtures are not exposed as a product flag.
 */
export interface RepositoryRunnerOptions {
  readonly workspace: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Testable configuration source; never passed to the Docker child. */
  readonly env?: NodeJS.ProcessEnv;
}

export function createRepositoryCommandRunner(options: RepositoryRunnerOptions): Runner {
  return async (file, args) => {
    const env = options.env ?? process.env;
    const image = env.MERGESUTRA_SANDBOX_IMAGE;
    const dockerExecutable = env.MERGESUTRA_DOCKER_EXECUTABLE;
    if (!image || !dockerExecutable) {
      throw new AppError({
        kind: 'validation',
        message:
          'SANDBOX_UNAVAILABLE: Set a digest-pinned MERGESUTRA_SANDBOX_IMAGE and an absolute, ' +
          'trusted MERGESUTRA_DOCKER_EXECUTABLE. No repository command was executed.',
        remediation:
          'Configure an already-pulled image and a local Docker daemon, or leave the ' +
          'execution blocked. MergeSutra never falls back to host execution.',
      });
    }
    return createSandboxedRunner({
      workspace: options.workspace,
      cwd: options.cwd,
      image,
      dockerExecutable,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    })(file, args);
  };
}
