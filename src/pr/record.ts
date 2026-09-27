import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicationApprovalSchema, type PublicationApproval } from './approval.js';
import { publicationCandidateSchema, type PublicationCandidate } from './candidate.js';
import { publicationDigestOf } from './digest.js';

/**
 * What Stage 10 keeps of a publication proposal: the candidate, and the yes.
 *
 * Two documents, filed together, because they have different authors and answer
 * different questions. The candidate is MergeSutra's own assembly of facts a run had
 * already established; the approval is one human's statement about one digest of that
 * assembly. Stored apart from each other they are an audit trail — this is what was
 * proposed, and this is what was agreed to. Merged into one object with an `approved`
 * flag they would be a claim this product is not allowed to make about itself, which
 * is why the shape below has no such field and the pair is checked on the way in.
 *
 * The check is the only interesting rule here, and it is a comparison rather than a
 * judgement: an approval may name nothing but the digest of the candidate lying
 * beside it. Without it, a hand-edited record could file a real yes next to a
 * different proposal — the same document a stale approval already refuses at
 * decision time, surviving into storage where a later stage would read it as
 * history rather than as a mistake.
 *
 * There is deliberately no result field. No URL, no "published", no merge timestamp,
 * because Stage 10 has no remote and nothing in this file is allowed to imply
 * otherwise. A run's record can say a human approved a proposal; only a publisher
 * that does not exist in this build could ever say more, and it would write that in
 * its own document.
 */
export const publicationRecordSchema = z
  .object({
    /** The document a human was shown, exactly as it was shown to them. */
    candidate: publicationCandidateSchema,
    /**
     * Their yes, or `null`.
     *
     * `null` is not "declined" — it is "no decision has been recorded yet", which is
     * where most candidates in this product's history will stay. A declined
     * candidate has no field either, because Stage 10 has nothing to say about why.
     */
    approval: publicationApprovalSchema.nullable().default(null),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.approval === null) return;
    if (record.approval.publicationDigest.toLowerCase() !== publicationDigestOf(record.candidate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message:
          'names the digest of a different candidate, so it is not an approval of the one beside it',
      });
    }
  });
export type PublicationRecord = z.infer<typeof publicationRecordSchema>;

export interface NewPublicationRecordInput {
  readonly candidate: PublicationCandidate;
  /** Omit it, or pass null, for a candidate that has not been approved. */
  readonly approval?: PublicationApproval | null;
}

/**
 * File a candidate with, or without, the approval it earned.
 *
 * The digest is never a parameter: a caller that could supply one could file any yes
 * beside any proposal. Production reaches this with whatever `decidePublication` just
 * matched, and tests reach it directly, which is the one place a pairing may be
 * constructed rather than collected.
 */
export function buildPublicationRecord(input: NewPublicationRecordInput): PublicationRecord {
  return parsePublicationRecord({ candidate: input.candidate, approval: input.approval ?? null });
}

/** Read a stored publication back, refusing one whose approval is about something else. */
export function parsePublicationRecord(value: unknown): PublicationRecord {
  const parsed = publicationRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const detail =
    parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`)
      .join('; ') || 'unrecognised publication';
  throw new AppError({
    kind: 'validation',
    message: `Cannot record this publication: ${detail}.`,
    remediation:
      'A publication is one candidate and, beside it, the approval that names that candidate — so an approval always says which proposal it is about.',
  });
}
