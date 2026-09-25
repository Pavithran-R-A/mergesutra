import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Process execution for MergeSutra.
 *
 * Commands are always expressed as an executable plus an argv array. `shell`
 * is never enabled, so nothing here interprets a command string: a value that
 * contains `;`, `&&` or a redirect stays a single literal argument. Repository,
 * issue and model text therefore cannot become shell syntax.
 */

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Why the process ended, as a fact rather than as prose.
   *
   * A verification receipt has to distinguish "exited 1" from "we killed it at
   * its timeout", and the only other place that distinction lived was the stderr
   * string — which is a thing to read, not a thing to depend on. Absent means a
   * scripted or third-party runner did not say; the reader treats that as "not
   * one of ours", never as a pass.
   */
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
}

export type Runner = (file: string, args: readonly string[]) => Promise<RunResult>;

export interface RunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

const execFileAsync = promisify(execFile);

interface ExecFailure {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export function createRunner(options: RunnerOptions = {}): Runner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return async (file, args) => {
    try {
      const { stdout, stderr } = await execFileAsync(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer,
      });
      return { code: 0, stdout, stderr, timedOut: false, truncated: false };
    } catch (error) {
      const e = (error ?? {}) as ExecFailure;
      // Node reports a bounded-output kill as ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return {
          code: 1,
          stdout: e.stdout ?? '',
          stderr: `output exceeded ${maxBuffer} bytes; command aborted`,
          timedOut: false,
          truncated: true,
        };
      }
      if (e.killed || e.signal === 'SIGTERM') {
        return {
          code: 1,
          stdout: e.stdout ?? '',
          stderr: `command timed out after ${timeoutMs}ms`,
          timedOut: true,
          truncated: false,
        };
      }
      // A command that never started has no stderr; its reason lives in `message`.
      const stderr = e.stderr && e.stderr.trim().length > 0 ? e.stderr : e.message;
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: firstLine(stderr ?? `${file} failed`),
        timedOut: false,
        truncated: false,
      };
    }
  };
}

/** The default production runner: bounded, hidden console on Windows, argv only. */
export const defaultRunner: Runner = createRunner();

/** Run a command, returning null when it could not be started at all. */
export async function safeRun(
  run: Runner,
  file: string,
  args: readonly string[],
): Promise<RunResult | null> {
  try {
    return await run(file, args);
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}
