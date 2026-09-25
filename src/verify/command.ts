import { hasShellSyntax, isBareProgram } from '../security/command-safety.js';

/**
 * Turning a command *string* into an argv array — Stage 7.
 *
 * Every source of verification commands MergeSutra knows about describes them as
 * text a shell would read: a `run:` step in a workflow, the body of a
 * package.json script, a line in CONTRIBUTING.md. MergeSutra executes argv arrays
 * with `shell: false` (see `core/runner.ts`), because the alternative is letting
 * a repository file run arbitrary code on the operator's machine. The two shapes
 * only meet here.
 *
 * The rule is not "reject dangerous commands" — that is the tool policy's job,
 * later, on the argv. The rule here is that a character a shell would have
 * *interpreted* has no faithful argv spelling, so a step containing one is not a
 * gate MergeSutra can run. Refusing is the honest answer; stripping the quotes
 * and hoping is not.
 *
 * What is accepted is deliberately narrow: one short line, whitespace-separated,
 * naming a bare program on the search path. A repository that means something
 * more elaborate than that is a repository whose gate needs a human to say so.
 */

/** Longer than this is not one command, and it is also how a capped read looks. */
export const MAX_GATE_COMMAND_CHARS = 240;

/** Quotes were the shell's, not the program's: their absence changes the words. */
const QUOTING = /["']/;
/** Braces, globs and history: a shell resolves these before the program starts. */
const EXPANSION = /[*?{}!~\\]/;

export type ArgvTranslation =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function toExecutableArgv(text: string): ArgvTranslation {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return unusable('the step carries no command text');
  }
  if (/[\n\r]/.test(trimmed)) {
    return unusable(
      'it spans more than one line, and a gate is one program with its arguments',
      trimmed,
    );
  }
  if (trimmed.length > MAX_GATE_COMMAND_CHARS) {
    return unusable(
      `it is ${trimmed.length} characters, too long for one gate command (the limit is ${MAX_GATE_COMMAND_CHARS}, and a step the reader capped looks exactly like this)`,
      trimmed,
    );
  }

  const [program = '', ...rest] = trimmed.split(/\s+/);
  if (!isBareProgram(program)) {
    return unusable(
      `'${program}' is not a bare program name, so the repository or the machine would be choosing what runs`,
      trimmed,
    );
  }
  // Ordered by how specific the complaint is: composition first, because that is
  // the injection shape, then quoting, then expansion.
  for (const token of [program, ...rest]) {
    if (hasShellSyntax(token)) {
      return unusable(
        'it contains shell composition (`;`, `&`, `|`, `<`, `>`, `$`, backticks), which only means something to a shell',
        trimmed,
      );
    }
    if (QUOTING.test(token)) {
      return unusable(
        `it is quoted (${token}), and the quotes were there to group words for a shell`,
        trimmed,
      );
    }
    if (EXPANSION.test(token)) {
      return unusable(
        `it contains ${token}, which a shell would have expanded before the program saw it`,
        trimmed,
      );
    }
  }

  return { ok: true, argv: [program, ...rest] };
}

function unusable(why: string, text?: string): ArgvTranslation {
  const named = text === undefined ? '' : ` (${oneLine(text)})`;
  return { ok: false, reason: `Refusing to treat this command as a gate: ${why}${named}.` };
}

function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ');
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}...`;
}
