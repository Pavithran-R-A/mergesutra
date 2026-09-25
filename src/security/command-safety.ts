/**
 * Command-shape rules shared by every stage that touches a process.
 *
 * These are deliberately small, boring predicates: the same three properties
 * are checked on a command a model proposes (Stage 4), on a command the tool
 * policy is asked to authorise (Stage 5), and on anything a later stage runs.
 * One copy of a security rule is the point — two copies drift, and the drift is
 * invisible until a command gets through one of them.
 */

/** Characters that only mean something to a shell. Their presence is a tell
 *  that a command string arrived where an argv array belonged. */
const SHELL_COMPOSITION = /[;&|`$<>\n\r]/;

export function hasShellSyntax(token: string): boolean {
  return SHELL_COMPOSITION.test(token);
}

/** True when `argv` is a non-empty array of non-empty tokens with no shell syntax. */
export function isArgvShaped(argv: readonly string[]): boolean {
  return argv.length > 0 && argv.every((token) => token.length > 0 && !hasShellSyntax(token));
}

/**
 * Whether a token may name the program to execute.
 *
 * A bare program resolved through the platform's search path is auditable;
 * `./scripts/x.sh`, `C:\tools\git.exe` and `/usr/bin/curl` are the repository
 * or the machine choosing what runs, which is not MergeSutra's decision to
 * delegate. Backslashes are rejected on every platform because Windows accepts
 * them as separators.
 *
 * So is an internal space. `['npm test']` is one token, so it survives the
 * shell-syntax check, but no search path has a program by that name — it is a
 * command string wearing an array's clothes, and refusing it here is what keeps
 * "the program position is a program" true.
 */
export function isBareProgram(token: string): boolean {
  if (token.length === 0 || token.trim() === '') return false;
  if (/\s/.test(token)) return false;
  if (token.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(token)) return false;
  if (token.includes('/')) return false;
  return !hasShellSyntax(token);
}
