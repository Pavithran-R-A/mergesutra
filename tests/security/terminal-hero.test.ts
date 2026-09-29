import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statusAction } from '../../src/cli/status.js';
import { resumeAction } from '../../src/cli/resume.js';
import { doctorAction } from '../../src/cli/doctor.js';
import { reportAction } from '../../src/cli/report.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { formatReview } from '../../src/cli/review.js';
import { formatPr } from '../../src/cli/pr.js';
import { formatVerification } from '../../src/cli/verify.js';
import { createRenderer } from '../../src/cli/render.js';
import { createFileRunStore } from '../../src/state/run-store.js';
import { createRunRecord } from '../../src/state/run-record.js';
import { LOCK_OWNER_FILE_NAME, runLockDirectory } from '../../src/lifecycle/lock.js';
import { sha256Hex } from '../../src/security/digest.js';
import { terminalSafeJson } from '../../src/security/terminal-safety.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { buildReviewDocument, parseReviewBody } from '../../src/review/schema.js';
import type { ReviewAttempt } from '../../src/review/engine.js';
import type { ReviewStageResult } from '../../src/review/stage.js';
import type { ReviewContext } from '../../src/review/context.js';
import { candidateOf, parsePublicationCandidate } from '../../src/pr/candidate.js';
import { draftOf } from '../../src/pr/draft.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import { decidePublication, parsePublicationApproval } from '../../src/pr/approval.js';
import { readinessOf } from '../../src/pr/readiness.js';
import { buildPublicationRecord } from '../../src/pr/record.js';
import type { PrStageResult } from '../../src/pr/stage.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { RunResult } from '../../src/core/runner.js';
import { verifiedRecord } from '../helpers/report.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import {
  BEL,
  CR,
  CSI8,
  ESC,
  LF,
  OSC8,
  PDF,
  RLO,
  ST8,
  TAB,
  activeControl,
  counterfeitedRows,
  inertSpellingDecodes,
  onlyRendererOwnColour,
  capture,
  shown,
} from '../helpers/terminal.js';

/**
 * S12-11 §26 — the hostile terminal hero: one run, five hostile sources, every screen.
 *
 * The control-matrix file proves the primitive sink by sink. This file proves the
 * *build*: that a single run carrying attacker-controlled text at each door it really
 * comes in by produces pages on which none of that text can operate on the terminal —
 * while every word it says stays readable, so a person can still disbelieve it.
 * Everything here is bytes captured from the write function a command was given. No
 * screenshots, no rendered terminal, nothing a human has to eyeball to believe.
 *
 * The five sources are the five §26 names, planted at the entry this build uses for
 * each — because a payload injected straight into a display function would only prove
 * that function co-operates:
 *
 * - **issue title** (`ESC[2J` and a fake `PR CREATED`), fed to the real `draftOf`,
 *   which then decides what the page's title says;
 * - **review finding** (`CR` overwriting its own row with `HUMAN APPROVAL RECORDED`),
 *   pushed through `parseReviewBody` — the schema door Stage 9 puts a model's answer
 *   through — and filed by `buildReviewDocument`;
 * - **filename** (`LF` and a fake `VERIFICATION PASS`), which this build meets at three
 *   separate doors, and the three GUARD tests below measure all of them rather than
 *   crediting the last one alone;
 * - **lock hostname** (`OSC` window-title change), written to the owner file by a
 *   process that is not this one and read by `statusAction` and `resumeAction`;
 * - **limitation** (`RLO`/`PDF` around a fake `CONTRIBUTION_READY`, plus an 8-bit
 *   `CSI`), a caveat a stage recorded that every later screen prints.
 *
 * A gate's own stdout and stderr are the sixth carrier, handed to the real
 * verification engine, which builds the real receipt (§12).
 *
 * Each page is then measured twice: from the hostile run, and from an otherwise
 * identical benign one. That comparison is how this file states §9's requirement
 * without hand-waving. **A screen prints the same set of left-margin verdict rows
 * whether or not the payload is present.** A payload that gained a row would change
 * that set, and the first version of the report page did exactly that — which is the
 * finding this hero exists to catch.
 *
 * What is deliberately NOT claimed: that the payload's words are removed. They are
 * not, and a page that hid `HUMAN APPROVAL RECORDED` would shield a reader from a
 * claim they need in order to reject it. And no digest moved: the candidate a human
 * would approve is byte-identical after its page has been shown (§17), and the receipt
 * still digests the bytes the child really wrote (§12).
 */

const RUN_ID = 'run-20260926T000000Z-hero001';
const BASE_SHA = '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182';
/** A path a review finding may legitimately name: no control in it, so the schema admits it. */
const FINDING_FILE = 'src/date.ts';

/** The five sources §26 names, plus the gate's first output line. */
interface Hostile {
  readonly issueTitle: string;
  readonly finding: string;
  readonly summary: string;
  readonly filename: string;
  readonly lockHost: string;
  readonly limitation: string;
  readonly childFirstLine: string;
}

const HOSTILE: Hostile = {
  issueTitle: `${ESC}[2JPR CREATED`,
  finding: `the parser still returns a date${CR}HUMAN APPROVAL RECORDED`,
  summary: `two findings, both about the parser${BEL}${OSC8}0;EIGHT-BIT WINDOW TITLE${ST8}`,
  filename: `src/date${LF}VERIFICATION PASS.ts`,
  lockHost: `worker-7${ESC}]0;MergeSutra approved${BEL}`,
  limitation: `${RLO}CONTRIBUTION_READY${PDF} and an 8-bit clear-screen: ${CSI8}2J`,
  childFirstLine: `${ESC}[2JPR CREATED — suite green${BEL}`,
};

/** The same run with nothing hostile in it, for the page-for-page comparison. */
const BENIGN: Hostile = {
  issueTitle: 'Parser accepts invalid empty dates',
  finding: 'the parser still returns a date for an impossible day',
  summary: 'two findings, both about the parser',
  filename: 'src/date.ts',
  lockHost: 'worker-7',
  limitation: 'No gate in this run executed the README example.',
  childFirstLine: '1 test passed — suite green',
};

/**
 * The verdicts the payload counterfeits, named by §26. The test asks only that a
 * screen's set of left-margin rows built from these words is unchanged by the payload,
 * which is what lets the pr page keep its own `HUMAN APPROVAL RECORDED` heading — a row
 * the screen earned from a recorded approval — while refusing the payload's copy of the
 * same letters.
 */
const FORGED = ['PR CREATED', 'HUMAN APPROVAL RECORDED', 'VERIFICATION PASS', 'CONTRIBUTION_READY'];

/** Every spelling the payload carries, so a page set can be checked for losing one. */
const PAYLOAD_SPELLINGS = [0x1b, 0x07, 0x0d, 0x0a, 0x9b, 0x9d, 0x9c, 0x202e, 0x202c] as const;

const tempDirs: string[] = [];

/** One row per page: which sink it came from, and the bytes that sink was handed. */
interface Page {
  readonly sink: string;
  readonly text: string;
}

/** A page's counterfeit rows: unindented, and opening with one of the forged verdicts. */
function counterfeitRows(text: string): string[] {
  return text
    .split(LF)
    .filter((line) => !line.startsWith(' ') && FORGED.some((word) => line.startsWith(word)));
}

function childOf(hostile: Hostile): RunResult {
  return {
    code: 0,
    stdout: `${hostile.childFirstLine}${LF}1 test passed${LF}`,
    stderr: `${ESC}]0;MergeSutra: approved${BEL} on stderr${LF}${RLO}CONTRIBUTION_READY${PDF}${LF}`,
    timedOut: false,
    truncated: false,
  };
}

/**
 * The whole run, built from one `Hostile` set through the real stage functions.
 *
 * Nothing here hand-writes a status or a digest: the verification round comes from the
 * real engine over a scripted process, the review from the real schema door and document
 * builder, the candidate from the real `draftOf` -> `candidateOf` -> `publicationDigestOf`
 * chain, and the evidence pack from the real renderer.
 */
async function buildRun(hostile: Hostile, cwd: string) {
  const runsRoot = path.join(cwd, '.mergesutra', 'runs');
  await mkdir(runsRoot, { recursive: true });
  const store = createFileRunStore(runsRoot);

  const verified = await verifiedRecord(['npm', 'test'], {
    runId: RUN_ID,
    output: childOf(hostile),
  });
  const plan = verified.verificationPlan;
  if (!plan || !verified.verification || !verified.evidence) {
    throw new Error('the scripted verification filed no plan, run or evidence');
  }

  const body = parseReviewBody({
    summary: hostile.summary,
    findings: [
      {
        severity: 'HIGH',
        category: 'SECURITY',
        statement: hostile.finding,
        impact: 'an impossible day is returned as a date',
        evidence: `${FINDING_FILE}:14`,
        file: FINDING_FILE,
        criterionIds: ['AC-1'],
        contextRefs: ['CTX-001'],
        proposedAction: 'Reject impossible days in the validator.',
      },
    ],
  });
  const review = buildReviewDocument({
    runId: RUN_ID,
    baseSha: BASE_SHA,
    reviewedPatchIdentity: plan.patchIdentity,
    currentPatchIdentity: plan.patchIdentity,
    modelId: 'bharatcode-review-1',
    reviewedAt: '2026-09-26T00:00:00.000Z',
    attempts: 1,
    body,
    dispositions: [{ index: 0, disposition: 'NEEDS_HUMAN_REVIEW', reason: hostile.finding }],
  });

  // A hostile path reaches the screens the way a stage that could not read it leaves it
  // behind: as a recorded caveat. `draftOf`'s file list is the other door.
  const limitations = [hostile.limitation, `a file this run could not read: ${hostile.filename}`];
  const staged = createRunRecord({
    ...verified,
    runId: RUN_ID,
    review,
    limitations,
    nextStage: `REVIEW — ${hostile.finding}`,
  });
  const pack = buildEvidencePack(staged);

  const draft = draftOf({
    runId: RUN_ID,
    target: { fullName: 'projectbharat/datekit', branch: 'main' },
    issue: {
      canonical: 'projectbharat/datekit#123',
      number: 123,
      url: 'https://github.com/projectbharat/datekit/issues/123',
      title: hostile.issueTitle,
      sameRepository: true,
    },
    closesIssue: false,
    criteria: verified.evidence.criteria.map((entry) => ({
      id: entry.criterionId,
      statement: entry.statement,
      status: entry.status,
    })),
    gates: verified.verification.gates.map((outcome) => ({
      id: outcome.receipt.gateId,
      argv: outcome.receipt.argv,
      result: outcome.receipt.result,
      exitCode: outcome.receipt.exitCode,
    })),
    verification: 'PASS: 1 gate recorded, 1 ran',
    patchIdentity: plan.patchIdentity,
    baseSha: BASE_SHA,
    files: [{ path: hostile.filename, change: 'MODIFIED' }],
    review: {
      cycle: 1,
      modelId: review.modelId,
      findings: review.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        category: finding.category,
        disposition: finding.disposition,
      })),
    },
    limitations,
  });
  const candidate = candidateOf({
    runId: RUN_ID,
    createdAt: '2026-09-26T00:00:00.000Z',
    issue: { canonical: 'projectbharat/datekit#123', number: 123, closes: false },
    target: { fullName: 'projectbharat/datekit', branch: 'main' },
    proposedBranch: `mergesutra/${RUN_ID}`,
    baseSha: BASE_SHA,
    patchIdentity: plan.patchIdentity,
    draft,
    evidencePackIdentity: pack.identity,
    verificationSummary: 'PASS: 1 gate recorded, 1 ran, over plan revision 1',
    review: { cycle: 1, reviewedPatchIdentity: plan.patchIdentity, summary: hostile.summary },
    limitations,
  });
  const approval = parsePublicationApproval({
    schemaVersion: 1,
    runId: RUN_ID,
    publicationDigest: publicationDigestOf(candidate),
    approvedAt: '2026-09-26T01:00:00.000Z',
    action: 'CREATE_PULL_REQUEST',
  });
  const record = createRunRecord({
    ...staged,
    stage: 'pr',
    outcome: 'PR_APPROVED_LOCAL',
    publications: [buildPublicationRecord({ candidate, approval })],
  });
  await store.save(record);

  // A lock file is a directory entry any process on this machine may create, and its
  // `host` is the holder's self-reported name — read by status, and by a refusal.
  const lockDir = runLockDirectory(runsRoot, RUN_ID);
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, LOCK_OWNER_FILE_NAME),
    JSON.stringify({
      runId: RUN_ID,
      operation: 'resume',
      pid: 4_321,
      host: hostile.lockHost,
      createdAt: '2026-09-26T02:00:00.000Z',
      token: 'ef'.repeat(16),
    }),
    'utf8',
  );

  return { record, verified, review, candidate, pack, store, runsRoot, body };
}

type Run = Awaited<ReturnType<typeof buildRun>>;

/** The review screen's input, assembled from the documents this run filed. */
function reviewStageResult(run: Run): ReviewStageResult {
  const attempt: ReviewAttempt = {
    status: 'REVIEWED',
    // The reviewer's own answer, kept as the engine keeps it.
    body: run.body,
    reviewedPatchIdentity: run.review.reviewedPatchIdentity,
    currentPatchIdentity: run.review.currentPatchIdentity,
    patchPrecondition: run.review.patchPrecondition.status,
    attempts: run.review.attempts,
    model: run.review.modelId,
    detail: 'the reviewer answered, and the patch had not moved',
    limitations: [],
    promptTokens: null,
    completionTokens: null,
  };
  return {
    record: run.record,
    // The context is prompt material this screen does not read at all; the hero measures
    // bytes that reach a terminal, so no context is assembled for it.
    context: null as unknown as ReviewContext,
    attempt,
    review: run.review,
    repairPlan: null,
    workspace: '/repo/.mergesutra/worktrees/hero',
    recordFile: null,
    saveError: null,
  };
}

/**
 * The pr screen's input. `runPrStage` measures a real Git workspace, which this offline
 * build has none of, so the rows are assembled here from the real Stage 10 documents the
 * run filed: readiness from `readinessOf`, the decision from `decidePublication`, the
 * digest from `publicationDigestOf`. Only the row mapping is hand-built, and the payload
 * under test is the candidate rather than the layout.
 */
function prStageResult(run: Run): PrStageResult {
  const stored = parsePublicationCandidate(run.record.publications[0]?.candidate);
  const digest = publicationDigestOf(stored);
  const decision = decidePublication({
    candidate: stored,
    approval: run.record.publications[0]?.approval ?? null,
  });
  const plan = run.verified.verificationPlan;
  const readiness = readinessOf({
    patchIdentity: plan?.patchIdentity ?? null,
    verification: plan
      ? { patchIdentity: plan.patchIdentity, current: true, result: 'PASS' }
      : null,
    review: {
      current: true,
      findings: run.review.findings.map((finding) => ({
        severity: finding.severity,
        disposition: finding.disposition,
      })),
    },
    repairOutcomes: [],
    evidencePack: { identity: run.pack.identity, patchIdentity: plan?.patchIdentity ?? null },
    approval: decision.status,
  });
  return {
    runId: RUN_ID,
    outcome: 'PR_APPROVED_LOCAL',
    readiness,
    candidate: stored,
    digest,
    decision,
    published: false,
    record: run.record,
    recordFile: null,
    checks: [
      ...readiness.checks.map((check) => ({
        name: `Readiness · ${check.id}`,
        status: check.passed ? ('INFO' as const) : ('WARN' as const),
        detail: check.detail,
      })),
      { name: 'Publication proposal', status: 'INFO' as const, detail: stored.prTitle },
      {
        name: 'Publication approval',
        status: decision.allowed ? ('INFO' as const) : ('WARN' as const),
        detail: decision.reason,
      },
    ],
  };
}

/** The verify screen's input, from the engine's own documents on the record. */
function verifyStageResult(run: Run) {
  const record = run.verified;
  if (!record.verificationPlan || !record.verification || !record.evidence) {
    throw new Error('the scripted verification filed no plan, run or evidence');
  }
  return {
    record,
    plan: record.verificationPlan,
    run: record.verification,
    evidence: record.evidence,
    consent: record.executionConsent,
    workspace: '/repo/.mergesutra/worktrees/hero',
    recordFile: null,
    saveError: null,
  };
}

/**
 * Every sink this build has, rendered from one run in one sitting.
 *
 * `NO_COLOR` for the shared set, so the invariants are about the payload rather than
 * about anybody's palette; §19/§20 measure colour separately.
 */
async function pagesOf(run: Run, cwd: string): Promise<{ pages: Page[]; executed: number }> {
  const env = { NO_COLOR: '1' };
  const lock = { pid: 9_000, host: 'this-machine', isProcessAlive: () => true };
  const plain = createRenderer({ color: false });
  const pages: Page[] = [];

  const status = capture();
  expect(
    await statusAction(
      RUN_ID,
      { env },
      { store: run.store, cwd, runsRoot: run.runsRoot, now: () => NOW, lock },
      status.write,
    ),
  ).toBe(0);
  pages.push({ sink: 'status', text: status.text() });

  const statusJson = capture();
  await statusAction(
    RUN_ID,
    { env, json: true },
    { store: run.store, cwd, runsRoot: run.runsRoot, now: () => NOW, lock },
    statusJson.write,
  );
  pages.push({ sink: 'status --json', text: statusJson.text() });

  // No `--execute`: §15 asks for the preview and the refusal, and neither may take an
  // action. The dispatcher is armed so that one being called would be visible.
  let executed = 0;
  const resume = capture();
  await resumeAction(
    RUN_ID,
    { env },
    {
      resume: {
        store: run.store,
        cwd,
        runsRoot: run.runsRoot,
        now: () => NOW,
        pid: 9_000,
        host: 'this-machine',
        isProcessAlive: () => true,
        executeStage: async () => {
          executed += 1;
          return run.record;
        },
      },
    },
    resume.write,
  );
  pages.push({ sink: 'resume', text: resume.text() });

  pages.push({ sink: 'review', text: formatReview(reviewStageResult(run), plain) });
  pages.push({ sink: 'pr', text: formatPr(prStageResult(run), plain) });
  pages.push({ sink: 'verify', text: formatVerification(verifyStageResult(run), plain) });

  const doctor = capture();
  await doctorAction(
    { noColor: true, connect: true },
    {
      env: { BHARATCODE_API_KEY: 'sk-hero-TERMINALFIXTURE-000' },
      nodeVersion: '24.18.0',
      run: async () => childOf(HOSTILE),
      makeClient: () =>
        ({
          healthCheck: async () => ({ reachable: false, configured: true, note: HOSTILE.finding }),
        }) as unknown as BharatCodeClient,
    },
    doctor.write,
  );
  pages.push({ sink: 'doctor', text: doctor.text() });

  const report = capture();
  // Not 0: `report` returns the recorded outcome's code, and this run's outcome is
  // Stage 10's `PR_APPROVED_LOCAL`, which has no success code by design. The page is
  // still the page, which is what the tests over these bytes read.
  expect(await reportAction(RUN_ID, { env }, { store: run.store, cwd }, report.write)).toBe(
    EXIT.INCONCLUSIVE,
  );
  pages.push({ sink: 'report', text: report.text() });

  const reportJson = capture();
  await reportAction(RUN_ID, { env, json: true }, { store: run.store, cwd }, reportJson.write);
  pages.push({ sink: 'report --json', text: reportJson.text() });

  return { pages, executed };
}

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('the hostile terminal hero: five sources, one run, every screen', () => {
  it('leaves no payload byte able to act on any page', async () => {
    const cwd = await scratchDir('mergesutra-terminal-hero-');
    const { pages } = await pagesOf(await buildRun(HOSTILE, cwd), cwd);

    expect(pages.map((page) => page.sink)).toEqual([
      'status',
      'status --json',
      'resume',
      'review',
      'pr',
      'verify',
      'doctor',
      'report',
      'report --json',
    ]);
    for (const page of pages) {
      // A `--json` sink owns its own indentation, so LF and TAB are its structure; a
      // human page may end its rows with LF. Nothing else may still be active.
      const allowed = page.sink.endsWith('--json') ? `${LF}${TAB}` : LF;
      const offender = activeControl(page.text, allowed);
      expect(offender, `${page.sink} still carries ${offender ?? 'nothing'}`).toBeNull();
      // And with NO_COLOR set not even the renderer's own escape appears, so the line
      // above is a claim about the payload and not about styling.
      expect(page.text, `${page.sink} carries a raw ESC`).not.toContain(ESC);
    }
  });

  it('prints exactly the left-margin rows it would print with nothing hostile present', async () => {
    const hostileDir = await scratchDir('mergesutra-terminal-hero-');
    const benignDir = await scratchDir('mergesutra-terminal-benign-');
    const hostile = (await pagesOf(await buildRun(HOSTILE, hostileDir), hostileDir)).pages;
    const benign = (await pagesOf(await buildRun(BENIGN, benignDir), benignDir)).pages;

    expect(hostile.map((page) => page.sink)).toEqual(benign.map((page) => page.sink));
    for (const [index, page] of hostile.entries()) {
      expect(
        counterfeitRows(page.text),
        `${page.sink} gained left-margin rows the payload wrote: ${JSON.stringify(
          counterfeitRows(page.text),
        )}`,
      ).toEqual(counterfeitRows(benign[index]?.text ?? ''));
    }
  });

  it('keeps every word the payload says, as data a reader can still disbelieve', async () => {
    const cwd = await scratchDir('mergesutra-terminal-hero-');
    const { pages } = await pagesOf(await buildRun(HOSTILE, cwd), cwd);
    const every = pages.map((page) => page.text).join('');

    // Not one spelling was dropped anywhere in the run: each control the payload carries
    // is on a page as the six ASCII characters that name it.
    for (const code of PAYLOAD_SPELLINGS) {
      expect(every, `the pages lost the payload's U+${code.toString(16)}`).toContain(shown(code));
    }
    const decoded = inertSpellingDecodes(every);
    for (const word of [
      'PR CREATED',
      'HUMAN APPROVAL RECORDED',
      'CONTRIBUTION_READY',
      'VERIFICATION PASS',
      'EIGHT-BIT WINDOW TITLE',
    ]) {
      expect(decoded, `the pages deleted the claim: ${word}`).toContain(word);
    }

    // The review screen is where a person reads the reviewer's sentence, so it keeps that
    // sentence whole — inside its own row, with the overwrite visible rather than acting.
    const review = pages.find((page) => page.sink === 'review')?.text ?? '';
    expect(review).toContain(
      `the parser still returns a date${shown(0x0d)}HUMAN APPROVAL RECORDED`,
    );
  });

  it('GUARD: asks nothing to be executed while describing an action', async () => {
    const cwd = await scratchDir('mergesutra-terminal-hero-');
    const { executed } = await pagesOf(await buildRun(HOSTILE, cwd), cwd);

    expect(executed).toBe(0);
  });

  describe('the three doors a hostile filename meets', () => {
    it('is refused at the review schema door, before display is ever decided', () => {
      expect(() =>
        parseReviewBody({
          summary: 'a finding about a file',
          findings: [
            {
              severity: 'HIGH',
              category: 'SECURITY',
              statement: 'impossible days are accepted',
              impact: 'a wrong date is returned',
              evidence: `${FINDING_FILE}:14`,
              file: HOSTILE.filename,
              criterionIds: ['AC-1'],
              contextRefs: [],
              proposedAction: 'reject impossible days',
            },
          ],
        }),
      ).toThrow();
    });

    it('is refused by the lock-state reading, which prints no name it cannot trust', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const { pages } = await pagesOf(await buildRun(HOSTILE, cwd), cwd);

      // A second defence, upstream of terminal safety and of a different kind: the
      // holder's self-reported host is refused outright, and the refusal is shown as one
      // rather than hidden as an empty string.
      expect(pages[0]?.text).toContain('a name this build will not print');
    });

    it('shows as ONE filename on the pages that print a recorded one', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const { pages } = await pagesOf(await buildRun(HOSTILE, cwd), cwd);

      for (const sink of ['review', 'pr']) {
        const page = pages.find((each) => each.sink === sink)?.text ?? '';
        // The name never becomes a row of its own, and where the run recorded it the
        // break inside it stays visible inside that one row.
        expect(
          page.split(LF).filter((line) => line.startsWith('VERIFICATION PASS')),
          `${sink} let a filename start a row`,
        ).toEqual([]);
        const rows = page
          .split(LF)
          .filter((line) => line.includes(shown(0x0a)) && line.includes('src/date'));
        expect(rows, `${sink} split one filename across rows`).toHaveLength(1);
      }
    });
  });

  describe('§17 — the page a human types a digest for', () => {
    it('leaves the candidate, its body and its digest byte for byte as filed', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const run = await buildRun(HOSTILE, cwd);
      const stored = parsePublicationCandidate(run.record.publications[0]?.candidate);
      const before = structuredClone(stored);
      const digestBefore = publicationDigestOf(stored);
      const bodyShaBefore = sha256Hex(stored.prBody);

      const page = formatPr(prStageResult(run), createRenderer({ color: false }));

      expect(stored).toEqual(before);
      expect(publicationDigestOf(stored)).toBe(digestBefore);
      expect(sha256Hex(stored.prBody)).toBe(bodyShaBefore);
      expect(stored.knownLimitations[0]).toBe(HOSTILE.limitation);
      // The body is the public document, so it keeps its own bytes; the screen quoting it
      // is where they become inert.
      expect(stored.prBody).toContain(LF);
      expect(activeControl(page, LF), 'the pr page').toBeNull();
      expect(page).toContain(shown(0x202e));
    });

    it('emits --json whose bytes are inert and whose data is still the candidate', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const run = await buildRun(HOSTILE, cwd);
      const stored = parsePublicationCandidate(run.record.publications[0]?.candidate);

      // `pr --json` is one `terminalSafeJson` call over these documents, so the property
      // is measured on that call with that payload. Driving `prAction` itself needs a
      // measured Git workspace, which this offline build deliberately has none of.
      const document = { digest: publicationDigestOf(stored), candidate: stored, published: false };
      const encoded = terminalSafeJson(document);

      expect(JSON.parse(encoded)).toEqual(document);
      expect(activeControl(encoded, `${LF}${TAB}`), 'pr --json').toBeNull();
      expect(encoded).toContain(shown(0x202e));
    });
  });

  describe('§12 — a gate that writes controls', () => {
    it('is digested over the bytes it really wrote, and inert on the screen', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const run = await buildRun(HOSTILE, cwd);
      const receipt = run.verified.verification?.gates[0]?.receipt;
      expect(receipt, 'the engine filed no receipt').toBeTruthy();
      const child = childOf(HOSTILE);

      // The receipt's own framing, recomputed from the child's unedited bytes: a display
      // decision that reached the digest would move this number.
      const raw = `mergesutra-gate-output/1\nstdout ${String(
        child.stdout.length,
      )}\u0000${child.stdout}\nstderr ${String(child.stderr.length)}\u0000${child.stderr}`;
      expect(receipt?.outputSha256).toBe(sha256Hex(raw));
      expect(receipt?.redacted).toBe(false);
      expect(receipt?.stdoutSummary).toContain(ESC);
      expect(receipt?.stderrSummary).toContain(RLO);

      const { pages } = await pagesOf(run, cwd);
      const verify = pages.find((page) => page.sink === 'verify')?.text ?? '';
      // Measured, not assumed: this screen prints the engine's reason for each gate and
      // never a receipt summary, so a child's bytes cannot reach a terminal from here.
      expect(verify).not.toContain(child.stderr);
      expect(activeControl(verify, LF), 'the verify page').toBeNull();

      const doctor = pages.find((page) => page.sink === 'doctor')?.text ?? '';
      // The one child line this build does print is the first line of `git --version`,
      // and it is escaped there rather than dropped.
      expect(doctor).toContain(shown(0x1b));
      expect(doctor).toContain('PR CREATED');
    });

    it('writes the pack to disk without rewriting the payload’s words out of the evidence', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-pack-');
      const run = await buildRun(HOSTILE, cwd);
      await reportAction(RUN_ID, { env: { NO_COLOR: '1' } }, { store: run.store, cwd }, () => {});

      // §23: the evidence is the file, and a display decision must not reach into it.
      // What the file holds is the receipt verbatim, so the payload's bytes are all
      // still there — as JSON's data, each in whichever of two forms JSON writes it.
      const commands = await readFile(path.join(run.runsRoot, RUN_ID, 'commands.jsonl'), 'utf8');
      const receipt = JSON.parse(commands.split(LF)[0] ?? '{}') as {
        stdoutSummary?: string;
        stderrSummary?: string;
      };
      expect(receipt.stdoutSummary).toContain(ESC);
      expect(receipt.stderrSummary).toContain(RLO);
      // The measured asymmetry, and the reason the boundary sits where it does: JSON
      // writes a C0 control as the six characters that name it, so this file cannot act
      // on a terminal, but it writes a bidi override such as the one above as the raw
      // character. A person who reads a pack with `cat` is reading it outside MergeSutra's
      // display path, so §28 names durable-pack terminal hardening as a residual rather
      // than claiming these bytes are inert on somebody else's terminal.
      expect(commands).not.toContain(ESC);
      expect(commands).not.toContain(BEL);
      expect(commands).toContain(RLO);
      const onDisk = await readFile(path.join(run.runsRoot, `${RUN_ID}.json`), 'utf8');
      expect(JSON.parse(onDisk).limitations[0]).toBe(HOSTILE.limitation);
    });

    it('holds the report screen’s rows to the pack’s own column, not one the payload started', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const run = await buildRun(HOSTILE, cwd);
      const { pages } = await pagesOf(run, cwd);
      const report = pages.find((page) => page.sink === 'report')?.text ?? '';

      // §10's provenance rule, stated for the one block this build lays out line by
      // line: the child's claim is readable, and it sits inside a row the pack wrote.
      expect(counterfeitedRows(report, FORGED)).toEqual([]);
    });
  });

  describe('§19/§20 — styling and safety are separate decisions', () => {
    it('keeps the renderer its colour, and the payload nothing', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const run = await buildRun(HOSTILE, cwd);
      const colour = createRenderer({ color: true });

      const coloured: [string, string][] = [
        ['review', formatReview(reviewStageResult(run), colour)],
        ['pr', formatPr(prStageResult(run), colour)],
      ];
      for (const [sink, text] of coloured) {
        expect(text, `${sink}: the renderer lost its colour`).toContain(`${ESC}[1m`);
        onlyRendererOwnColour(text, sink);
      }
    });

    it('says the same thing about the payload with colour on as with it off', async () => {
      const cwd = await scratchDir('mergesutra-terminal-hero-');
      const run = await buildRun(HOSTILE, cwd);

      const plain = formatPr(prStageResult(run), createRenderer({ color: false }));
      const styled = formatPr(prStageResult(run), createRenderer({ color: true }));
      // One page, two palettes: putting the screen's own styling aside, the bytes the
      // payload became are identical, so safety is not a property of the quiet mode.
      expect(styled.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')).toEqual(plain);
    });
  });

  it('GUARD: renders the same bytes twice, and edits no document on the way out', async () => {
    const cwd = await scratchDir('mergesutra-terminal-hero-');
    const run = await buildRun(HOSTILE, cwd);
    const recordFile = path.join(run.runsRoot, `${RUN_ID}.json`);
    const packFile = path.join(run.runsRoot, RUN_ID, 'report.md');
    const before = structuredClone(run.record);
    const onDiskBefore = await readFile(recordFile, 'utf8');
    // `report` is the one sink here that writes, so the pack goes on disk before the
    // first page set. Otherwise the second set would be a different world rather than
    // the same one shown twice, and the difference below would be news about ordering
    // instead of about the display path.
    await reportAction(RUN_ID, { env: { NO_COLOR: '1' } }, { store: run.store, cwd }, () => {});
    const packBefore = await readFile(packFile, 'utf8');

    const first = (await pagesOf(run, cwd)).pages;
    const second = (await pagesOf(run, cwd)).pages;

    expect(second.map((page) => page.text)).toEqual(first.map((page) => page.text));
    // §24: every object a screen was handed is still the object the stage filed.
    expect(run.record).toEqual(before);
    expect(await readFile(recordFile, 'utf8')).toBe(onDiskBefore);
    // And re-rendering the evidence wrote the same bytes it already held.
    expect(await readFile(packFile, 'utf8')).toBe(packBefore);
  });
});

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});
