/**
 * Terminal-control and bidirectional-formatting safety for anything MergeSutra prints.
 *
 * `redaction.ts` answers one question at these sinks: *may this secret be visible?* This
 * module answers a different one: *may these bytes change how the terminal displays
 * everything printed after them?* The two are unrelated properties, and a screen that
 * masks a credential has said nothing about the two bytes that clear the page and write
 * `PASS — every criterion verified` into the space it vacated.
 *
 * The mechanism is encoding, never filtering. A control code point becomes the six
 * ASCII characters that name it — a backslash, a `u`, and four hex digits — so the
 * reader still sees what the document held, including a claim worth disbelieving, while
 * nothing that reached the terminal can act on it. Ordinary text comes back byte for
 * byte: Devanagari, Arabic, Hebrew, Urdu, Persian, emoji, box drawing, smart quotes,
 * Windows paths. A build that mangled a reviewer's RTL prose would not be safer, only
 * less readable.
 *
 * Two modes, because a page has two kinds of slot:
 *
 * - **single-line** (`terminalSafeSingleLine`, `terminalSafeDocument`) for a value that
 *   sits inside a row. A row's line break is the screen's to place, so an embedded LF,
 *   CR or TAB becomes visible too — otherwise one newline in a caveat is a fresh row at
 *   the left margin, which is exactly where MergeSutra's own status words live.
 * - **text** (`terminalSafeText`) for a block the screen lays out line by line itself:
 *   a page preview, a quoted finding. There the break is the screen's structure and
 *   survives; every byte that could move a cursor, erase, restyle, retitle the window,
 *   open a hyperlink, switch buffers, ring the bell or reorder the run of text does not.
 *
 * What is escaped, in full: C0 (U+0000-U+001F), DEL (U+007F), the whole C1 range
 * (U+0080-U+009F, which holds CSI and OSC in their 8-bit forms, so filtering ASCII ESC
 * alone would not close them), the Unicode `Bidi_Control` set (U+061C, U+200E, U+200F,
 * U+202A-U+202E, U+2066-U+2069), and U+2028/U+2029, which `JSON.stringify` leaves raw
 * and which some terminals treat as line breaks. Everything else stays printable.
 *
 * Ordering is fixed by `docs/SECURITY_MODEL.md`: untrusted value -> secret redaction ->
 * terminal safety -> trusted renderer styling -> terminal. Escaping after styling would
 * destroy MergeSutra's own colour, which this build wants to keep; escaping before
 * redaction would put a control sequence in front of the mask that has to see the text
 * first. This module therefore holds no secret patterns of its own.
 */

/**
 * Every code point this module is willing to replace, as inclusive ranges.
 *
 * A table of numbers rather than a regex character class because this file is the one
 * place in the build that has to prove it contains none of the bytes it guards: writing
 * the class literally put invisible bidi controls into the sanitizer's own source, which
 * is the exact confusion the module exists to prevent. The letters of RTL scripts are
 * deliberately absent — they are the text, not a control over it.
 */
const FORGED_RANGES = [
  [0x0000, 0x001f], // C0: NUL, BEL, BS, TAB, LF, CR, ESC and the rest
  [0x007f, 0x009f], // DEL plus all of C1, holding 8-bit CSI and OSC
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x200e, 0x200f], // LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT MARK
  [0x2028, 0x2029], // LINE SEPARATOR, PARAGRAPH SEPARATOR
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
  [0x2066, 0x2069], // LRI, RLI, FSI, PDI
] as const;

type RangeSet = readonly (readonly [number, number])[];

function within(codePoint: number, ranges: RangeSet): boolean {
  return ranges.some(([low, high]) => codePoint >= low && codePoint <= high);
}

const ESCAPE_INTRODUCER = String.fromCharCode(0x5c, 0x75);

function spellingOf(codePoint: number): string {
  return `${ESCAPE_INTRODUCER}${codePoint.toString(16).padStart(4, '0')}`;
}

function encode(value: string, shouldEscape: (codePoint: number) => boolean): string {
  let out = '';
  // Iterating by code point keeps a surrogate pair whole.
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += shouldEscape(code) ? spellingOf(code) : char;
  }
  return out;
}

/**
 * A value destined for a row: every control in it becomes visible, including the line
 * break, because the row is the unit a reader trusts.
 */
export function terminalSafeSingleLine(value: string): string {
  return encode(value, (code) => within(code, FORGED_RANGES));
}

/**
 * A value destined for a block the screen breaks up itself: real line breaks and tabs
 * survive as structure, everything that could take over the display does not.
 */
export function terminalSafeText(value: string): string {
  return encode(value, (code) => code !== 0x09 && code !== 0x0a && within(code, FORGED_RANGES));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asView(value: unknown): unknown {
  if (typeof value === 'string') return terminalSafeSingleLine(value);
  if (Array.isArray(value)) return value.map(asView);
  if (isPlainObject(value)) {
    // `Object.fromEntries` defines rather than assigns, so a key named `__proto__`
    // stays a key on the copy instead of becoming the prototype of it.
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [terminalSafeSingleLine(key), asView(entry)]),
    );
  }
  return value;
}

/**
 * The display copy of a whole document: every string key and leaf in single-line mode,
 * everything else — numbers, booleans, null, the shape of the arrays — exactly as filed.
 *
 * It is a copy. A screen that repaired or trimmed the record it was showing would leave
 * the reader no way to check the page against the evidence, and the document outlives
 * the terminal that displayed it.
 */
export function terminalSafeDocument<T>(document: T): T {
  return asView(document) as T;
}

/**
 * Post-process an already-serialized JSON document into inert bytes.
 *
 * `JSON.stringify` escapes the C0 controls and stops there, which is how DEL, C1, the
 * bidi set and U+2028/9 reach a terminal through a `--json` sink. What is written back
 * is the JSON escape for the same code point, so the bytes still parse to the value they
 * came from: a consumer reads what the record holds, and only the terminal is denied the
 * ability to act on it. The escapes `stringify` already produced are left alone, and so
 * is the line break it uses for indentation, which is this build's own formatting.
 */
export function terminalSafeJsonText(encoded: string): string {
  return encode(encoded, (code) => code > 0x1f && within(code, FORGED_RANGES));
}

/** A `--json` sink's whole job in one call: serialize, then make the bytes inert. */
export function terminalSafeJson(document: unknown): string {
  return terminalSafeJsonText(JSON.stringify(document, null, 2) ?? 'null');
}
