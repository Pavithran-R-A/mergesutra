import { z } from 'zod';
import { AppError } from '../core/errors.js';
import type { PublicationCandidate } from './candidate.js';
import { publicationDigestOf } from './digest.js';

/**
 * The only thing a human can authorise Stage 10 to want — and it is not much.
 *
 * A publication approval is five fields: which run, which candidate by digest,
 * when it was said, the one action it opens, and the version of this shape. There
 * is no sixth field that could read "and whatever else looks similar", because the
 * whole point of an approval on a pull request is that it is *about* something
 * specific: this page, these bytes, into this branch of this repository.
 *
 * The single action is `CREATE_PULL_REQUEST`, and it is deliberately not
 * transitive. Agreeing to open a pull request is not agreeing to merge it, to
 * approve it in GitHub's own review sense, to release a package, or to push over
 * someone's history — those are four separate acts, each with its own owner, and a
 * product that collapsed them into one flag would be asking a person to authorise
 * things they were never shown. So the enum has one member, and the tests are
 * attempts to put a second one in.
 *
 * Nor does an approval carry capability. `allowed: true` here means only that a
 * human's yes covers the candidate in front of them; whether anything can *act* on
 * that is `publisher.ts`, which in this build has no transport at all. The two are
 * kept apart on purpose: the commonest way to build an unsafe publication stage is
 * to make the yes and the hands the same object.
 *
 * Finally, BharatCode cannot write one of these. It has no field to author an
 * approval, the shape is strict, and the digest is derived from a candidate rather
 * than accepted from a caller — so a model, a repository file, or a hook that
 * prints `"approved": true` produces a document this module refuses to parse.
 */

export const PUBLICATION_APPROVAL_SCHEMA_VERSION = 1;

/**
 * The actions a human may grant. Exactly one, and it is not a shortcut to any
 * other: there is no `*_AND_MERGE`, no `APPROVE_ALL`, no `FORCE_*` spelling.
 */
export const PUBLICATION_ACTIONS = ['CREATE_PULL_REQUEST'] as const;
export type PublicationAction = (typeof PUBLICATION_ACTIONS)[number];

export const publicationApprovalSchema = z
  .object({
    schemaVersion: z.literal(PUBLICATION_APPROVAL_SCHEMA_VERSION),
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
    publicationDigest: z
      .string()
      .regex(
        /^[0-9a-f]{64}$/,
        'an approval names the 64-character digest of exactly one candidate, never a wildcard',
      ),
    approvedAt: z.string().min(1),
    action: z.enum(PUBLICATION_ACTIONS),
  })
  .strict();

export type PublicationApproval = z.infer<typeof publicationApprovalSchema>;

export const PUBLICATION_APPROVAL_STATUSES = ['MATCHED', 'ABSENT', 'STALE'] as const;
export type PublicationApprovalStatus = (typeof PUBLICATION_APPROVAL_STATUSES)[number];

export interface PublicationApprovalDecision {
  readonly status: PublicationApprovalStatus;
  /** True when a human's yes covers this exact candidate right now. */
  readonly allowed: boolean;
  /** True when the only thing missing is that yes. */
  readonly requiresApproval: boolean;
  /** The digest this candidate has now, so the flag can be typed from it. */
  readonly expectedDigest: string;
  readonly givenDigest: string | null;
  readonly reason: string;
}

/**
 * Record a human's yes for one candidate.
 *
 * The digest is computed here and nowhere else: a caller that could supply one
 * could approve a page it had not generated, and the `action` is not a parameter
 * because there is no second thing to ask for. Production reaches this only from
 * the CLI, after the candidate has been printed for a person to read; tests call it
 * directly, which is the one place a yes may be manufactured.
 */
export function approvePublication(input: {
  candidate: PublicationCandidate;
  approvedAt: string;
}): PublicationApproval {
  return {
    schemaVersion: PUBLICATION_APPROVAL_SCHEMA_VERSION,
    runId: input.candidate.runId,
    publicationDigest: publicationDigestOf(input.candidate),
    approvedAt: input.approvedAt,
    action: 'CREATE_PULL_REQUEST',
  };
}

/** Validate an approval read back from disk, refusing anything shaped otherwise. */
export function parsePublicationApproval(value: unknown): PublicationApproval {
  const parsed = publicationApprovalSchema.safeParse(value);
  if (!parsed.success) {
    const detail = issueDetail(parsed.error.issues);
    throw new AppError({
      kind: 'validation',
      message: `Cannot accept a publication approval: ${detail}.`,
      remediation:
        'An approval names the digest of exactly one candidate and the action `CREATE_PULL_REQUEST`. There is no way to approve every publication at once, and none to approve a merge.',
      details: { reason: detail },
    });
  }
  return parsed.data;
}

/**
 * Decide whether a human has approved this candidate. Pure, and total: every path
 * returns a reason a screen can print, and no path publishes anything.
 *
 * Hex case is not compared, because a person pastes a digest out of a terminal and
 * some terminals print it uppercase. Everything else is compared exactly, and an
 * approval written for another run is refused even if its digest were somehow
 * reusable — the run id is inside the digest, so it never would be, but the reason
 * a human gets should name the mistake they actually made.
 */
export function decidePublication(input: {
  candidate: PublicationCandidate;
  approval?: PublicationApproval | null;
}): PublicationApprovalDecision {
  const expectedDigest = publicationDigestOf(input.candidate);
  const approval = input.approval ?? null;

  if (approval === null) {
    return {
      status: 'ABSENT',
      allowed: false,
      requiresApproval: true,
      expectedDigest,
      givenDigest: null,
      reason:
        `No approval has been given for this candidate, so nothing will be published. ` +
        `Read the page above and run \`mergesutra pr ${input.candidate.runId} --approve ${expectedDigest}\` ` +
        'to record that you approved exactly it.',
    };
  }

  const givenDigest = approval.publicationDigest;

  if (approval.runId !== input.candidate.runId) {
    return {
      status: 'STALE',
      allowed: false,
      requiresApproval: true,
      expectedDigest,
      givenDigest,
      reason:
        `That approval belongs to another run: it names \`${approval.runId}\` and this candidate is ` +
        `\`${input.candidate.runId}\`. An approval is not portable between runs, even ones that look alike.`,
    };
  }

  if (givenDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
    return {
      status: 'STALE',
      allowed: false,
      requiresApproval: true,
      expectedDigest,
      givenDigest,
      reason:
        `The approval on this run is for a different candidate: it names ` +
        `${givenDigest.slice(0, 12)} and what is on screen now digests to ${expectedDigest.slice(0, 12)}. ` +
        'The page, the bytes it describes, or the evidence behind it has moved since the yes, so this ' +
        'is not a stale approval to be waved through — it is a yes to some other publication.',
    };
  }

  return {
    status: 'MATCHED',
    allowed: true,
    requiresApproval: false,
    expectedDigest,
    givenDigest,
    reason: `A human approved this exact candidate (${expectedDigest.slice(0, 12)}) at ${approval.approvedAt}.`,
  };
}

/** All of what was wrong, bounded: a forged document can fail on every field. */
function issueDetail(issues: readonly z.ZodIssue[]): string {
  const shown = issues.slice(0, 3).map((i) => `${i.path.join('.') || 'document'}: ${i.message}`);
  const rest = issues.length > 3 ? `; and ${String(issues.length - 3)} more` : '';
  return shown.join('; ') + rest;
}
