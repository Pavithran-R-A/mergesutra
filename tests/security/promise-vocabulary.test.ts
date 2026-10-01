import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S12-25 — the promise surfaces may not claim a state this build refuses to emit.
 *
 * Two places tell a stranger what MergeSutra produces: the opening block of `README.md`, and
 * `BharatCode.txt`, which the package `files` allowlist ships. Those two blocks are the product's
 * own words about its output, so they are held to the standard the output holds itself to. That
 * standard is not invented here — it is the vocabulary the code already refuses. `src/pr/draft.ts`
 * strips a title or body that says `contribution_ready` or `production ready`; `src/cli/status.ts`
 * prints `Contribution ready  never — no field in this build can set it`; `docs/SECURITY_MODEL.md`
 * §2.5 says the `pr` screen prints the facts instead of `Approved for merge` or `production ready`.
 * A promise that uses a word the program refuses is not modesty lost, it is an advertisement for a
 * state the record cannot carry, and the person who installs this tool reads the promise first.
 *
 * So the property is vocabulary, never sentence: no wording is snapshotted, and any honest
 * rephrasing keeps these cases green. What turns one red is putting a refused state word into a
 * promise, moving the promise out from under the locator, or deleting the refusal inside the
 * product that the comparison depends on. The rest of the README is not scanned — it is the
 * manual, and it earns its adjectives from a test or a captured screen nearby.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const README = path.join(ROOT, 'README.md');
const NOTE = path.join(ROOT, 'BharatCode.txt');
const DRAFT = path.join(ROOT, 'src', 'pr', 'draft.ts');

/** The promise is two paragraphs, not the manual: this is what the locator is expected to find. */
const PROMISE_MAX_CHARS = 800;

interface RefusedClaim {
  readonly pattern: RegExp;
  readonly sample: string;
  readonly refusedBy: string;
}

/**
 * Every entry names a state the product itself declines to assert somewhere. `sample` is the
 * planted control: a claim this list must be able to catch in a promise.
 */
const REFUSED_READINESS_CLAIMS: readonly RefusedClaim[] = [
  {
    pattern: /\bcontribution[-_ ]ready\b/i,
    sample: 'a contribution-ready patch',
    refusedBy: 'draft.ts OVERCLAIMS and the status screen',
  },
  {
    pattern: /\b(?:production|customer)[- ]ready\b/i,
    sample: 'production ready software',
    refusedBy: 'draft.ts OVERCLAIMS and SECURITY_MODEL.md §2.5',
  },
  {
    pattern: /\bhuman_approved_for_pr\b/i,
    sample: 'human_approved_for_pr today',
    refusedBy: 'draft.ts OVERCLAIMS',
  },
  {
    pattern: /\bapproved for merge\b/i,
    sample: 'approved for merge already',
    refusedBy: 'SECURITY_MODEL.md §2.5',
  },
  {
    pattern: /\ball (?:the )?tests? (?:passed|pass)\b|\bevery test (?:passes|passed)\b/i,
    sample: 'all tests passed',
    refusedBy: 'draft.ts OVERCLAIMS',
  },
  {
    pattern: /\b100% ?(?:tested|coverage|working)\b/i,
    sample: '100% coverage',
    refusedBy: 'draft.ts OVERCLAIMS',
  },
  {
    pattern: /\bai approved\b|\bapproved by (?:ai|bharatcode|the model)\b/i,
    sample: 'approved by the model',
    refusedBy: 'draft.ts OVERCLAIMS',
  },
  {
    pattern: /\bsecurity (?:guarantee|guaranteed|assured)\b|\bno vulnerabilities\b/i,
    sample: 'a security guarantee',
    refusedBy: 'draft.ts OVERCLAIMS',
  },
];

/** A line that opens a note entry: a word, a colon, then its value. Mirrors S12-20's reader. */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9]*): (.*)$/;

/** The README's promise: everything from the first heading to the first rule, nothing after it. */
function promiseBlock(): string {
  const lines = readFileSync(README, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^#{1,3} /.test(line));
  expect(
    start,
    'README.md must open with a heading, or this guard is scanning nothing',
  ).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^---\s*$/.test(line));
  expect(
    end,
    'the promise region ends at a horizontal rule; without one this locator is scanning the wrong text',
  ).toBeGreaterThan(start);
  const block = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  expect(
    block.length,
    `the promise region grew to ${String(block.length)} characters, past the ${String(
      PROMISE_MAX_CHARS,
    )} it is scanned as`,
  ).toBeLessThanOrEqual(PROMISE_MAX_CHARS);
  expect(
    /MergeSutra/.test(block),
    'the scanned region must still be the paragraph that describes the product',
  ).toBe(true);
  return block;
}

/** The note's own words about what it builds: `Tagline` and `Purpose`, with wraps folded back. */
function notePromise(): string {
  const entries = new Map<string, string>();
  let open: string | undefined;
  for (const line of readFileSync(NOTE, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const matched = KEY_LINE.exec(line);
    if (matched !== null) {
      const key = matched[1] ?? '';
      open = key;
      entries.set(key, matched[2] ?? '');
      continue;
    }
    if (open !== undefined) entries.set(open, `${entries.get(open) ?? ''} ${line}`);
  }
  const tagline = entries.get('Tagline');
  const purpose = entries.get('Purpose');
  expect(tagline, 'the shipped note lost its Tagline, so there is no promise to hold').toBeTruthy();
  expect(purpose, 'the shipped note lost its Purpose, so there is no promise to hold').toBeTruthy();
  return `${tagline} ${purpose}`;
}

function offenders(text: string): string[] {
  return REFUSED_READINESS_CLAIMS.filter((claim) => claim.pattern.test(text)).map(
    (claim) => `${claim.pattern} (${claim.refusedBy})`,
  );
}

describe('the promise surfaces claim no state the build refuses (S12-25)', () => {
  it('scans a real README promise region, not an empty match', () => {
    const block = promiseBlock();
    expect(block.length).toBeGreaterThan(80);
  });

  it('holds the README promise to the refused vocabulary', () => {
    const found = offenders(promiseBlock());
    expect(
      found,
      'the README opens by asserting a readiness state this build refuses to emit',
    ).toEqual([]);
  });

  it('holds the shipped note to the refused vocabulary', () => {
    const found = offenders(notePromise());
    expect(
      found,
      'the note this package ships asserts a readiness state this build refuses to emit',
    ).toEqual([]);
  });

  it('catches every refused claim planted in a promise', () => {
    for (const claim of REFUSED_READINESS_CLAIMS) {
      const caught = offenders(claim.sample);
      expect(
        caught.some((entry) => entry.includes(String(claim.pattern))),
        `${claim.sample} must be caught: ${claim.refusedBy}`,
      ).toBe(true);
    }
  });

  it('relies on a refusal the product still performs in a draft', () => {
    const source = readFileSync(DRAFT, 'utf8');
    const block = /const OVERCLAIMS: readonly RegExp\[\] = \[([\s\S]*?)\n\];/.exec(source)?.[1];
    expect(block, 'draft.ts no longer declares an OVERCLAIMS block').toBeTruthy();
    for (const needle of ['contribution_ready', 'production ready', 'approved by']) {
      expect(
        block?.includes(needle),
        `draft.ts stopped refusing ${needle}, so the promise had no standard to be held to`,
      ).toBe(true);
    }
  });

  it('does not treat an honest restatement as a claim', () => {
    const honest =
      'MergeSutra turns a GitHub issue into an evidence-backed pull-request draft and maps ' +
      'every acceptance criterion to the evidence for it, including what no gate could check.';
    expect(offenders(honest)).toEqual([]);
  });
});
