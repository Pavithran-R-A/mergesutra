import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { sha256Hex } from '../security/digest.js';
import { defaultRedactor } from '../security/redaction.js';
import { gateProvenanceSourceSchema, requirementLevelSchema } from './gates.js';
import { plannedGateSchema, type PlannedGate } from './plan.js';

/**
 * What actually happened to one gate — Stage 7.
 *
 * The plan is a promise; a receipt is a fact, and the difference is the whole
 * point of keeping both. So the shape of a receipt is chosen around the ways a
 * fact gets improved on the way to being written down:
 *
 * - **The output is digested and quoted separately.** The digest covers every
 *   byte the command wrote, unredacted, so a reviewer can prove what ran. The
 *   quoted summary covers a bounded tail of the *redacted* bytes, so a
 *   credential a tool printed in its own stack trace cannot be archived,
 *   printed or sent anywhere by the record that exists to explain the failure.
 *   `digestsUnredactedOutput` says which of the two the hash describes, because
 *   a reader has to know whether they are checking the run or the quote.
 * - **The end is kept, not the beginning.** A suite that failed on test 400 of
 *   400 has its answer at the bottom; the top of the log is the part nobody
 *   needed.
 * - **Nothing ran is stated as nothing ran.** `exitCode: null` with
 *   `termination: 'NOT_EXECUTED'` is a legible fact; `exitCode: 0` is a lie that
 *   reads like a pass, so the two are refused together.
 * - **There is no room for a verdict.** A receipt records one command. Whether
 *   the criteria were met is derived elsewhere, from receipts, and a caller
 *   cannot bring their conclusion in on the same object as their evidence — the
 *   input is validated strictly for exactly that reason.
 *
 * `PASS` is therefore the most-checked word in the file: it is refused unless
 * the process exited on its own with code 0. A timeout is `INCONCLUSIVE`, which
 * is the difference between "we did not get an answer" and "we got a good one".
 */

export const RECEIPT_SCHEMA_VERSION = 1;

/** Three digits, matching the plan's ids, so a receipt points at one gate. */
const GATE_ID = z.string().regex(/^VG-\d{3}$/, 'expected a gate id like VG-001');
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-character hex digest');
const COMMIT = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

/**
 * What a gate contributed to the run.
 *
 * `NOT_RUN` and `BLOCKED` are separate because they ask different things of a
 * reader: one says the gate was reached and stopped, the other says the run
 * never got that far.
 */
export const GATE_RESULTS = [
  'PASS',
  'FAIL',
  'BLOCKED',
  'REFUSED',
  'NOT_RUN',
  'INCONCLUSIVE',
] as const;

/** Why the command is over, including when it never started. */
export const TERMINATIONS = [
  'EXITED',
  'TIMED_OUT',
  'OUTPUT_LIMIT',
  'NOT_EXECUTED',
  'DEPENDENCY',
  'CANCELLED',
] as const;

export const gateResultSchema = z.enum(GATE_RESULTS);
export const terminationSchema = z.enum(TERMINATIONS);
export type GateResult = z.infer<typeof gateResultSchema>;
export type Termination = z.infer<typeof terminationSchema>;

/** Per stream, in the record. Enough to debug from, small enough to keep. */
export const SUMMARY_LIMIT = 4_096;
/** Per stream, on screen. A report is not a log viewer. */
export const REPORT_LIMIT = 800;

export const gateReceiptSchema = z
  .object({
    schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
    gateId: GATE_ID,
    /** The command as it was going to run, in argv form. Not a shell string. */
    argv: z.array(z.string().min(1)).min(1).readonly(),
    cwd: z.string().min(1),
    workspace: z.string().min(1),
    baseSha: COMMIT,
    patchIdentity: DIGEST,
    requirementLevel: requirementLevelSchema,
    provenanceSource: gateProvenanceSourceSchema,
    provenanceFile: z.string().min(1).nullable(),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    result: gateResultSchema,
    exitCode: z.number().int().nullable(),
    termination: terminationSchema,
    stdoutSummary: z.string(),
    stderrSummary: z.string(),
    /** Over every byte both streams wrote, before masking. */
    outputSha256: DIGEST,
    outputTruncated: z.boolean(),
    redacted: z.boolean(),
    digestsUnredactedOutput: z.literal(true),
  })
  .strict();
export type GateReceipt = z.infer<typeof gateReceiptSchema>;

const receiptInputSchema = z
  .object({
    gate: plannedGateSchema,
    workspace: z.string().min(1),
    baseSha: COMMIT,
    patchIdentity: DIGEST,
    startedAt: z.date(),
    finishedAt: z.date(),
    result: gateResultSchema,
    exitCode: z.number().int().nullable(),
    termination: terminationSchema,
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

export interface BuildReceiptInput {
  readonly gate: PlannedGate;
  readonly workspace: string;
  readonly baseSha: string;
  readonly patchIdentity: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly result: GateResult;
  readonly exitCode: number | null;
  readonly termination: Termination;
  readonly stdout: string;
  readonly stderr: string;
}

export function buildReceipt(input: BuildReceiptInput): GateReceipt {
  const parsed = receiptInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to build a receipt from input that is not the shape of one: ${
        issue?.path.join('.') || 'document'
      }: ${issue?.message ?? 'invalid'}.`,
      remediation:
        'Record the command and its outcome here, and draw conclusions about criteria somewhere else.',
    });
  }
  const {
    gate,
    workspace,
    baseSha,
    patchIdentity,
    startedAt,
    finishedAt,
    result,
    exitCode,
    termination,
    stdout,
    stderr,
  } = parsed.data;

  checkCoherent(gate.id, result, exitCode, termination);

  const safeStdout = defaultRedactor.text(stdout);
  const safeStderr = defaultRedactor.text(stderr);
  const stdoutSummary = tail(safeStdout, SUMMARY_LIMIT);
  const stderrSummary = tail(safeStderr, SUMMARY_LIMIT);

  return gateReceiptSchema.parse({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    gateId: gate.id,
    argv: [...gate.argv],
    cwd: gate.cwd,
    workspace,
    baseSha,
    patchIdentity,
    requirementLevel: gate.requirementLevel,
    provenanceSource: gate.provenance.source,
    provenanceFile: gate.provenance.file,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    result,
    exitCode,
    termination,
    stdoutSummary: stdoutSummary.text,
    stderrSummary: stderrSummary.text,
    outputSha256: digestOf(stdout, stderr),
    outputTruncated: stdoutSummary.truncated || stderrSummary.truncated,
    redacted: safeStdout !== stdout || safeStderr !== stderr,
    digestsUnredactedOutput: true,
  });
}

export function parseGateReceipt(value: unknown): GateReceipt {
  const parsed = gateReceiptSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to use a verification receipt that does not match MergeSutra's own shape: ${
        issue?.path.join('.') || 'document'
      }: ${issue?.message ?? 'invalid'}.`,
      remediation:
        'Regenerate the receipt by re-running the gate. A receipt that has been edited is no evidence at all.',
    });
  }
  return parsed.data;
}

export interface OutputSummary {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The shortest honest version of a command's output, for a reader.
 *
 * MergeSutra quotes the end of each stream because that is where a tool says why
 * it gave up. Both are masked on the way out, so a caller can pass the raw
 * strings it was handed without having to remember to sanitise them first.
 */
export function summarizeOutput(
  stdout: string,
  stderr: string,
  limit: number = REPORT_LIMIT,
): OutputSummary {
  const out = tail(defaultRedactor.text(stdout), limit);
  const err = tail(defaultRedactor.text(stderr), limit);
  const parts = [out.text, err.text].filter((part) => part.length > 0);
  return {
    text: parts.join('\n'),
    truncated: out.truncated || err.truncated,
  };
}

function checkCoherent(
  gateId: string,
  result: GateResult,
  exitCode: number | null,
  termination: Termination,
): void {
  if (result === 'PASS' && (exitCode !== 0 || termination !== 'EXITED')) {
    throw new AppError({
      kind: 'validation',
      message: `Refusing to record a PASS for ${gateId}: it claims a pass for a command that ${
        termination === 'EXITED'
          ? `exited with code ${String(exitCode)}`
          : termination.toLowerCase()
      }.`,
      remediation: 'Report what the command did. A gate passes when it says so by exiting 0.',
    });
  }
  if (termination === 'NOT_EXECUTED' && exitCode !== null) {
    throw new AppError({
      kind: 'validation',
      message: `Refusing to record exit code ${String(
        exitCode,
      )} for ${gateId}, which never ran: nothing was executed, so nothing returned a status.`,
      remediation: 'Give the receipt a null exit code and the reason the gate was not reached.',
    });
  }
}

/**
 * A digest of the run, not of the quote.
 *
 * The lengths are hashed alongside the bodies so `('ab', 'c')` and `('a', 'bc')`
 * cannot land on the same receipt.
 */
function digestOf(stdout: string, stderr: string): string {
  return sha256Hex(
    `mergesutra-gate-output/1\nstdout ${String(stdout.length)}\u0000${stdout}\nstderr ${String(
      stderr.length,
    )}\u0000${stderr}`,
  );
}

function tail(text: string, limit: number): OutputSummary {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(text.length - limit), truncated: true };
}
