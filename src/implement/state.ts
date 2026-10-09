import { z } from 'zod';
import { criterionIdSchema } from '../plan/schema.js';

/**
 * What a Stage 6 run records about itself.
 *
 * The shape is written so that the lies a loop could tell are unrepresentable,
 * the same trick the plan and contract schemas use:
 *
 * - there is no criterion status field anywhere in here. A run cannot report
 *   that implementation made something pass, because nothing in this schema can
 *   hold a `PASS`;
 * - `status` describes the *loop*, not the work: `COMPLETED_BY_MODEL` means the
 *   model asked to stop, which is a claim to be checked by Stage 7, not a result;
 * - the Acceptance Contract is recorded by identity (run id and version) with
 *   `contractUntouched: true`, so a later reader can see the loop had no hand in it;
 * - proposed revisions are stored beside that, never merged into it.
 *
 * File content is not stored — only a digest and a size — because the record is
 * written to disk next to the repository and may be pasted into a report.
 */

export const IMPL_SCHEMA_VERSION = 1;

/** How the loop ended. None of these is a judgement about the patch. */
export const loopStatusSchema = z.enum([
  'COMPLETED_BY_MODEL',
  'BLOCKED',
  'NEEDS_HUMAN_REVIEW',
  'INCONCLUSIVE',
  'CANCELLED',
]);
export type LoopStatus = z.infer<typeof loopStatusSchema>;

/** The specific rule that stopped it, so a reader can tell a bound from a failure. */
export const terminationKindSchema = z.enum([
  'FINISH',
  'MODEL_BLOCKED',
  'MAX_STEPS',
  'MAX_WRITES',
  'MAX_COMMANDS',
  'MAX_REFUSALS',
  'REPEATED_FAILURE',
  'SCHEMA_REFUSAL',
  'MODEL_UNAVAILABLE',
  'DEADLINE',
  'CANCELLED',
]);
export type TerminationKind = z.infer<typeof terminationKindSchema>;

export const actionOutcomeSchema = z.enum([
  'OBSERVED',
  'APPLIED',
  'REFUSED',
  'CHECK_FAILED',
  'CHECK_PASSED',
  'CLAIMED',
  'RECORDED',
]);
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;

export const actionLogEntrySchema = z
  .object({
    /** Assigned by MergeSutra; the model never numbers its own steps. */
    step: z.number().int().positive(),
    action: z.enum([
      'READ_FILE',
      'LIST_FILES',
      'SEARCH',
      'WRITE_FILE',
      'RUN_CHECK',
      'PROPOSE_CONTRACT_REVISION',
      'FINISH',
      'BLOCKED',
    ]),
    /** Path, argv or query — bounded and redacted, never file content. */
    target: z.string(),
    criterionIds: z.array(z.string()).default([]),
    outcome: actionOutcomeSchema,
    detail: z.string(),
    /** Present for an executed command only. */
    exitCode: z.number().int().nullable().default(null),
    risk: z.string().nullable().default(null),
    at: z.string(),
  })
  .strict();
export type ActionLogEntry = z.infer<typeof actionLogEntrySchema>;

export const fileChangeSchema = z
  .object({
    relativePath: z.string(),
    bytes: z.number().int().nonnegative(),
    created: z.boolean(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    criterionIds: z.array(z.string()).default([]),
    step: z.number().int().positive(),
  })
  .strict();
export type FileChange = z.infer<typeof fileChangeSchema>;

/**
 * A model asking for a criterion to change. Kept here, not in the contract,
 * because a model cannot revise the obligations it is being measured against —
 * a human reads this and runs `mergesutra contract` again with a reason.
 */
export const proposedRevisionSchema = z
  .object({
    step: z.number().int().positive(),
    criterionId: criterionIdSchema,
    previous: z.string(),
    proposed: z.string(),
    reason: z.string(),
    sourceEvidence: z.string(),
    applied: z.literal(false).default(false),
  })
  .strict();
export type ProposedRevision = z.infer<typeof proposedRevisionSchema>;

export const workspaceIdentitySchema = z
  .object({
    /** Relative to the primary checkout, so the record stays meaningful elsewhere. */
    relativePath: z.string(),
    branch: z.string(),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    reused: z.boolean(),
    primaryDirty: z.boolean(),
  })
  .strict();
export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;

export const implementationSummarySchema = z
  .object({
    steps: z.number().int().nonnegative(),
    modelRequests: z.number().int().nonnegative(),
    writes: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    refusedActions: z.number().int().nonnegative(),
    /**
     * Model answers rejected before anything ran, over the whole run.
     *
     * Without this the record could say five requests and three actions and had
     * no way to account for the other two, which is how both Stage 14 live runs
     * spent paid turns and then failed to explain themselves. Defaulted because
     * records written before the field exist on disk; a run that rejected
     * nothing reads as zero, which is what it did.
     */
    rejectedAnswers: z.number().int().nonnegative().default(0),
    proposedRevisions: z.number().int().nonnegative(),
    totalBytesWritten: z.number().int().nonnegative(),
  })
  .strict();
export type ImplementationSummary = z.infer<typeof implementationSummarySchema>;

export const implementationRecordSchema = z
  .object({
    schemaVersion: z.literal(IMPL_SCHEMA_VERSION),
    runId: z.string().min(1),
    status: loopStatusSchema,
    termination: z
      .object({
        kind: terminationKindSchema,
        detail: z.string(),
      })
      .strict(),
    /** Copied from the response envelope: what the gateway reported answering. */
    model: z.string().min(1),
    workspace: workspaceIdentitySchema,
    /** The contract this loop was pointed at, by identity only. */
    contract: z
      .object({
        runId: z.string().min(1),
        version: z.number().int().positive(),
        criterionIds: z.array(z.string()).default([]),
      })
      .strict(),
    /** Structural proof: this record has no way to express a contract change. */
    contractUntouched: z.literal(true).default(true),
    limits: z
      .object({
        maxSteps: z.number().int().positive(),
        maxWrites: z.number().int().positive(),
        maxCommands: z.number().int().positive(),
        maxRepeatedFailures: z.number().int().positive(),
      })
      .strict(),
    actions: z.array(actionLogEntrySchema).default([]),
    changes: z.array(fileChangeSchema).default([]),
    proposedRevisions: z.array(proposedRevisionSchema).default([]),
    /** The model's own account of what it finished. A claim, rendered as one. */
    finishClaim: z
      .object({
        summary: z.string(),
        criteriaBelievedComplete: z.array(criterionIdSchema).default([]),
      })
      .strict()
      .nullable()
      .default(null),
    summary: implementationSummarySchema,
    /** When the loop ended, from the injected clock. */
    createdAt: z.string().min(1),
    limitations: z.array(z.string()).default([]),
    /** Nothing here has been verified; Stage 7 owns that word. */
    verified: z.literal(false).default(false),
    untrusted: z.literal(true).default(true),
  })
  .strict();
export type ImplementationRecord = z.infer<typeof implementationRecordSchema>;
