import { readFileSync } from 'node:fs';
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
