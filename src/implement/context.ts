import { AppError } from '../core/errors.js';
import type { ConfinedReader } from '../security/reader.js';
import type { ImplementationPlan } from '../plan/schema.js';
import type { LoopLimits } from './limits.js';

/**
 * Choosing what the model gets to see — Stage 6.
 *
 * Sending a repository is neither helpful nor safe. It is slow, it costs tokens,
 * it carries whatever the last person left in `.env`, and it hands a model more
 * text to be influenced by than it can use. So context is assembled from a
 * purpose: the files this plan intends to change, plus what the run already
 * established as facts. Every byte goes through the confined reader, which means
 * a plan that names `.git/config` or `../../.ssh/id_rsa` produces a *recorded
 * skip* rather than content.
 *
 * Two budgets are enforced here: per-file bytes and a total. When the total runs
 * out the assembler stops and says so — a silently truncated context is how an
 * agent confidently describes a file it was never shown.
 */

export const MAX_CONTEXT_FILE_BYTES = 32 * 1024;

export interface ContextFile {
  readonly relativePath: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface SkippedContext {
  readonly relativePath: string;
  readonly reason: string;
}

export interface AssembledContext {
  readonly files: readonly ContextFile[];
  readonly skipped: readonly SkippedContext[];
  readonly bytes: number;
  readonly treeSample: readonly string[];
  /** Paths the plan named that the repository does not have yet — usually new files. */
  readonly notYetPresent: readonly string[];
}

/** What one `READ_FILE` action brought back, or why it did not. */
export interface ReadOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly text?: string;
}

export async function assembleInitialContext(input: {
  reader: ConfinedReader;
  plan: ImplementationPlan;
  limits: Pick<LoopLimits, 'maxContextFiles' | 'maxContextBytes'>;
}): Promise<AssembledContext> {
  const wanted = [...new Set(input.plan.body.changes.map((change) => change.file))];
  const treeSample = await input.reader.walk('.', 3, 60);
  const files: ContextFile[] = [];
  const skipped: SkippedContext[] = [];
  const notYetPresent: string[] = [];
  let bytes = 0;

  for (const relativePath of wanted) {
    if (files.length >= input.limits.maxContextFiles) {
      skipped.push({
        relativePath,
        reason: `context budget of ${input.limits.maxContextFiles} files is spent`,
      });
      continue;
    }
    const remaining = input.limits.maxContextBytes - bytes;
    if (remaining <= 0) {
      skipped.push({ relativePath, reason: 'context byte budget is exhausted' });
      continue;
    }
    const outcome = await readForModel(
      input.reader,
      relativePath,
      Math.min(remaining, MAX_CONTEXT_FILE_BYTES),
    );
    if (!outcome.ok) {
      if (outcome.detail.includes('no regular file')) notYetPresent.push(relativePath);
      else skipped.push({ relativePath, reason: outcome.detail });
      continue;
    }
    const text = outcome.text ?? '';
    files.push({
      relativePath,
      text,
      truncated: text.includes('(truncated:'),
    });
    bytes += Buffer.byteLength(text, 'utf8');
  }

  return { files, skipped, bytes, treeSample, notYetPresent };
}

/**
 * Execute one read the loop asked for, as an outcome string.
 *
 * The refusal text is what goes back to the model and into the record. A model
 * told "no" without being told why asks again, and bounds spent on unexplained
 * refusals make a bounded run look like a hang.
 */
export async function readForModel(
  reader: ConfinedReader,
  relativePath: string,
  maxBytes: number,
): Promise<ReadOutcome> {
  try {
    const receipt = await reader.readText(relativePath, maxBytes);
    return {
      ok: true,
      detail: `${receipt.relativePath}: ${receipt.bytes} bytes${receipt.truncated ? ' (truncated)' : ''}`,
      text: receipt.truncated
        ? `${receipt.text}\n\n(truncated: ${receipt.bytes} bytes on disk, ${maxBytes} sent)`
        : receipt.text,
    };
  } catch (error) {
    return { ok: false, detail: oneLine(errorMessage(error)) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
  const collapsed = value.replace(/[\r\n]+/g, ' ');
  return collapsed.length <= 300 ? collapsed : `${collapsed.slice(0, 297)}...`;
}
