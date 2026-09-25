import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { decideTool } from '../process/tool-policy.js';
import { sha256Hex } from '../security/digest.js';
import type { PlannedGate, VerificationPlan } from './plan.js';

/**
 * Whether this run may execute one of a repository's commands — Stage 7.
 *
 * A verification gate is, from this machine's point of view, a command written
 * by a stranger. `npm run lint` may be exactly what the repository wants run,
 * and it may be a `postinstall` that phones home; nothing in the argv tells the
 * two apart. So before any repository-defined command runs, a human has to have
 * agreed to *this set of commands* for *this run*, locally, in this process.
 * That agreement is the only thing this module can be handed, and it can never
 * be inferred: no flag means "yes to everything", and no consent means the gates
 * are reported as blocked rather than quietly dropped.
 *
 * The order of the checks is the design:
 *
 * 1. **The tool policy first, and it is not negotiable.** It derives a command's
 *    risk from the argv, so `rm -rf` is DESTRUCTIVE and `git push` is a remote
 *    mutation whatever a caller claims. Consent cannot lift either. A gate's
 *    consent says "run this check", not "publish this branch".
 * 2. **Then who asked for the command.** MergeSutra's own checks were written
 *    here, and a command the operator typed themselves is already agreed;
 *    anything that came from a repository file needs the human's yes.
 * 3. **Then whether the yes still means this.** Consent is bound to a digest of
 *    the exact commands. Add, remove or change a gate and the old yes stops
 *    working — the same compare-before-write idea Stage 6 uses for file writes,
 *    applied to permission.
 *
 * This module decides; it does not run anything. The engine asks it per gate and
 * carries the answer.
 */

/** The reason a gate did not run, in the words a report prints. */
export const BLOCKED_CODES = [
  'BLOCKED_REPO_EXECUTION_APPROVAL_REQUIRED',
  'BLOCKED_REPO_EXECUTION_CONSENT_STALE',
] as const;
export type BlockedCode = (typeof BLOCKED_CODES)[number];

/**
 * What happened to one gate when the engine asked whether it may run.
 *
 * `BLOCKED` and `REFUSED` are different facts: one means a human could still say
 * yes, the other means saying yes would not help. A report that collapses them
 * tells the operator to do something that would change nothing.
 */
export const executionStatusSchema = z.enum([
  'CONSENTED',
  'SELF_AUTHORED',
  'OPERATOR_SUPPLIED',
  'BLOCKED',
  'REFUSED',
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

/** A gate id, in the same shape the plan uses — which is what rules out `*`. */
const GATE_ID = /^VG-\d{3}$/;

/**
 * A human's yes, recorded.
 *
 * There is no version field here on purpose: a consent is always stored inside a
 * versioned document (the verification record), and a second version number on a
 * nested object is a second thing to disagree with its parent.
 */
export const executionConsentSchema = z
  .object({
    /** The digest of the commands the human was shown. Not the plan's prose. */
    planDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'is not a 64-character hex digest of the gates agreed'),
    /** Exactly which gates that yes covered. There is no "all of them". */
    gateIds: z
      .array(z.string().regex(GATE_ID, 'a consent names exact gate ids like VG-001, never *'))
      .min(1, 'a consent must name at least one gate; agreeing to nothing is not a consent')
      .readonly(),
    grantedAt: z.string().min(1),
  })
  .strict();
export type ExecutionConsent = z.infer<typeof executionConsentSchema>;

export interface ExecutionDecision {
  readonly gateId: string;
  readonly status: ExecutionStatus;
  readonly allowed: boolean;
  /** True when the only thing missing is a human's consent. */
  readonly requiresConsent: boolean;
  readonly code: BlockedCode | null;
  readonly reason: string;
}

export interface ExecutionInput {
  /** The plan the gate belongs to; its commands are what consent was bound to. */
  readonly plan: VerificationPlan;
  /** The workspace this run owns. A gate that would run elsewhere is refused. */
  readonly workspace: string;
  readonly consent?: ExecutionConsent;
}

/** The digest a consent has to match: the commands themselves, in a fixed order. */
export function scopeDigest(plan: VerificationPlan): string {
  const lines = plan.gates
    .map((gate) => `${gate.id}\u0000${gate.cwd}\u0000${gate.argv.join(' ')}`)
    .sort();
  return sha256Hex(lines.join('\n'));
}

/**
 * Validate a consent read back from disk or built from a flag.
 *
 * A wildcard would be a `--yes` that means "run whatever the repository
 * declares", which is the exact capability this stage refuses to have. Listing
 * gate ids is not bureaucracy: it is what makes the human's agreement cover
 * something specific.
 */
export function parseExecutionConsent(value: unknown): ExecutionConsent {
  const parsed = executionConsentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to accept this execution consent: ${issue?.message ?? 'it is malformed'} (${issue?.path.join('.') ?? 'document'}).`,
      remediation:
        'Consent names the plan digest and the exact gate ids it covers — never a wildcard and never nothing.',
    });
  }
  return parsed.data;
}

/**
 * Decide one gate. Pure, and total: every path returns a reason a report can print.
 */
export function decideExecution(gate: PlannedGate, input: ExecutionInput): ExecutionDecision {
  const policy = decideTool(
    { op: 'execute', argv: [...gate.argv], cwd: gate.cwd },
    { workspace: input.workspace },
  );
  if (!policy.allowed) {
    return refused(gate.id, policyReason(gate, policy.risk, policy.reason));
  }

  if (gate.provenance.source === 'MERGESUTRA_BUILTIN') {
    return {
      gateId: gate.id,
      status: 'SELF_AUTHORED',
      allowed: true,
      requiresConsent: false,
      code: null,
      reason: 'MergeSutra wrote this check itself, so the operator already knows what it runs.',
    };
  }
  if (gate.provenance.source === 'USER_SUPPLIED') {
    return {
      gateId: gate.id,
      status: 'OPERATOR_SUPPLIED',
      allowed: true,
      requiresConsent: false,
      code: null,
      reason: 'The operator named this command themselves, which is the consent.',
    };
  }

  const consent = input.consent;
  if (!consent) {
    return {
      gateId: gate.id,
      status: 'BLOCKED',
      allowed: false,
      requiresConsent: true,
      code: 'BLOCKED_REPO_EXECUTION_APPROVAL_REQUIRED',
      reason:
        `Gate ${gate.id} would run \`${gate.command}\`, a command that came from ` +
        `${describeFact(gate)} — not from MergeSutra. Nothing runs on a repository's say-so ` +
        "until the operator consents to this run's gates.",
    };
  }
  if (consent.planDigest !== scopeDigest(input.plan)) {
    return {
      gateId: gate.id,
      status: 'BLOCKED',
      allowed: false,
      requiresConsent: true,
      code: 'BLOCKED_REPO_EXECUTION_CONSENT_STALE',
      reason:
        `Consent for ${gate.id} was given against a different set of commands: the plan's ` +
        `digest is now ${scopeDigest(input.plan).slice(0, 12)} and the consent names ` +
        `${consent.planDigest.slice(0, 12)}. The old yes no longer matches and does not run this.`,
    };
  }
  if (!consent.gateIds.includes(gate.id)) {
    return {
      gateId: gate.id,
      status: 'BLOCKED',
      allowed: false,
      requiresConsent: true,
      code: 'BLOCKED_REPO_EXECUTION_APPROVAL_REQUIRED',
      reason:
        `The consent on this run did not name ${gate.id} (\`${gate.command}\`), so it does not ` +
        'cover this gate. Consent is per gate.',
    };
  }

  return {
    gateId: gate.id,
    status: 'CONSENTED',
    allowed: true,
    requiresConsent: false,
    code: null,
    reason: `The operator consented to \`${gate.command}\` for this run's plan.`,
  };
}

/**
 * Why the policy stopped this gate, said so the operator can act.
 *
 * The risk class is named on purpose. "MergeSutra does not delete files" reads
 * like a mood; "classified DESTRUCTIVE, and consent cannot change that" reads
 * like a rule with a boundary.
 */
function policyReason(gate: PlannedGate, risk: string, policyText: string): string {
  if (risk === 'REMOTE_MUTATION') {
    return (
      `Refused before consent could apply: \`${gate.command}\` reaches the remote, and a gate's ` +
      'consent is not approval of a remote action. A human approves that command exactly, in a ' +
      'stage that publishes — this one does not.'
    );
  }
  if (risk === 'DESTRUCTIVE') {
    return (
      `Refused before consent could apply: the tool policy classifies \`${gate.command}\` as ` +
      `DESTRUCTIVE, and no consent enables a destructive command. ${policyText}`
    );
  }
  return `Refused by the tool policy: ${policyText}`;
}

function refused(gateId: string, reason: string): ExecutionDecision {
  return { gateId, status: 'REFUSED', allowed: false, requiresConsent: false, code: null, reason };
}

function describeFact(gate: PlannedGate): string {
  const source = gate.provenance.source.replace(/_/g, ' ').toLowerCase();
  return gate.provenance.file === null ? `a ${source} fact` : `${gate.provenance.file} (${source})`;
}
