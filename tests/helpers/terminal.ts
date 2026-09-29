import { expect } from 'vitest';

/**
 * The assertion vocabulary every S12-11 file shares.
 *
 * A terminal-safety test that asserts on substrings of ANSI codes proves nothing about
 * the property: `[31m` appears in a payload that was neutralised and in one that was
 * not, because the sanitizer leaves the *letters* alone. So the vocabulary here is built
 * out of code points and counts — "is any control still able to act?", "is every ESC on
 * this page one our renderer wrote?", "did any line start at the left margin that the
 * screen did not put there?" — and the tests say the property in those terms.
 */

/** Turn a code point into the visible spelling this build writes for it: `\u001b`. */
export function shown(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, '0')}`;
}

const SPELLING = /\\u([0-9a-f]{4})/g;

/** Read the visible spellings back into code points, to prove nothing was deleted. */
export function inertSpellingDecodes(text: string): string {
  return text.replace(SPELLING, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

export const NUL = String.fromCharCode(0x00);
export const BEL = String.fromCharCode(0x07);
export const BS = String.fromCharCode(0x08);
export const TAB = String.fromCharCode(0x09);
export const LF = String.fromCharCode(0x0a);
export const CR = String.fromCharCode(0x0d);
export const ESC = String.fromCharCode(0x1b);
export const DEL = String.fromCharCode(0x7f);
export const CSI8 = String.fromCharCode(0x9b);
export const ST8 = String.fromCharCode(0x9c);
export const OSC8 = String.fromCharCode(0x9d);
export const ALM = String.fromCharCode(0x061c);
export const LRM = String.fromCharCode(0x200e);
export const RLM = String.fromCharCode(0x200f);
export const LRE = String.fromCharCode(0x202a);
export const RLE = String.fromCharCode(0x202b);
export const PDF = String.fromCharCode(0x202c);
export const LRO = String.fromCharCode(0x202d);
export const RLO = String.fromCharCode(0x202e);
export const LS = String.fromCharCode(0x2028);
export const PS = String.fromCharCode(0x2029);
export const LRI = String.fromCharCode(0x2066);
export const RLI = String.fromCharCode(0x2067);
export const FSI = String.fromCharCode(0x2068);
export const PDI = String.fromCharCode(0x2069);

/**
 * Every code point this build treats as a display control: all of C0, DEL, the whole
 * C1 range, the Bidi_Control set, and the two separators JSON leaves raw.
 */
const CONTROL =
  // eslint-disable-next-line no-control-regex -- naming the control ranges *is* the property
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** The first control code point still active in `text`, or null when none is. */
export function activeControl(text: string, allowed = ''): string | null {
  for (const char of text) {
    if (CONTROL.test(char) && !allowed.includes(char)) {
      return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return null;
}

/**
 * Asserts the sink carries no live control. `allowed` names the structural bytes that
 * particular sink is entitled to keep: a page may end its rows with LF, a single-line
 * row may not even hold one.
 */
export function expectInert(text: string, sink: string, allowed = LF): void {
  const offender = activeControl(text, allowed);
  expect(offender, `${sink} still carries ${offender ?? 'nothing'}`).toBeNull();
}

/**
 * On a coloured page the renderer's own SGR sequences are the only escape sequences
 * allowed to exist at all. Counting them is stronger than stripping a list of trusted
 * codes: an unescaped `ESC[2J`, `ESC]0;`, an 8-bit CSI or a bidi control all fail here.
 */
export function onlyRendererOwnColour(text: string, sink: string): void {
  const own = text.match(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')) ?? [];
  expect(text.split(ESC).length - 1, `${sink}: an ESC that is not one of our own SGR codes`).toBe(
    own.length,
  );
}

/** A row that begins at the left margin with a state word is a forged verdict. */
export function forgedRows(text: string): string[] {
  return text
    .split(LF)
    .filter((line) =>
      /^(PASS|FAIL|WARN|SKIP|INFO|READY|WAITING|EXECUTED|HUMAN APPROVAL)\b/.test(line),
    );
}

/**
 * The same property for a screen that carries its *own* badge column at the left margin
 * (doctor, intake, and the pr page's closing rows): there a line opening with `PASS` can
 * be the screen doing its job, so the assertion names the verdicts the hostile value was
 * trying to counterfeit instead.
 */
export function counterfeitedRows(text: string, claims: readonly string[]): string[] {
  return text.split(LF).filter((line) => claims.some((claim) => line.startsWith(claim)));
}

/** A sink capture that keeps the lines separate, because a row boundary is the claim. */
export function capture(): { lines: string[]; write: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => lines.push(line),
    text: () => lines.join(LF),
  };
}
