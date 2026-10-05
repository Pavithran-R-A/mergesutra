import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Process execution for MergeSutra.
 *
 * Commands are always expressed as an executable plus an argv array. `shell`
 * is never enabled, so nothing here interprets a command string: a value that
 * contains `;`, `&&` or a redirect stays a single literal argument. Repository,
 * issue and model text therefore cannot become shell syntax.
 *
 * The second property lives here because this is the only place a process is
 * actually started: a command MergeSutra runs never receives the model
 * credential, whatever the caller put in the environment. See
 * `CREDENTIAL_ENV_NAMES`.
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

/**
 * Environment names whose value is never handed to a command MergeSutra starts.
 *
 * The model credential is read by this process and spoken only to the BharatCode
 * endpoint, in a request header, by `src/bharatcode/client.ts`. No command a run
 * can name has any use for it — and a run *can* name `printenv`, `env`, or a
 * script that dumps its own environment, because those are ordinary programs and
 * the workspace is a legitimate place to run them. Refusing them would break the
 * repository's own build for a mistake MergeSutra makes by inheritance, so the
 * value is simply not there to print.
 *
 * `GH_TOKEN` and `GITHUB_TOKEN` are deliberately absent: `gh` is the read
 * transport and authenticates from them, so stripping them would break
 * `mergesutra issue` for every user who does not keep credentials in its
 * keyring. That is a different trust domain, and it is named in the docs rather
 * than quietly widened here.
 */
const CREDENTIAL_ENV_NAMES = ['bharatcode_api_key', 'bharatcode_key'];

/** The environment names this module refuses to pass on, in their lower-case spelling. */
export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_NAMES.includes(name.toLowerCase());
}

/**
 * The environment a child gets: the one offered, minus every credential name.
 *
 * Case-insensitive on purpose. On Windows `process.env` keys are matched without
 * regard to case while the object itself keeps whatever spelling the parent set,
 * so a filter that compared exact strings would leave `bharatcode_api_key` — or
 * `Bharatcode_Api_Key` — sitting in the child's environment on the one platform
 * where that spelling is normal.
 */
export function withoutCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !isCredentialEnvName(name)),
  ) as NodeJS.ProcessEnv;
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
    // The inheritance is what makes this the one right place for the rule: every
    // spawn in the product comes through here, `defaultRunner` and the bounded
    // runners the Stage 6 loop and the Stage 7 gate engine build, so a command a
    // model named and a command a repository named are covered by the same three
    // lines and there is no second door to remember to close.
    const env = withoutCredentialEnv(options.env ?? process.env);
    try {
      const { stdout, stderr } = await execFileAsync(file, [...args], {
        cwd: options.cwd,
        env,
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
