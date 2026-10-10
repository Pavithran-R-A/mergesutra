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
 * actually started: a command MergeSutra runs never receives model or GitHub
 * credentials, whatever the caller put in the environment. The one exception is
 * the dedicated GitHub read runner below, used only by MergeSutra's own `gh api`
 * transport and doctor probe; repository/workspace commands never receive it.
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
 * Environment names whose values are never handed to repository/workspace
 * commands that MergeSutra starts.
 *
 * Model credentials belong only to the BharatCode client. GitHub credentials
 * belong only to MergeSutra's own read transport. A repository command may be a
 * perfectly legitimate `printenv`, `env`, test runner, or script that prints
 * its environment; refusing such commands would break real repositories, so the
 * safer boundary is to omit the credentials from the child environment.
 */
const MODEL_CREDENTIAL_ENV_NAMES = ['bharatcode_api_key', 'bharatcode_key'];
const GITHUB_CREDENTIAL_ENV_NAMES = ['gh_token', 'github_token', 'github_pat'];

/**
 * A repository's own test script is executable code, not an authenticated
 * extension of MergeSutra. Scrub common unrelated credentials as well as the
 * two identities this CLI handles. This is defense in depth, NOT an OS sandbox:
 * a child can still read files permitted by the host account.
 */
const OTHER_CREDENTIAL_ENV_NAMES = new Set([
  'aws_access_key_id',
  'aws_secret_access_key',
  'aws_session_token',
  'database_url',
  'postgres_url',
  'google_application_credentials',
  'npm_config_//registry.npmjs.org/:_authtoken',
]);

/** Match conventional secret-bearing names without stripping ordinary build flags. */
const SECRET_ENV_NAME_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|token|secret|password|passphrase|private[_-]?key|credentials?|webhook)(?:$|[_-])/i;

/** The environment names ordinary child commands are never allowed to receive. */
export function isCredentialEnvName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    MODEL_CREDENTIAL_ENV_NAMES.includes(normalized) ||
    GITHUB_CREDENTIAL_ENV_NAMES.includes(normalized) ||
    OTHER_CREDENTIAL_ENV_NAMES.has(normalized) ||
    SECRET_ENV_NAME_PATTERN.test(normalized)
  );
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

function withoutModelCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        GITHUB_CREDENTIAL_ENV_NAMES.includes(name.toLowerCase()) || !isCredentialEnvName(name),
    ),
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

function createRunnerWithEnvFilter(
  options: RunnerOptions,
  filterEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
): Runner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return async (file, args) => {
    // The inheritance is what makes this the one right place for the rule: every
    // spawn in the product comes through here, `defaultRunner` and the bounded
    // runners the Stage 6 loop and the Stage 7 gate engine build, so a command a
    // model named and a command a repository named are covered by the same three
    // lines and there is no second door to remember to close.
    const env = filterEnv(options.env ?? process.env);
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

export function createRunner(options: RunnerOptions = {}): Runner {
  return createRunnerWithEnvFilter(options, withoutCredentialEnv);
}

/**
 * Dedicated runner for MergeSutra-owned GitHub reads.
 *
 * It still strips the BharatCode credential, but preserves GitHub authentication
 * so `gh api --method GET` and `gh auth status` can use an environment-backed
 * login. Do not use this runner for repository/workspace commands.
 */
export const githubReadRunner: Runner = createRunnerWithEnvFilter({}, withoutModelCredentialEnv);

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
