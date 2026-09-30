import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectInert } from '../helpers/terminal.js';

/**
 * S12-20 — the one shipped file that speaks about a competition, and what it may say.
 *
 * `BharatCode.txt` sits at the repository root and is named in the package `files` allowlist, so
 * its bytes reach anyone who installs this tool. S12-12 measured that shipping; nothing here
 * re-measures it. What no test looked at was the sentence itself. A present-tense status can
 * assert a completed act — that this project was submitted, selected, or placed — and a checkout
 * with no remote, no publish path and no submission mechanism cannot support one. It cannot
 * support the opposite either: what happened outside this repository is not evidence here, which
 * is why the guard is vocabulary rather than a flattering replacement, and why no negative status
 * ("not submitted", "pending") is written down anywhere.
 *
 * So the property is narrow: the note stays a small, terminal-inert, flat `Key: value` document
 * with exactly one locatable `Status`, and no entry claims a result a judge would have to have
 * handed out. No sentence is snapshotted — an equally honest rewording keeps every case green,
 * while deleting the status, duplicating it, or moving the claim into another field turns one red.
 * The scan covers every entry value, not only `Status`, because a claim unsupported in one field
 * is not made supportable by renaming it into another. Credential shapes are S12-24's scan and are
 * not looked for here.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const NOTE = path.join(ROOT, 'BharatCode.txt');

/** One small, explicit ceiling: a note about a project, not a document of record. */
const SIZE_BOUND = 512;

/** Words that report a result rather than an intent to take part. */
const OUTCOME_CLAIMS: readonly RegExp[] = [
  /\bsubmissions?\b/i,
  /\bsubmitted\b/i,
  /\bfinalists?\b/i,
  /\bshortlist(?:ed)?\b/i,
  /\bwinners?\b/i,
  /\bwe won\b/i,
  /\bselected (?:for|as|into)\b/i,
  /\bplaced (?:first|second|third)\b/i,
];

/** A line that opens an entry: a word, a colon, then its value. */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9]*): (.*)$/;

interface Entry {
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

/** The note as shipped, with the entries folded back from any wrapped value. */
function readNote(): { readonly text: string; readonly bytes: Buffer; readonly entries: Entry[] } {
  const bytes = readFileSync(NOTE);
  const text = bytes.toString('utf8');
  const entries: Entry[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.length === 0) return;
    const matched = KEY_LINE.exec(line);
    if (matched !== null) {
      entries.push({ key: matched[1] ?? '', value: matched[2] ?? '', line: index + 1 });
      return;
    }
    const open = entries[entries.length - 1];
    if (open === undefined) {
      entries.push({ key: `<unkeyed line ${index + 1}>`, value: line, line: index + 1 });
      return;
    }
    entries[entries.length - 1] = { ...open, value: `${open.value} ${line}` };
  });
  return { text, bytes, entries };
}

describe('the shipped project note claims no competition result (S12-20)', () => {
  it('is an ordinary file at the repository root', () => {
    expect(statSync(NOTE).isFile(), 'the note must be a file, not a link or a directory').toBe(
      true,
    );
  });

  it('stays inside its explicit size bound', () => {
    const { bytes } = readNote();
    expect(
      bytes.byteLength,
      `the note grew past ${SIZE_BOUND} bytes, so it is no longer a note`,
    ).toBeLessThanOrEqual(SIZE_BOUND);
  });

  it('carries no byte a terminal or a line reader obeys invisibly', () => {
    const { text, bytes } = readNote();
    expect(bytes[0] === 0xef, 'a byte-order mark would be a byte no reader asked for').toBe(false);
    expectInert(text, 'the project note this package ships');
  });

  it('opens every entry with a flat key and leaves nothing unkeyed', () => {
    const { text, entries } = readNote();
    const first = text.split('\n').find((line) => line.length > 0) ?? '';
    expect(KEY_LINE.test(first), 'the note must open with a Key: value line').toBe(true);
    const unkeyed = entries.filter((entry) => entry.key.startsWith('<unkeyed'));
    expect(
      unkeyed.map((entry) => entry.line),
      'a value with no key is not a note field',
    ).toEqual([]);
    const empty = entries.filter((entry) => entry.value.trim().length === 0);
    expect(
      empty.map((entry) => entry.key),
      'an entry that carries nothing claims nothing',
    ).toEqual([]);
  });

  it('holds exactly one Status entry', () => {
    const status = readNote().entries.filter((entry) => entry.key === 'Status');
    expect(
      status.map((entry) => entry.value),
      'the note must carry one, and only one, Status field',
    ).toHaveLength(1);
  });

  it('asserts no completed competition outcome in any entry', () => {
    const offenders = readNote().entries.flatMap((entry) => {
      const matched = OUTCOME_CLAIMS.find((pattern) => pattern.test(entry.value));
      return matched === undefined
        ? []
        : [`${entry.key} matches ${String(matched)}: ${entry.value.trim()}`];
    });
    expect(
      offenders,
      'a result word in a shipped note states something this repository does not evidence',
    ).toEqual([]);
  });
});
