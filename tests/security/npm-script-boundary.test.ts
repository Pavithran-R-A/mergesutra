import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * S12-22 — a documentation-boundary contract, not a source snapshot.
 *
 * The argv rules and `shell: false` govern the process MergeSutra itself starts.
 * They do not reach the body of a `package.json` script that npm then runs,
 * because npm re-parses that body with its own shell. That asymmetry is a trust
 * boundary *after* consent, and the only honest closure for it is a written
 * statement that cannot quietly disappear: this test reads the committed security
 * documentation and fails if the statement, or any of the facts it depends on,
 * is gone. It matches on meaning (a term has to sit near its qualifying term in
 * the same sentence), never on line numbers, so the prose can be reworded as long
 * as the boundary is still drawn.
 */

const DOC = readFileSync(new URL('../../docs/SECURITY_MODEL.md', import.meta.url), 'utf8');
const HEADING = '### npm package scripts are a second interpreter';

/** The subsection under its heading, up to the next heading of any level. */
function section(): string {
  const start = DOC.indexOf(HEADING);
  expect(start, `the security model no longer has the "${HEADING}" subsection`).toBeGreaterThan(-1);
  const rest = DOC.slice(start + HEADING.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Whitespace collapsed so a wrapped sentence still matches one flowing clause. */
function sentences(): string[] {
  return section()
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?]) /)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when one sentence carries all of these patterns (so terms stay in scope). */
function someSentence(patterns: readonly RegExp[]): string | undefined {
  return sentences().find((sentence) => patterns.every((pattern) => pattern.test(sentence)));
}

describe('the npm package-script interpreter boundary (S12-22)', () => {
  it('says MergeSutra authors the direct invocation as an argv array with no shell', () => {
    expect(
      someSentence([/argv array/, /without a shell/, /direct invocation/]),
      'the boundary does not state what argv/shell:false actually govern',
    ).toBeDefined();
  });

  it('says npm itself interprets the repository-authored script body', () => {
    expect(
      someSentence([/npm itself interprets/i, /script/i]),
      'the boundary does not name npm as the interpreter of the body',
    ).toBeDefined();
  });

  it('says npm runs that body through its own shell, so a shell operator in it is outside MergeSutra', () => {
    expect(
      someSentence([/its own (script )?shell/i, /outside MergeSutra/i]),
      'the boundary does not say the script shell is npm’s, outside the argv parser',
    ).toBeDefined();
  });

  it('names the platform shell npm reaches for, and that it can be changed', () => {
    expect(
      someSentence([/\/bin\/sh/, /cmd\.exe/, /script-shell/]),
      'the boundary does not state the POSIX/Windows default or the override',
    ).toBeDefined();
  });

  it('draws the limit as a trust boundary after consent, not a way around consent', () => {
    expect(
      someSentence([/consent/i, /not evidence/i, /shell operation/i]),
      'the boundary does not say consent is not an approval of every operation in the body',
    ).toBeDefined();
  });

  it('files executionClass / MUTATION_CAPABLE as disclosure, not a parser or sandbox for the body', () => {
    expect(
      someSentence([/disclosure/i, /not a parser|not.*sandbox/i]),
      'the boundary does not disarm executionClass as disclosure-only',
    ).toBeDefined();
  });

  it('keeps direct package-manager verbs refused by policy before consent, so the limit is not a loophole', () => {
    expect(
      someSentence([/npm publish/, /before consent/i]),
      'the boundary does not preserve the tool-policy-before-consent refusal for direct verbs',
    ).toBeDefined();
  });

  it('never claims shell:false makes the script body itself shell-free', () => {
    // The single false statement the whole section exists to avoid. Wording is
    // free so long as nobody asserts that running without a shell sanitises a
    // body npm re-parses with a shell.
    expect(DOC).not.toMatch(/shell:\s*false[^.]*?(makes|renders|keeps)[^.]*?shell-?free/i);
  });
});
