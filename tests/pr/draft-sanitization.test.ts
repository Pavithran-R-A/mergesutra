import { describe, expect, it } from 'vitest';
import { draftOf, type DraftInput, type PrDraft } from '../../src/pr/draft.js';
import { candidateOf } from '../../src/pr/candidate.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import { candidateInput } from '../helpers/publication.js';

/**
 * S12-21 — outside text is data, never the page's own structure.
 *
 * Stage 10 writes eight headings, one bullet per row and one code span per name.
 * Everything else on the page came from somewhere that does not owe this program
 * the truth: an issue, a working tree, a model, a caveat about a laptop, and — for
 * the fields a person can only reach by editing a persisted record by hand — the
 * record itself.
 *
 * The property under test is not "the text was censored" and not "the text was
 * scanned for suspicious words". It is narrower and checkable: a character that
 * would change what Markdown *renders*, or what GitHub *acts on*, may only arrive
 * here from this program. So each test asks what the renderer produced and answers
 * it by reading the result, not by matching the input: `markdownOf()` re-closes the
 * emitted code spans the way CommonMark does, `visible()` reads the page the way a
 * reviewer does once the escapes are applied, and the link and keyword patterns name
 * the two syntaxes GitHub obeys.
 *
 * The last group is the other half of the claim. A page that escaped its way to
 * safety by losing the reviewer's information would be a worse bug than the one being
 * fixed: the bytes a stage measured still have to read correctly, the one closing
 * reference this program earned still has to be active, and the digest still has to
 * be a digest of whatever the page ended up saying.
 */

const PATCH_IDENTITY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BASE_SHA = '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182';
const ISSUE_URL = 'https://github.com/projectbharat/datekit/issues/123';

const SECTION_TITLES = [
  'Summary',
  'Issue',
  'Acceptance Contract',
  'Implementation',
  'Verification',
  'Independent Review',
  'Evidence',
  'Limitations / Manual review',
];

/**
 * A bracket group GitHub turns into a link or an image: `[text](dest)` or
 * `[text][ref]`. A backslash before the opening bracket makes it text, which is what
 * quoted data has to come out as.
 */
const ACTIVE_LINK = /(?<!\\)\[[^\]\n]*\](?=[[(])/g;

/**
 * What GitHub obeys on merge: a closing verb, the colon or space it tolerates
 * between, and one issue reference. `# 12` is not a reference; `#12` closes
 * somebody's issue.
 */
const ACTIVE_CLOSING =
  /\b(?:clos(?:e|es|ed)|fix(?:e|es|ed)|resolv(?:e|es|ed))\b[ \t]*:?[ \t]*(?:[\w.-]+\/[\w.-]+)?#\d+/gi;

/**
 * … and the same obedience to a keyword sitting next to a full issue URL. A scheme
 * with a host behind it is what GitHub turns into a link, and a link is what the
 * keyword then points at: `https:// github.com/…` is neither.
 */
const ACTIVE_CLOSING_URL =
  /\b(?:clos(?:e|es|ed)|fix(?:e|es|ed)|resolv(?:e|es|ed))\b[ \t]*:?[ \t]*https?:\/\/[^/\s]/gi;

/** Inline HTML or an autolink, escaping allowed for. */
const ACTIVE_TAG = /(?<!\\)<[a-zA-Z/]/g;

function draftInput(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    runId: 'run-20260925T000000Z-pack001',
    target: { fullName: 'projectbharat/datekit', branch: 'main' },
    issue: {
      canonical: 'projectbharat/datekit#123',
      number: 123,
      url: ISSUE_URL,
      title: 'Parser accepts invalid empty dates',
      sameRepository: true,
    },
    closesIssue: false,
    criteria: [
      { id: 'AC-1', statement: 'Empty input is rejected.', status: 'PASS' },
      { id: 'AC-2', statement: 'The error names the field.', status: 'PENDING' },
    ],
    gates: [
      { id: 'VG-001', argv: ['npm', 'test'], result: 'PASS', exitCode: 0 },
      { id: 'VG-002', argv: ['npm', 'run', 'typecheck'], result: 'BLOCKED', exitCode: null },
    ],
    verification: 'PASS',
    patchIdentity: PATCH_IDENTITY,
    baseSha: BASE_SHA,
    files: [
      { path: 'src/parser.ts', change: 'MODIFIED' },
      { path: 'tests/parser.test.ts', change: 'ADDED' },
    ],
    review: { cycle: 1, modelId: 'bharatcode-reviewer', findings: [] },
    limitations: ['A gate was offered and nobody consented to it.'],
    ...overrides,
  };
}

function headingsOf(body: string): string[] {
  return [...body.matchAll(/^#{1,6} +(.*)$/gm)].map((match) => match[1] ?? '');
}

/** The authored HTML comment is the page's one piece of raw markup; set it aside. */
function withoutAuthoredComment(body: string): string {
  return body.replace(/^<!-- mergesutra:publication-metadata .* -->$/m, '');
}

function linesHolding(body: string, needle: string): string[] {
  return body.split('\n').filter((line) => line.includes(needle));
}

function sectionOf(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const rest = body.slice(start + `## ${heading}`.length);
  const next = rest.search(/^#{1,6} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Undo the backslashes Markdown reads as escapes: the text a reviewer actually sees. */
function visible(markdown: string): string {
  return markdown.replace(/\\([\\`*_<>~![\]])/g, '$1');
}

/**
 * Read one emitted line the way CommonMark does: the inline code spans, and the text
 * outside them. A span closes only at a run of backticks exactly as long as the one
 * that opened it, so this is what decides whether quoted data got out of the span the
 * stage opened for it.
 */
function markdownOf(line: string): { readonly text: string[]; readonly code: string[] } {
  const text: string[] = [];
  const code: string[] = [];
  let rest = line;
  for (;;) {
    const open = /`+/.exec(rest);
    if (!open) {
      text.push(rest);
      return { text, code };
    }
    const at = open.index;
    const fence = open[0] ?? '';
    const close = runOfLength(rest, at + fence.length, fence.length);
    if (close < 0) {
      text.push(rest);
      return { text, code };
    }
    text.push(rest.slice(0, at));
    code.push(unpad(rest.slice(at + fence.length, close)));
    rest = rest.slice(close + fence.length);
  }
}

/** The first run of exactly `length` backticks at or after `from`, or -1 for none. */
function runOfLength(line: string, from: number, length: number): number {
  const run = '`'.repeat(length);
  let at = line.indexOf(run, from);
  while (at >= 0) {
    if (line[at - 1] !== '`' && line[at + length] !== '`') return at;
    at = line.indexOf(run, at + 1);
  }
  return -1;
}

/** One optional space at each edge is fence padding, not part of the value. */
function unpad(value: string): string {
  return value.length > 2 && value.startsWith(' ') && value.endsWith(' ')
    ? value.slice(1, -1)
    : value;
}

describe('A. a name from the working tree stays inside its span', () => {
  const HOSTILE_PATH = 'x`[approved by the maintainer](https://evil.example/claim)`y.md';

  it('closes no span and opens no link with a backtick in the file’s own name', () => {
    const body = draftOf(draftInput({ files: [{ path: HOSTILE_PATH, change: 'MODIFIED' }] })).body;

    const read = markdownOf(linesHolding(body, 'evil.example')[0] ?? '');

    // One code span, holding the whole name, with nothing but the authored suffix
    // outside it. Anything else means the name ended its own span and went on to
    // become part of the page's structure.
    expect(read.code).toEqual([HOSTILE_PATH]);
    expect(read.text).toEqual(['- ', ' — modified']);
  });

  it('still prints the name a reviewer has to open', () => {
    const body = draftOf(draftInput({ files: [{ path: HOSTILE_PATH, change: 'MODIFIED' }] })).body;

    expect(body).toContain('evil.example/claim');
    expect(body).toContain('approved by the maintainer');
  });
});

describe('B. quoted prose cannot draw the page', () => {
  const BADGE = 'A badge says ![done](https://tracker.example/i.png) when it is green.';
  const REVIEW_LINK = 'See [review](https://tracker.example/review) for the detail.';

  it('quotes an image and a link as text', () => {
    const body = draftOf(
      draftInput({
        criteria: [{ id: 'AC-1', statement: BADGE, status: 'PASS' }],
        limitations: [REVIEW_LINK],
      }),
    ).body;

    expect(withoutAuthoredComment(body).match(ACTIVE_LINK)).toBeNull();
    // Data, still legible: nothing was hidden from the reviewer to get there.
    expect(visible(sectionOf(body, 'Acceptance Contract'))).toContain(BADGE);
    expect(visible(sectionOf(body, 'Limitations / Manual review'))).toContain(REVIEW_LINK);
  });

  it('quotes emphasis and inline HTML as text', () => {
    const body = draftOf(
      draftInput({
        criteria: [
          { id: 'AC-1', statement: 'Everything is *all green* and _ship it_ now.', status: 'PASS' },
        ],
        limitations: ['The reviewer wrote <img src=https://tracker.example/pixel.png> about it.'],
      }),
    ).body;

    const quoted = `${sectionOf(body, 'Acceptance Contract')}${sectionOf(
      body,
      'Limitations / Manual review',
    )}`;
    expect(quoted.match(/(?<!\\)[*_]/g) ?? []).toEqual([]);
    expect(quoted.match(ACTIVE_TAG) ?? []).toEqual([]);
    expect(visible(quoted)).toContain('*all green*');
  });
});

describe('C. quoted prose cannot close an issue', () => {
  it('leaves no closing keyword active in a criterion or a caveat', () => {
    const body = draftOf(
      draftInput({
        criteria: [
          {
            id: 'AC-1',
            statement: 'The parser fix closes #999 once it is merged.',
            status: 'PASS',
          },
        ],
        limitations: [
          'Somebody wrote FIXES: #999 in the thread.',
          'Upstream resolves owner/repo#999.',
        ],
      }),
    ).body;

    expect(body.match(ACTIVE_CLOSING)).toBeNull();
    expect(withoutAuthoredComment(body).match(ACTIVE_CLOSING_URL)).toBeNull();
    // Neutralised, not deleted: the word and the number both stay on the page.
    expect(body).toContain('999');
    expect(visible(sectionOf(body, 'Limitations / Manual review'))).toContain('FIXES: #');
  });

  it('leaves no closing keyword active beside a quoted issue URL', () => {
    const body = draftOf(
      draftInput({
        limitations: ['The maintainer said Closes https://github.com/other/thing/issues/7 here.'],
      }),
    ).body;

    expect(body.match(ACTIVE_CLOSING_URL)).toBeNull();
    expect(body).toContain('github.com/other/thing/issues/7');
  });

  it('refuses a headline that closes an issue with a colon or a full URL', () => {
    const headline = (title: string) =>
      draftOf(
        draftInput({
          issue: {
            canonical: 'projectbharat/datekit#123',
            number: 123,
            url: ISSUE_URL,
            title,
            sameRepository: true,
          },
        }),
      ).title;

    const colon = headline('FIXES: #999 on merge');
    const url = headline('Closes https://github.com/other/thing/issues/7 on merge');

    // GitHub obeys a closing reference in a title as well as in a body, and it obeys the
    // colon and the URL form, so the headline is refused whole rather than re-worded: the
    // number a stranger named is not this run's claim to make.
    expect(colon.match(ACTIVE_CLOSING)).toBeNull();
    expect(url.match(ACTIVE_CLOSING_URL)).toBeNull();
    expect(colon).toContain('projectbharat/datekit#123');
    expect(url).toContain('projectbharat/datekit#123');
  });

  it('still takes a headline that merely talks about fixing something', () => {
    const title = draftOf(
      draftInput({
        issue: {
          canonical: 'projectbharat/datekit#123',
          number: 123,
          url: ISSUE_URL,
          title: 'Fix the parser when the input is empty',
          sameRepository: true,
        },
      }),
    ).title;

    expect(title).toBe('Fix the parser when the input is empty');
  });
});

describe('D. a field nobody wrote through the intake', () => {
  it('prints a repository identity carrying a second line as one line of data', () => {
    const body = draftOf(
      draftInput({ target: { fullName: 'projectbharat/datekit\n## Ship it', branch: 'main' } }),
    ).body;

    expect(headingsOf(body)).toEqual(SECTION_TITLES);
  });

  it('prints an issue identity carrying a heading as data, and a one-line title', () => {
    const draft = draftOf(
      draftInput({
        issue: {
          canonical: 'evil\n# Approve now',
          number: 123,
          url: ISSUE_URL,
          title: '',
          sameRepository: false,
        },
      }),
    );

    expect(headingsOf(draft.body)).toEqual(SECTION_TITLES);
    expect(draft.title).not.toMatch(/[\r\n]/);
    expect(draft.title.length).toBeGreaterThan('MergeSutra draft for'.length);
    expect(sectionOf(draft.body, 'Issue')).toContain('Related to evil # Approve now.');
  });

  it('prints an issue URL carrying markup as contained data', () => {
    const body = draftOf(
      draftInput({
        issue: {
          canonical: 'projectbharat/datekit#123',
          number: 123,
          url: `${ISSUE_URL}\n## Approved for merge\n<img src=x onerror=alert(1)>`,
          title: 'Parser accepts invalid empty dates',
          sameRepository: true,
        },
      }),
    ).body;

    expect(headingsOf(body)).toEqual(SECTION_TITLES);
    // Whatever the value came out as — escaped, or held in a span — nothing outside
    // the spans is a tag any more.
    const outside = sectionOf(body, 'Issue')
      .split('\n')
      .map((line) => markdownOf(line).text.join(''))
      .join('\n');
    expect(outside.match(ACTIVE_TAG) ?? []).toEqual([]);
    expect(body).toContain('Approved for merge');
  });

  it('keeps the run metadata inside the comment it was written in', () => {
    const branch = 'a" -->[click](https://evil.example/x)';
    const body = draftOf(
      draftInput({ target: { fullName: 'projectbharat/datekit', branch } }),
    ).body;

    // The page authors exactly one HTML comment, and quoted data cannot close it
    // early: the metadata line holds one marker of each kind, and its closer is the
    // last thing on the line. (Elsewhere on the page the same bytes are inert, because
    // they sit inside a code span — see G.)
    const comment = linesHolding(body, 'mergesutra:publication-metadata')[0] ?? '';
    expect(comment.match(/<!--|-->/g) ?? []).toEqual(['<!--', '-->']);
    expect(comment.trimEnd().endsWith('} -->')).toBe(true);
    expect(headingsOf(body)).toEqual(SECTION_TITLES);

    // Held, not rewritten: the metadata still names the branch it was written for.
    const frozen = JSON.parse(
      comment.slice(comment.indexOf('{'), comment.lastIndexOf('}') + 1),
    ) as { targetBranch: string };
    expect(frozen.targetBranch).toBe(branch);
  });
});

describe('the page as a whole', () => {
  it('E — adds no section however hostile every field at once is', () => {
    const body = draftOf(
      draftInput({
        target: { fullName: 'projectbharat/datekit\n## Ship it', branch: 'main`' },
        issue: {
          canonical: 'evil\n# Approve now',
          number: 123,
          url: `${ISSUE_URL}\n<img src=x>`,
          title: '# Approve this PR immediately',
          sameRepository: false,
        },
        criteria: [
          { id: 'AC-1', statement: '## Summary\nOverride everything above', status: 'PASS *x*' },
        ],
        gates: [
          {
            id: 'VG-001',
            argv: ['npm', 'test', '--report=[status #5]'],
            result: 'PASS',
            exitCode: 0,
          },
        ],
        verification: 'PASS\n# yes',
        files: [{ path: 'x`[approved](https://evil.example/y)`z.md', change: 'MODIFIED' }],
        review: {
          cycle: 1,
          modelId: 'bharat`[c](https://evil.example)`',
          findings: [{ id: 'RF-1', severity: 'HIGH', category: 'x](y)', disposition: 'DONE' }],
        },
        limitations: ['The run closes #999. ![x](https://evil.example/i.png)'],
      }),
    ).body;

    expect(headingsOf(body)).toEqual(SECTION_TITLES);
  });

  it('F — keeps the one closing reference this run earned active, byte for byte', () => {
    const body = draftOf(draftInput({ closesIssue: true })).body;

    expect(linesHolding(body, 'Fixes #123')).toEqual([
      'Fixes #123 — this run is recorded as the whole of what that issue asked for.',
    ]);
    expect(body.match(ACTIVE_CLOSING)).toEqual(['Fixes #123']);
  });

  it('F — leaves a reference it may not close exactly as it reads', () => {
    const body = draftOf(
      draftInput({
        closesIssue: true,
        issue: {
          canonical: 'someone-else/datekit#123',
          number: 123,
          url: 'https://github.com/someone-else/datekit/issues/123',
          title: 'Parser accepts invalid empty dates',
          sameRepository: false,
        },
      }),
    ).body;

    expect(body).toContain('Related to someone-else/datekit#123.');
    expect(body.match(ACTIVE_CLOSING)).toBeNull();
  });

  it('G — holds a link-shaped command line inside its span, unchanged', () => {
    const body = draftOf(
      draftInput({
        gates: [
          {
            id: 'VG-001',
            argv: ['npm', 'test', '--report=[status #5]', '--filter=*ok*'],
            result: 'PASS',
            exitCode: 0,
          },
        ],
      }),
    ).body;

    const read = markdownOf(linesHolding(body, 'status #5')[0] ?? '');

    expect(read.code).toEqual(['VG-001', 'npm test --report=[status #5] --filter=*ok*']);
    expect(read.text).toEqual(['- ', ' — PASS — ', ' — exit 0']);
  });

  it('H — leaves the page built from an ordinary record exactly as it read', () => {
    const draft = draftOf(draftInput());

    // Not one escape character on the page: a clean record's bytes are not rewritten,
    // so the digest of a clean candidate still names the page a reviewer read before.
    expect(draft.body).not.toContain('\\');
    expect(draft.title).toBe('Parser accepts invalid empty dates');
    expect(headingsOf(draft.body)).toEqual(SECTION_TITLES);
    expect([...draft.body.matchAll(/https?:\/\/\S+/g)].map((match) => match[0])).toEqual([
      ISSUE_URL,
    ]);
  });

  it('H — leaves ordinary prose, Unicode and punctuation readable', () => {
    const prose =
      'The reviewer wrote “ünïcode — C# and snake_case — see tests/parser.test.ts”. OK.';
    const body = draftOf(
      draftInput({ criteria: [{ id: 'AC-1', statement: prose, status: 'PENDING' }] }),
    ).body;

    expect(visible(sectionOf(body, 'Acceptance Contract'))).toContain(prose);
  });

  it('H — leaves an identifier’s own underscores exactly as its stage wrote them', () => {
    const body = draftOf(
      draftInput({ limitations: ['The gate filed NEEDS_HUMAN_REVIEW for the run.'] }),
    ).body;

    // A reader cannot open or close emphasis with an underscore that has a letter on
    // both sides, so escaping it would rewrite a state word a reviewer greps for and
    // buy no inertness in exchange.
    expect(sectionOf(body, 'Limitations / Manual review')).toContain('NEEDS_HUMAN_REVIEW');
  });

  it('H — still neutralises an underscore that can delimit emphasis', () => {
    const body = draftOf(draftInput({ limitations: ['Write _ship it_ now.'] })).body;

    expect(sectionOf(body, 'Limitations / Manual review')).toContain('\\_ship it\\_');
  });

  it('I — renders the same hostile record to the same bytes twice', () => {
    const hostile = () =>
      draftInput({
        target: { fullName: 'projectbharat/datekit\n## Ship it', branch: 'main' },
        criteria: [
          {
            id: 'AC-1',
            statement: 'It closes #999 ![x](https://evil.example/i.png)',
            status: 'PASS',
          },
        ],
        files: [{ path: 'x`[a](https://evil.example/y)`z.md', change: 'MODIFIED' }],
      });

    expect(draftOf(hostile())).toEqual(draftOf(hostile()));
  });

  it('J — moves the publication digest exactly when the frozen bytes move', () => {
    const frozen = (draft: PrDraft): string =>
      publicationDigestOf(
        candidateOf(candidateInput({ draft: { title: draft.title, body: draft.body } })),
      );

    const clean = frozen(draftOf(draftInput()));
    const hostile = draftInput({
      criteria: [
        {
          id: 'AC-1',
          statement: 'It closes #999 ![x](https://evil.example/i.png)',
          status: 'PASS',
        },
      ],
    });

    expect(frozen(draftOf(hostile))).not.toBe(clean);
    expect(frozen(draftOf(hostile))).toBe(frozen(draftOf(draftInput(hostile))));
    expect(frozen(draftOf(draftInput()))).toBe(clean);
  });
});
