import { AppError } from '../core/errors.js';
import { sha256Hex } from '../security/digest.js';
import { publicationCandidateSchema, type PublicationCandidate } from './candidate.js';

/**
 * The digest of a frozen publication candidate — Stage 10's approval surface.
 *
 * This is the number a human types back to say yes, so it names the whole of what
 * they said yes *to*: which repository, which commit it started from, which bytes
 * would move, which branch they move between and which branch they merge into, the
 * title and body a reviewer would read, the evidence pack that backs the page's
 * claims, the review those claims repeat, and the caveats printed under them.
 *
 * Two things are excluded, for opposite reasons.
 *
 * `createdAt` is absent because a person who approves a scope at 10:15 has
 * approved that scope, not that minute. A digest that moved with the clock would
 * quietly expire every approval on a rebuild, and the habit it would teach is
 * reaching for a blunter flag rather than reading the page again. The same state
 * frozen twice must produce the same number — which is also why `STALE` in this
 * product means the scope moved, and never means a timer ran out.
 *
 * The full body is folded in as `prBodySha256` rather than as its text, so the
 * line set stays small enough to compute anywhere while still moving on one
 * character: the body is the largest thing on the page, and a digest that ignored
 * a word of it would let a rewrite pass under an approval written for the old one.
 *
 * Nothing here is fuzzy. Field values are used exactly as written, the limitation
 * list keeps the order the run recorded it in, and a candidate that fails its own
 * schema is refused rather than digested on the strength of the fields this file
 * happens to recognise — otherwise a document carrying `approved: true` would
 * still produce a number to point at, and the pointer would look legitimate.
 *
 * This function decides nothing. It has no notion of whether a candidate *should*
 * be published, and no field that records anybody having said yes; that is
 * `approval.ts`, which compares a digest against this one.
 */

export const PUBLICATION_DIGEST_LABEL = 'mergesutra-publication/1';

function linesOf(candidate: PublicationCandidate): string[] {
  return [
    PUBLICATION_DIGEST_LABEL,
    `run ${candidate.runId}`,
    `repository ${candidate.repository}`,
    `base ${candidate.baseSha}`,
    `patch ${candidate.patchIdentity}`,
    `target ${candidate.targetBranch}`,
    `source ${candidate.proposedBranch}`,
    `title ${candidate.prTitle.trim()}`,
    `body ${candidate.prBodySha256}`,
    `pack ${candidate.evidencePackIdentity}`,
    // Closure is its own line because GitHub acts on it: a page that says
    // `Fixes #123` will close someone's issue, and that is not a wording change.
    `issue ${candidate.issueCanonical ?? 'none'} ${candidate.closesIssue ? 'closes' : 'relates'}`,
    `review ${String(candidate.reviewCycle)} ${candidate.reviewedPatchIdentity}`,
    `review-summary ${candidate.reviewSummary.trim()}`,
    `verification ${candidate.verificationSummary.trim()}`,
    `limitations ${candidate.knownLimitations.map((line) => line.trim()).join('\u0000')}`,
  ];
}

/**
 * The digest of one frozen candidate.
 *
 * Validated before it is hashed: this number is what an approval will be pinned
 * to, so a document with a field MergeSutra does not define must fail loudly here
 * rather than be digested quietly and approved as if it were ordinary.
 */
export function publicationDigestOf(candidate: PublicationCandidate): string {
  const parsed = publicationCandidateSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Cannot digest a publication candidate: it is not a candidate MergeSutra would publish (${
        issue?.path.join('.') ?? 'document'
      }: ${issue?.message ?? 'invalid'}).`,
      remediation:
        'Digest the candidate this stage built and stored for the run, from `record.publications`.',
      details: { reason: issue?.message ?? 'invalid' },
    });
  }
  return sha256Hex(linesOf(parsed.data).join('\n'));
}
