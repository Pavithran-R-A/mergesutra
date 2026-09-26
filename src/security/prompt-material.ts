/**
 * Keeping quoted text from passing itself for structure.
 *
 * A prompt is a page with headings, and the material it quotes is full of
 * headings: diffs, markdown documents, CI logs and issue bodies all use `===`
 * rules of their own. Left alone, a line a stranger wrote can open a section
 * that MergeSutra never authored, and the reviewer can no longer tell where the
 * instructions end and the evidence starts.
 *
 * So the lines that would be read as structure are marked as quotation instead.
 * Nothing is removed and no word changes: the bytes stay in the page, visible to
 * the reviewer and to anyone reading the record afterwards, with a marker in
 * front of them that says whose text they are.
 */

/** A line whose whole content is a rule-style heading, e.g. `=== ACCEPTANCE CONTRACT ===`. */
const SECTION_SHAPED = /^\s*={3,}.*={3,}\s*$/;

/** What sits in front of a quoted line that would otherwise read as a section. */
export const QUOTATION_MARKER = '> [data] ';

export interface MarkedText {
  readonly text: string;
  /** How many lines of `text` were marked; 0 means it came back untouched. */
  readonly markedLines: number;
}

export function markQuoted(text: string): MarkedText {
  if (!text.includes('===')) return { text, markedLines: 0 };
  let markedLines = 0;
  const lines = text.split('\n').map((line) => {
    if (!SECTION_SHAPED.test(line)) return line;
    markedLines += 1;
    return `${QUOTATION_MARKER}${line}`;
  });
  return { text: lines.join('\n'), markedLines };
}

/** Every line the marker sits on, so a page can be checked against its own claims. */
export function countMarkedLines(text: string): number {
  return text.split('\n').filter((line) => line.startsWith(QUOTATION_MARKER)).length;
}
