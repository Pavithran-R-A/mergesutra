import { redactText } from '../security/redaction.js';

/**
 * The pull request title and body a human would be shown — Stage 10.
 *
 * This page leaves the machine, so it is written to two rules:
 *
 * - **It copies, it does not conclude.** Every status, exit code, file path and
 *   caveat below came from a document an earlier stage wrote. Nothing here judges
 *   them, and nothing here is allowed to summarise them into a stronger claim —
 *   which is why "all tests passed" appears nowhere in this file even for a run
 *   where every gate passed: the gates passing is the claim, and it is narrower.
 * - **It is public.** An issue title is text a stranger wrote, and a limitation is
 *   a sentence about a machine that is somebody's laptop. Every one of those values
 *   is masked, folded and then made unable to draw the page, by one of three routes
 *   below (`quote`, `prose`, `span`) chosen by where the value lands. A headline is
 *   folded because a PR title is not Markdown; prose is escaped because the page
 *   *is*; a name is held inside a code fence because a name has to stay byte-exact
 *   for the reviewer who has to open it. The same holds for the two rows that look
 *   like data rather than prose — a file name and a gate's command line — because a
 *   name comes out of a working tree this build did not author, and a command line
 *   is the one place in a run record where a person types a token.
 *
 * What this does *not* do is censor vocabulary. A quoted sentence may say PASS, or
 * approved, or that it fixes something; the words are the record's. What it cannot do
 * is become a heading, a link, an image, a tag, the end of somebody else's code span,
 * or a GitHub closing reference — because those four are things the page *does*, and
 * this file is the only thing on this run that is allowed to do them.
 *
 * No model is asked for anything: a draft a human approves has to be reproducible
 * from the record alone, or the digest under it approves bytes nobody can regenerate.
 */

/** GitHub's own title ceiling; this one leaves room for the truncation marker. */
export const MAX_TITLE_LENGTH = 150;
/** Under GitHub's body ceiling, with room for a notice that the page was cut. */
export const MAX_BODY_LENGTH = 30_000;
/** How many rows any one list may print before the rest is counted instead. */
export const MAX_LISTED_ROWS = 40;

export interface DraftCriterion {
  readonly id: string;
  readonly statement: string;
  readonly status: string;
}

export interface DraftGate {
  readonly id: string;
  readonly argv: readonly string[];
  readonly result: string;
  readonly exitCode: number | null;
}

export interface DraftFile {
  readonly path: string;
  readonly change: string;
}

export interface DraftFinding {
  readonly id: string;
  readonly severity: string;
  readonly category: string;
  readonly disposition: string;
}

export interface DraftIssue {
  readonly canonical: string;
  readonly number: number;
  readonly url: string;
  readonly title: string | null;
  /** False when the issue lives somewhere other than the repository being targeted. */
  readonly sameRepository: boolean;
}

export interface DraftReview {
  readonly cycle: number;
  readonly modelId: string;
  readonly findings: readonly DraftFinding[];
}

export interface DraftInput {
  readonly runId: string;
  readonly target: { readonly fullName: string; readonly branch: string };
  readonly issue: DraftIssue | null;
  /**
   * Whether this run is the whole of what the issue asked for. A closing keyword
   * deletes a reviewer's workflow, so it is only ever written when a caller that
   * checked the criteria says so — and never for another repository's issue.
   */
  readonly closesIssue: boolean;
  readonly criteria: readonly DraftCriterion[];
  readonly gates: readonly DraftGate[];
  readonly verification: string | null;
  readonly patchIdentity: string | null;
  readonly baseSha: string;
  readonly files: readonly DraftFile[];
  readonly review: DraftReview | null;
  readonly limitations: readonly string[];
}

export interface PrDraft {
  readonly title: string;
  readonly body: string;
}

const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`,;()]*/g;
const POSIX_HOME =
  /(?:^|[\s"'`(])(\/(?:home|users?|tmp|temp|private|var|root|mnt|media|srv|opt|builds?|actions-runner|github|workspace|documents)[\\/][^\s"'`,)]*)/gi;

/**
 * The claims a draft may not make on a run's behalf, however the issue was worded.
 *
 * The first group is optimism a reporter may feel about their own bug. The last two
 * are words this program owns: a state name only a human's reading produces, and a
 * closing keyword only the evidence decides. Those two are the more dangerous,
 * because a title is the one line of a pull request everybody reads first, and text
 * inside it is not what makes it true.
 */
const OVERCLAIMS: readonly RegExp[] = [
  /\ball (?:the )?tests? (?:passed|pass)\b/i,
  /\bevery test\b/i,
  /\b(?:all|every) (?:issues?|bugs?|problems?) (?:are )?(?:solved|fixed|resolved)\b/i,
  /\bproduction ready\b|\bready for production\b/i,
  /\bai approved\b|\bapproved by (?:ai|bharatcode|the model)\b/i,
  /\bsecurity (?:guarantee|guaranteed|assured)\b|\bno vulnerabilities\b/i,
  /\b100% ?(?:tested|coverage|working)\b/i,
  /\b(?:clos(?:e|es|ed)|fix(?:e|es|ed)|resolv(?:e|es|ed))\b[ \t]*:?[ \t]*(?:[\w.-]+\/[\w.-]+)?#\d+/i,
  /\b(?:clos(?:e|es|ed)|fix(?:e|es|ed)|resolv(?:e|es|ed))\b[ \t]*:?[ \t]*\S*\/issues\/\d+/i,
  /\bhuman_approved_for_pr\b|\bcontribution_ready\b|\bapprove_all\b|\bpr[\s_]*created\b|["']?approved["']?\s*[:=]\s*true\b/i,
];

/**
 * The value routes: what every outside string gets before it can reach the page.
 *
 * Masking runs first on every route, so a credential is gone even where a later step
 * cuts the sentence around it. The fold is what defeats *block* structure: a heading,
 * list marker, quote or fenced block only takes effect at the start of a line, so once
 * every line break in a value is gone it cannot add a section to this document. What
 * the fold cannot touch is inline structure and what GitHub obeys in text, which is
 * why each route below then handles the characters its own position on the page is
 * exposed to.
 */
function flatten(text: string): string {
  const masked = redactText(text);
  const local = masked
    .replace(WINDOWS_PATH, '[local path removed]')
    .replace(POSIX_HOME, (match, path: string) => match.replace(path, '[local path removed]'));
  return local.replace(/\s+/g, ' ').trim();
}

/** Punctuation Markdown reads, and that therefore has to be escaped to mean itself. */
const MARKDOWN_CHARACTER = /[_\\`*<>~]/g;

/** A letter, a digit or another underscore: the neighbour that makes one part of a word. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** A bracket group GitHub turns into a link or an image: `[text](dest)` or `[text][ref]`. */
const LINK_SHAPE = /(?<bang>!?)\[(?<label>[^\]\n]*)\](?=[[(])/g;

/** How a value opens, when it opens a line: the block constructs the fold left alive. */
const LINE_START = /^[#>\-+~]/;

/**
 * One character at a time, except for the underscore a word already owns.
 *
 * A reader cannot open emphasis with an underscore that has a letter or digit before it,
 * nor close one with a letter or digit after it, so the underscores in
 * `NEEDS_HUMAN_REVIEW` were never structure: escaping them would rewrite a state word a
 * reviewer reads or greps for and buy nothing. An underscore at either edge of a word can
 * delimit emphasis, and `*` can do it even inside a word, so those stay escaped.
 */
function escaped(chunk: string): string {
  return chunk.replace(MARKDOWN_CHARACTER, (character: string, at: number): string => {
    if (character === '_' && insideWord(chunk, at)) return character;
    return `\\${character}`;
  });
}

/** Whether this underscore can delimit emphasis: one with a word character each side cannot. */
function insideWord(text: string, at: number): boolean {
  return WORD_CHARACTER.test(text.charAt(at - 1)) && WORD_CHARACTER.test(text.charAt(at + 1));
}

/**
 * A value printed in the page's prose, where Markdown is live.
 *
 * Escaping is per-character except for the link shape: a lone `[` is already text, so
 * only a bracket group that would actually become a link is touched. That is also what
 * keeps this program's own `[REDACTED]` and `[local path removed]` markers readable —
 * they are markers, not destinations.
 */
function inertMarkdown(text: string): string {
  let out = '';
  let at = 0;
  for (const match of text.matchAll(LINK_SHAPE)) {
    const start = match.index ?? 0;
    out += escaped(text.slice(at, start));
    out += `${match.groups?.bang ? '\\!\\[' : '\\['}${escaped(match.groups?.label ?? '')}\\]`;
    at = start + match[0].length;
  }
  return `${out}${escaped(text.slice(at))}`;
}

/**
 * A closing verb, the colon GitHub tolerates after it, and the reference it obeys.
 *
 * GitHub closes an issue when it reads `Closes #12`, `Fixes: owner/repo#12` or a
 * keyword beside a full issue URL. It does not close one on the word alone, so this is
 * anchored to the verb rather than to the vocabulary: `the fix closes nothing` is
 * quoted as it stands, and `closes #999` is quoted with a visible space inside the
 * reference, which reads the same to a person and is not a reference to GitHub.
 */
const CLOSING_REFERENCE =
  /\b(?<verb>clos(?:e|es|ed)|fix(?:e|es|ed)|resolv(?:e|es|ed))\b(?<separator>[ \t]*:?[ \t]*)(?<reference>#\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+)/gi;

function inertReferences(text: string): string {
  return text.replace(
    CLOSING_REFERENCE,
    (_whole: string, verb: string, separator: string, reference: string) => {
      const scheme = /^https?:\/\//.exec(reference);
      const broken = scheme
        ? `${reference.slice(0, scheme[0].length)} ${reference.slice(scheme[0].length)}`
        : reference.replace('#', '# ');
      return `${verb}${separator}${broken}`;
    },
  );
}

/**
 * Text from outside this program, folded for a headline.
 *
 * A pull request title is never rendered as Markdown, so escaping it would only put
 * backslashes in front of a human; the fold is the whole of what a title needs. The
 * leading `#` is escaped because a title is the one field GitHub shows in places that
 * do parse it.
 */
function quote(text: string): string {
  const folded = flatten(text);
  return folded.startsWith('#') ? `\\${folded}` : folded;
}

/** A value printed in prose, where a character could change what the page says. */
function prose(text: string): string {
  const inert = inertMarkdown(inertReferences(flatten(text)));
  return LINE_START.test(inert) ? `\\${inert}` : inert;
}

/**
 * A value that has to stay byte-exact, held inside a code span of its own.
 *
 * A code span closes at the first run of backticks as long as the one that opened it,
 * so a file name carrying a backtick used to end its own span and go on drawing the
 * page. Choosing a fence one backtick longer than the longest run inside the value
 * makes that impossible, and nothing inside a span is Markdown any more — which is
 * also why the value is not escaped here, since an escape character inside a span
 * would read as one more character of the name.
 */
function span(text: string): string {
  const value = flatten(text);
  const longest = [...value.matchAll(/`+/g)].reduce(
    (run, match) => Math.max(run, (match[0] ?? '').length),
    0,
  );
  const fence = '`'.repeat(longest + 1);
  const padded =
    value === '' || value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value;
  return `${fence}${padded}${fence}`;
}

/** An issue URL exactly as this program's own intake writes one, and nothing looser. */
const ECHOED_ISSUE_URL =
  /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/\d+$/;

/**
 * The one value that stands alone on a line.
 *
 * A URL is the page's only link, and a reviewer clicks it, so a well-formed one is
 * echoed unchanged rather than escaped. Anything else has to be held where it cannot
 * start a block, open a link or carry a keyword into GitHub's issue tracker.
 */
function pageUrl(value: string): string {
  return ECHOED_ISSUE_URL.test(value) ? value : span(value);
}

/** A sentence an overclaim check can name, or `null` when the text may be quoted. */
function overclaim(text: string): string | null {
  for (const pattern of OVERCLAIMS) {
    const found = text.match(pattern);
    if (found) return found[0];
  }
  return null;
}

export function draftOf(input: DraftInput): PrDraft {
  return { title: titleOf(input), body: cap(bodyOf(input)) };
}

/**
 * The issue title, then the first criterion, then a name that claims nothing.
 *
 * The issue title is the most accurate description of the work that exists, so it
 * is used first — but only if it survives the overclaim screen. A reporter who
 * titled their issue "all tests passed" does not thereby make that MergeSutra's
 * claim, and re-wording it into something softer would be a draft nobody could
 * reproduce, so the title falls back to a form that asserts only that this is a
 * draft about that issue.
 */
function titleOf(input: DraftInput): string {
  if (input.issue) {
    const title = quote(input.issue.title ?? '');
    if (title.length > 0 && overclaim(title) === null) return fit(title);
    return fit(`MergeSutra draft for ${quote(input.issue.canonical)}`);
  }
  const statement = quote(input.criteria[0]?.statement ?? '');
  if (statement.length > 0 && overclaim(statement) === null) return fit(statement);
  return fit(`MergeSutra draft for ${quote(input.runId)}`);
}

function bodyOf(input: DraftInput): string {
  const lines: string[] = [];
  lines.push(...summary(input));
  lines.push(...issueSection(input));
  lines.push(...contractSection(input));
  lines.push(...implementationSection(input));
  lines.push(...verificationSection(input));
  lines.push(...reviewSection(input));
  lines.push(...evidenceSection(input));
  lines.push(...limitationSection(input));
  return `${lines.join('\n').trimEnd()}\n`;
}

function summary(input: DraftInput): string[] {
  const ran = input.gates.filter((gate) => gate.exitCode !== null).length;
  const lines: string[] = ['## Summary', ''];
  lines.push(
    `MergeSutra drafted this change from a run record. Every status below was written by the stage that measured it; this page adds no verdict of its own, and a human still has to read it.`,
    '',
  );
  lines.push(`- Repository: ${prose(input.target.fullName)} → ${span(input.target.branch)}`);
  lines.push(`- Run: ${prose(input.runId)}`);
  lines.push(`- Files: ${count(input.files.length, 'file')} changed since the base commit`);
  lines.push(
    `- Verification: ${prose(input.verification ?? 'no verification result recorded')} — ${count(
      ran,
      'gate',
    )} ran, ${count(input.gates.length - ran, 'gate')} did not`,
  );
  lines.push(
    `- Review: ${
      input.review
        ? `cycle ${input.review.cycle}, ${count(input.review.findings.length, 'finding')} filed`
        : 'none recorded for these bytes'
    }`,
  );
  lines.push('');
  return lines;
}

/**
 * The issue, and what this pull request would do to it.
 *
 * `Fixes` is withheld unless the caller said this run is the whole task *and* the
 * issue is in the repository being targeted — a cross-repository `Fixes #123`
 * closes some other project's issue by number, which is a stranger's bug tracker
 * being edited by an accident here.
 */
function issueSection(input: DraftInput): string[] {
  const lines: string[] = ['## Issue', ''];
  const issue = input.issue;
  if (!issue) {
    lines.push('This run recorded no source issue, so nothing here links or closes one.');
    lines.push('');
    return lines;
  }
  const canClose = input.closesIssue && issue.sameRepository;
  lines.push(
    canClose
      ? `Fixes #${issue.number} — this run is recorded as the whole of what that issue asked for.`
      : `Related to ${issue.sameRepository ? `#${issue.number}` : prose(issue.canonical)}.`,
  );
  if (!canClose) {
    lines.push('');
    lines.push(
      `This draft does not claim to close it: ${
        !issue.sameRepository
          ? 'the issue is in another repository, so a closing keyword would move somebody else’s tracker'
          : 'the run does not record every criterion on that issue as met on these bytes'
      }.`,
    );
  }
  lines.push('');
  lines.push(pageUrl(issue.url));
  lines.push('');
  return lines;
}

function contractSection(input: DraftInput): string[] {
  const lines: string[] = ['## Acceptance Contract', ''];
  if (input.criteria.length === 0) {
    lines.push('This run derived no acceptance criteria.');
    lines.push('');
    return lines;
  }
  lines.push('Statuses are the ones the run record holds, copied without change:');
  lines.push('');
  for (const criterion of listed(input.criteria)) {
    lines.push(
      `- ${span(criterion.id)} — ${prose(criterion.status)} — ${prose(criterion.statement)}`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * What changed, from the bytes on disk.
 *
 * Not from the model's account of what it wrote: Stage 7 measured the workspace,
 * and a summary of the patch that disagreed with the patch would be the most
 * expensive kind of typo in a document a reviewer reads first.
 */
function implementationSection(input: DraftInput): string[] {
  const lines: string[] = ['## Implementation', ''];
  if (input.files.length === 0) {
    lines.push(
      `The measured patch holds no files, so this run changed nothing relative to ${span(input.baseSha.slice(0, 12))}.`,
    );
    lines.push('');
    return lines;
  }
  lines.push(
    `${count(input.files.length, 'file')} differ from the base commit ${span(input.baseSha.slice(0, 12))}, as Git reported them:`,
  );
  lines.push('');
  for (const file of listed(input.files)) {
    lines.push(`- ${span(file.path)} — ${prose(file.change.toLowerCase())}`);
  }
  const omitted = input.files.length - MAX_LISTED_ROWS;
  if (omitted > 0) {
    lines.push(`- … and ${omitted} more files; the full list is in the evidence pack`);
  }
  lines.push('');
  lines.push(
    'Line counts are not restated here, because the diff on this page is the authority for them.',
  );
  lines.push('');
  return lines;
}

/**
 * One row per gate, including the rows nobody likes.
 *
 * A gate that never ran says so rather than reading as a failure or a pass, and a
 * `REFUSED` row stays visible: the point of this section is that a reviewer can see
 * the whole set of commands without scrolling a terminal.
 */
function verificationSection(input: DraftInput): string[] {
  const lines: string[] = ['## Verification', ''];
  if (input.gates.length === 0) {
    lines.push('No gate has run for this change, so this section reports no measured result.');
    lines.push('');
    return lines;
  }
  lines.push('Each row is one command the run started, with the exit code it returned:');
  lines.push('');
  for (const gate of listed(input.gates)) {
    lines.push(
      `- ${span(gate.id)} — ${prose(gate.result)} — ${span(gate.argv.join(' '))} — ${
        gate.exitCode === null ? 'did not run' : `exit ${gate.exitCode}`
      }`,
    );
  }
  lines.push('');
  lines.push(
    `The run recorded these receipts against patch ${span(
      input.patchIdentity?.slice(0, 12) ?? 'not measured',
    )}. That is the whole of what passed: no row here says anything about a test that did not appear above.`,
  );
  lines.push('');
  return lines;
}

/**
 * The review, described rather than quoted at length.
 *
 * §5's exact sentence for a review that filed nothing is used verbatim, because a
 * paraphrase of "no additional findings" is how a page starts saying "approved".
 */
function reviewSection(input: DraftInput): string[] {
  const lines: string[] = ['## Independent Review', ''];
  const review = input.review;
  if (!review) {
    lines.push(
      'No independent review has been recorded for these bytes, so there is nothing to report here.',
    );
    lines.push('');
    return lines;
  }
  if (review.findings.length === 0) {
    lines.push(
      `Independent BharatCode review completed; no additional findings were recorded. Review cycle ${review.cycle}, by ${span(review.modelId)}.`,
    );
    lines.push('');
    return lines;
  }
  lines.push(
    `Review cycle ${review.cycle}, by ${span(review.modelId)}. ${count(review.findings.length, 'finding')} filed, each with the disposition MergeSutra gave it:`,
  );
  lines.push('');
  for (const finding of listed(review.findings)) {
    lines.push(
      `- ${span(finding.id)} — ${prose(finding.severity)} — ${prose(finding.category)} — ${prose(finding.disposition)}`,
    );
  }
  lines.push('');
  lines.push(
    'A disposition says where MergeSutra routed a finding, not whether the reviewer was right; the unresolved rows above are the ones a human has to answer.',
  );
  lines.push('');
  return lines;
}

function evidenceSection(input: DraftInput): string[] {
  const lines: string[] = ['## Evidence', ''];
  lines.push(
    input.patchIdentity
      ? `- Patch these receipts describe: ${span(input.patchIdentity.slice(0, 12))} — full identity ${span(input.patchIdentity)}`
      : '- No patch identity was recorded, so no receipt here is pinned to measured bytes',
  );
  lines.push(
    `- Base commit: ${span(input.baseSha)} · target branch ${span(input.target.branch)} in ${prose(input.target.fullName)}`,
  );
  lines.push(
    `- The evidence pack (\`report.md\`, \`report.json\`, \`commands.jsonl\`) is in ${span(`.mergesutra/runs/${input.runId}/`)}, which is Git-ignored: it is kept local and is not committed, so it is not published with this pull request. Ask the author for it, or run MergeSutra on this checkout yourself.`,
  );
  lines.push('');
  lines.push(runMetadata(input));
  lines.push('');
  return lines;
}

/**
 * The note of which run wrote this page, in the one piece of raw markup on it.
 *
 * An HTML comment ends at the first `-->` it meets, so a `>` arriving from a field this
 * build did not author is written as the JSON escape for it rather than as the
 * character. Every value the stages write carries no `>` at all, so such a page is
 * byte-for-byte the page an approval was taken over.
 */
function runMetadata(input: DraftInput): string {
  const frozen = JSON.stringify({
    schemaVersion: 1,
    runId: input.runId,
    baseSha: input.baseSha,
    patchIdentity: input.patchIdentity,
    targetBranch: input.target.branch,
  }).replaceAll('>', '\\u003e');
  return `<!-- mergesutra:publication-metadata ${frozen} -->`;
}

/**
 * The caveats, in the words that recorded them.
 *
 * Suppressing these is the specific way a draft like this could do harm: a page
 * that looks clean reads as a change that is clean, and the one sentence saying
 * "a human never consented to run the gate" is the sentence a reviewer needs.
 */
function limitationSection(input: DraftInput): string[] {
  const lines: string[] = ['## Limitations / Manual review', ''];
  const kept = input.limitations.map(prose).filter((line) => line.length > 0);
  if (kept.length === 0) {
    lines.push(
      'This run recorded no limitations, which is a fact about its record rather than a guarantee about the change.',
    );
    lines.push('');
    return lines;
  }
  for (const line of kept.slice(0, MAX_LISTED_ROWS)) lines.push(`- ${line}`);
  const omitted = kept.length - MAX_LISTED_ROWS;
  if (omitted > 0)
    lines.push(`- … and ${omitted} more caveats, listed in full in the evidence pack`);
  lines.push('');
  return lines;
}

function listed<T>(items: readonly T[]): readonly T[] {
  return items.slice(0, MAX_LISTED_ROWS);
}

function count(total: number, noun: string): string {
  return `${total} ${total === 1 ? noun : `${noun}s`}`;
}

/** A name that cannot be regenerated is a name nobody should approve. */
function fit(title: string): string {
  return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function cap(body: string): string {
  if (body.length <= MAX_BODY_LENGTH) return body;
  const notice = '\n\n> This page was cut at its size limit; the evidence pack holds the rest.\n';
  return `${body.slice(0, MAX_BODY_LENGTH - notice.length)}${notice}`;
}
