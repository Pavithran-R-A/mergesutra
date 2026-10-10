import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A customer is told to configure BharatCode through the environment. If a variable's name
 * only appears in `src/`, "set it" is an instruction to read source, so the names the
 * configuration layer and the adapter actually use have to be printed in the README. This
 * checks set inclusion of stable identifiers, not the wording around them.
 */
const namesIn = (relativePath: string): string[] => {
  const source = readFileSync(join(ROOT, relativePath), 'utf8');
  return [...new Set(source.match(/BHARATCODE_[A-Z0-9_]+/g) ?? [])].sort();
};

const undocumentedIn = (names: string[], readme: string): string[] =>
  names.filter((name) => !readme.includes(name));

describe('the BharatCode configuration surface is documented, not only readable from source', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('names every variable the configuration layer reads', () => {
    const names = namesIn('src/config/load-config.ts');
    expect(
      names.length,
      'the configuration layer reads BHARATCODE_* variables at all',
    ).toBeGreaterThan(3);
    expect(undocumentedIn(names, readme), 'README omits a configuration variable').toEqual([]);
  });

  it('makes the required no-default model explicit in first-use instructions', () => {
    const firstUse = readme.slice(0, readme.indexOf('## Why MergeSutra'));
    expect(firstUse).toContain('There is no default BharatCode model.');
    expect(firstUse).toContain('BHARATCODE_MODEL');
    expect(firstUse).toContain('https://bharatcode.ai/build');
  });

  it('names the variable the adapter asks for when no model is selected', () => {
    const names = namesIn('src/bharatcode/client.ts');
    expect(names.length, 'the adapter names a configuration variable in a refusal').toBeGreaterThan(
      0,
    );
    expect(
      undocumentedIn(names, readme),
      'README omits a variable the adapter refuses for',
    ).toEqual([]);
  });
});

/**
 * The same promise, read from the other end (register S14-6).
 *
 * The cases above stop a variable being hidden in source. They cannot stop the
 * opposite defect, which is what a consumer actually trips over: a name printed in
 * the manual that no code reads, so setting it is an instruction to do nothing.
 * `MERGESUTRA_ALLOW_REMOTE_PUBLICATION` sat in `README.md` described as "a capability
 * this build leaves unset", which reads as though the capability exists and a flag
 * would turn it on. It does not: `src/pr/publisher.ts` ships `unavailableRemote()`,
 * whose two methods refuse unconditionally, and no `env` lookup anywhere in the
 * repository carries that name.
 *
 * So the family of names a person could plausibly set is taken from the README, and
 * each has to be *spoken* by the code that would honour it: looked up on an `env`
 * object in `src/` or in the suites that exercise a harness-only switch, or carried as
 * a quoted constant in `src/` where it is a state word rather than a variable. A prose
 * mention in a comment, in this file's own text or anywhere else, is deliberately not
 * enough — otherwise documenting a phantom would be the way to make it pass. What is
 * checked is existence, never wording, so an honest rephrasing of any entry above keeps
 * this green while inventing a switch does not.
 */
const ENV_NAME_FAMILY =
  /\b(?:BHARATCODE_[A-Z0-9_]+|MERGESUTRA_[A-Z0-9_]+|GH_[A-Z0-9_]+|GITHUB_[A-Z0-9_]+|NO_COLOR|FORCE_COLOR)\b/g;

function everySourceText(relativeDir: string): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) chunks.push(readFileSync(full, 'utf8'));
    }
  };
  walk(join(ROOT, relativeDir));
  return chunks.join('\n');
}

const SRC = everySourceText('src');
const CODE = `${SRC}\n${everySourceText('tests')}`;

/** Whether some `env` in this repository actually looks the name up. */
function isReadFromEnvironment(name: string): boolean {
  return (
    new RegExp(`(?:process\\.)?env\\.${name}\\b`).test(CODE) ||
    new RegExp(`(?:process\\.)?env\\[['"]${name}['"]\\]`).test(CODE)
  );
}

/** Whether `src/` carries the name as a value it produces, not prose about one. */
function isCodeConstant(name: string): boolean {
  return SRC.includes(`'${name}'`);
}

describe('the README promises no switch the code does not have', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const named = [...new Set(readme.match(ENV_NAME_FAMILY) ?? [])].sort();

  it('finds a configuration surface worth checking', () => {
    expect(
      named.length,
      'the README names no environment-shaped identifier at all',
    ).toBeGreaterThan(6);
  });

  it('names only variables something reads, or constants something emits', () => {
    const unread = named.filter((name) => !isReadFromEnvironment(name) && !isCodeConstant(name));
    expect(
      unread,
      `the README describes an environment variable no code reads: ${unread.join(', ')}`,
    ).toEqual([]);
  });
});
