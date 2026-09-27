import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reading a stage's source without running any of it.
 *
 * A stage boundary is a claim about *what that stage could be asked to do*, and the
 * only way to check one over a whole reachability closure is to read the closure as
 * data. Nothing here executes a command, imports a stage or touches a workspace: a
 * test that ran `git push` to prove the product refuses it would be the incident it
 * was written to catch.
 *
 * `tests/repair/source-shape.test.ts` carries its own copy of these scans and keeps
 * it on purpose — Stage 9R is closed, and rewriting its guard to match a later
 * helper would unsettle a proven file for no added check. This is the shared
 * version for the stages that follow.
 */

export const SRC = path.join(process.cwd(), 'src');

export interface Site {
  readonly file: string;
  readonly argv: readonly string[];
  /** True when an element was a spread or interpolation, so the command is only partly known. */
  readonly open: boolean;
}

export function relative(file: string): string {
  return path.relative(SRC, file).replace(/\\/g, '/');
}

export function show(site: Site): string {
  return `${site.file}: ${site.argv.join(' ')}${site.open ? ' (open)' : ''}`;
}

/** Strip comments: a refusal explained in prose is not a command being proposed. */
export function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every module a set of entries can arrive at, by following the imports themselves.
 *
 * Read from source rather than from a hand-kept list, because the change worth
 * catching is the one nobody announces: a module that started importing a second
 * pair of hands would not say so in a checklist.
 */
export async function reachFrom(entries: readonly string[]): Promise<Map<string, string>> {
  const seen = new Set<string>();
  for (const entry of entries) await walk(entry, seen);
  const files = [...seen].sort();
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return new Map(files.map((file, index) => [relative(file), texts[index] ?? '']));
}

async function walk(absolute: string, seen: Set<string>): Promise<void> {
  if (seen.has(absolute)) return;
  seen.add(absolute);
  const text = await readFile(absolute, 'utf8');
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)\.js['"]/g)) {
    const target = (match[1] ?? '').replace(/^\.\//, '');
    const next = path.join(path.dirname(absolute), `${target}.ts`);
    // `src/` only: this is a question about this product's code, not about Node.
    if (next.startsWith(SRC) && !next.includes('node_modules')) await walk(next, seen);
  }
}

/**
 * Every place the source writes a command out, with the parts it cannot read
 * reported rather than skipped.
 *
 * The anchors are calls that hand an array to a runner (`run('git', […]`,
 * `safeRun(run, 'gh', […]`, the project's own `git(run, dir, […]`) plus a literal
 * that opens with `'git'` plus a gate spec's `argv:`. Anything else that merely
 * *spells* a program name — the set of forbidden ones in `tool-policy.ts`, a
 * remediation sentence telling a person to run `git push` themselves — is data
 * about commands, and counting it would turn the guard's own vocabulary into a
 * finding.
 */
export function constructions(sources: Map<string, string>): Site[] {
  const sites: Site[] = [];
  const seen = new Set<string>();
  for (const [file, text] of sources) {
    const body = code(text);
    for (let open = body.indexOf('['); open !== -1; open = body.indexOf('[', open + 1)) {
      const before = body.slice(0, open);
      const contents = arrayBody(body, open);
      if (contents === null) continue;
      const anchor = ANCHORS.find((entry) => entry.call.test(before));
      if (!anchor && !GIT_INSIDE.test(contents)) continue;
      const { tokens, open: isOpenSite } = argvOf(contents);
      const external = anchor?.program ?? PROGRAM_BEFORE.exec(before)?.[1];
      const argv = GIT_INSIDE.test(contents) ? ['git', ...tokens.slice(1)] : tokens;
      if (argv.length === 0) continue;
      const key = `${file}\u0000${argv.join('\u0000')}\u0000${String(isOpenSite)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ file, argv: external ? [external, ...argv] : argv, open: isOpenSite });
    }
  }
  return sites.sort((a, b) =>
    `${a.file} ${a.argv.join(' ')}`.localeCompare(`${b.file} ${b.argv.join(' ')}`),
  );
}

const ANCHORS: ReadonlyArray<{ readonly call: RegExp; readonly program?: string }> = [
  { call: /\brun\(\s*['"][A-Za-z][\w.+-]*['"]\s*,\s*$/ },
  { call: /\bsafeRun\(\s*[A-Za-z_$][\w$]*\s*,\s*['"][A-Za-z][\w.+-]*['"]\s*,\s*$/ },
  { call: /\bgit\(\s*[A-Za-z_$][\w$]*\s*,\s*[^,[\s]+\s*,\s*$/, program: 'git' },
  { call: /\bargv:\s*$/ },
];

/** A program named just before the array, as in `run('git', […])`. */
const PROGRAM_BEFORE = /['"]([A-Za-z][\w.+-]*)['"]\s*,\s*$/;

/** A command whose own first element is the program, as in `['git', '-C', root, …]`. */
const GIT_INSIDE = /^\s*['"]git['"]\s*[,\]]/;

/**
 * The elements of an argv array, position by position.
 *
 * A value the source does not write out becomes `'value'`, not nothing: git reads
 * its arguments by position, so dropping `-C`'s directory would promote the next
 * flag into the subcommand's seat and classify a command that does not exist.
 */
function argvOf(contents: string): { tokens: string[]; open: boolean } {
  const tokens: string[] = [];
  let open = false;
  for (const element of splitElements(contents)) {
    const literal = /^'([^'\n]*)'$/.exec(element);
    if (literal) {
      tokens.push(literal[1] ?? '');
      continue;
    }
    // A spread or an interpolation leaves the command only partly known here, and a
    // half-known command cannot be cleared — so the site is reported as open.
    if (element.startsWith('...') || element.includes('`') || element.includes('${')) {
      open = true;
      continue;
    }
    if (element.length === 0) continue;
    tokens.push('value');
  }
  return { tokens, open };
}

/** Split an array literal's body on its commas, ignoring those inside a string. */
function splitElements(contents: string): string[] {
  const out: string[] = [];
  let quote = '';
  let depth = 0;
  let current = '';
  for (const char of contents) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out.filter((element) => element.length > 0);
}

/**
 * The contents of the array literal starting at `[`, read to its `]`.
 *
 * A bracket-scan rather than `[^\]]*`, because a git command's own arguments are
 * full of brackets — `'refs/remotes/origin/HEAD'`, `'[src/parse.ts]'` — and a
 * pattern that stopped at the first would end the scan early in silence. A command
 * cut off mid-argv looks exactly like a command that was never there.
 */
function arrayBody(text: string, open: number): string | null {
  let quote = '';
  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ']') return text.slice(open + 1, i);
  }
  return null;
}

/**
 * Every quoted token that could be an import specifier.
 *
 * A plain substring test for `'core/runner.js` would miss how a sibling directory
 * is actually imported — `'../core/runner.js'` — and the miss would be the whole
 * loophole, since every module reaches the rest of the project that way.
 */
export function importedSpecifiers(text: string): string[] {
  return [...text.matchAll(/['"]([^'"\n]*)['"]/g)]
    .map((match) => match[1] ?? '')
    .filter((token) => token.startsWith('.') || token.startsWith('/') || token.startsWith('node:'))
    .map((token) => token.replace(/^node:/, ''));
}

/** Whether a file imports a module by that path, under any of its prefixes. */
export function importsSpecifier(text: string, specifier: string): boolean {
  const bare = specifier.replace(/^node:/, '');
  return importedSpecifiers(text).some(
    (token) => token === bare || token.startsWith(`${bare}/`) || token.endsWith(`/${bare}`),
  );
}
