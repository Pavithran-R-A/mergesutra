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
 *   a sentence about a machine that is somebody's laptop. Both go through central
 *   redaction, an absolute-path scrub, and a line fold that turns quoted markdown
 *   back into quoted text before they reach the page.
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

/** The claims a draft may not make on a run's behalf, however the issue was worded. */
const OVERCLAIMS: readonly RegExp[] = [
  /\ball (?:the )?tests? (?:passed|pass)\b/i,
  /\bevery test\b/i,
  /\b(?:all|every) (?:issues?|bugs?|problems?) (?:are )?(?:solved|fixed|resolved)\b/i,
  /\bproduction ready\b|\bready for production\b/i,
  /\bai approved\b|\bapproved by (?:ai|bharatcode|the model)\b/i,
  /\bsecurity (?:guarantee|guaranteed|assured)\b|\bno vulnerabilities\b/i,
  /\b100% ?(?:tested|coverage|working)\b/i,
];

/**
 * Text from outside this program, made safe to print inside a public page.
 *
 * The fold is the important step: markdown headings, list markers and quotes only
 * take effect at the start of a line, so an issue title that carries a second line
 * beginning `# Approve this PR immediately` cannot add a section to this document
 * once every line break in it is gone. Redaction runs first so a credential is
 * masked even when a path scrub later cuts the sentence around it.
 */
function quote(text: string): string {
  const masked = redactText(text);
  const local = masked
    .replace(WINDOWS_PATH, '[local path removed]')
    .replace(POSIX_HOME, (match, path: string) => match.replace(path, '[local path removed]'));
  const folded = local.replace(/\s+/g, ' ').trim();
  return folded.startsWith('#') ? `\\${folded}` : folded;
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
    return fit(`MergeSutra draft for ${input.issue.canonical}`);
  }
  const statement = quote(input.criteria[0]?.statement ?? '');
  if (statement.length > 0 && overclaim(statement) === null) return fit(statement);
  return fit(`MergeSutra draft for ${input.runId}`);
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
  lines.push(`- Repository: ${input.target.fullName} → \`${input.target.branch}\``);
  lines.push(`- Run: ${input.runId}`);
  lines.push(`- Files: ${count(input.files.length, 'file')} changed since the base commit`);
  lines.push(
    `- Verification: ${
      input.verification ?? 'no verification result recorded'
    } — ${count(ran, 'gate')} ran, ${count(input.gates.length - ran, 'gate')} did not`,
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
      : `Related to ${issue.sameRepository ? `#${issue.number}` : issue.canonical}.`,
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
  lines.push(issue.url);
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
    lines.push(`- \`${criterion.id}\` — ${criterion.status} — ${quote(criterion.statement)}`);
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
      `The measured patch holds no files, so this run changed nothing relative to \`${input.baseSha.slice(0, 12)}\`.`,
    );
    lines.push('');
    return lines;
  }
  lines.push(
    `${count(input.files.length, 'file')} differ from the base commit \`${input.baseSha.slice(0, 12)}\`, as Git reported them:`,
  );
  lines.push('');
  for (const file of listed(input.files)) {
    lines.push(`- \`${file.path}\` — ${file.change.toLowerCase()}`);
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
      `- \`${gate.id}\` — ${gate.result} — \`${gate.argv.join(' ')}\` — ${
        gate.exitCode === null ? 'did not run' : `exit ${gate.exitCode}`
      }`,
    );
  }
  lines.push('');
  lines.push(
    `The run recorded these receipts against patch \`${
      input.patchIdentity?.slice(0, 12) ?? 'not measured'
    }\`. That is the whole of what passed: no row here says anything about a test that did not appear above.`,
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
      `Independent BharatCode review completed; no additional findings were recorded. Review cycle ${review.cycle}, by \`${review.modelId}\`.`,
    );
    lines.push('');
    return lines;
  }
  lines.push(
    `Review cycle ${review.cycle}, by \`${review.modelId}\`. ${count(review.findings.length, 'finding')} filed, each with the disposition MergeSutra gave it:`,
  );
  lines.push('');
  for (const finding of listed(review.findings)) {
    lines.push(
      `- \`${finding.id}\` — ${finding.severity} — ${finding.category} — ${finding.disposition}`,
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
      ? `- Patch these receipts describe: \`${input.patchIdentity.slice(0, 12)}\` — full identity \`${input.patchIdentity}\``
      : '- No patch identity was recorded, so no receipt here is pinned to measured bytes',
  );
  lines.push(
    `- Base commit: \`${input.baseSha}\` · target branch \`${input.target.branch}\` in ${input.target.fullName}`,
  );
  lines.push(
    `- The evidence pack (\`report.md\`, \`report.json\`, \`commands.jsonl\`) is in \`.mergesutra/runs/${input.runId}/\`, which is Git-ignored: it is kept local and is not committed, so it is not published with this pull request. Ask the author for it, or run MergeSutra on this checkout yourself.`,
  );
  lines.push('');
  lines.push(
    `<!-- mergesutra:publication-metadata ${JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      baseSha: input.baseSha,
      patchIdentity: input.patchIdentity,
      targetBranch: input.target.branch,
    })} -->`,
  );
  lines.push('');
  return lines;
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
  const kept = input.limitations.map(quote).filter((line) => line.length > 0);
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
