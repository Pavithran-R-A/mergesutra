import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { RISK_CLASSES, riskOf } from '../process/tool-policy.js';
import { VERSION } from '../version.js';
import {
  executionClassOf,
  executionClassSchema,
  gateProvenanceSchema,
  normalizeCommand,
  requirementLevelSchema,
  type DiscoveredGate,
  type DiscoveryOutcome,
  type GateProvenance,
} from './gates.js';

/**
 * What will be run, written down before anything is run — Stage 7.
 *
 * A plan is a promise, and the point of making it a document is that a promise
 * cannot be edited into evidence afterwards. Two properties carry that:
 *
 * 1. **There is no field for a result.** `PlannedGate` records a command, where
 *    it came from, how demanding it is and how long it may take. Exit codes live
 *    in receipts, which point back here by gate id. Nothing in this module can
 *    express "VG-001 passed", which is the type-level version of the rule that a
 *    model's opinion, a retry, or a convenient re-reading of a gate cannot turn
 *    a failure into a pass.
 * 2. **It names the patch it was written for.** `baseSha` and `patchIdentity`
 *    travel with the gates, so a receipt for one diff can be shown not to
 *    describe another. The identity is an opaque digest supplied by the caller:
 *    this module records *which* patch, and never claims to have worked out what
 *    the patch contains.
 *
 * Revisions are append-only, and a revision that would weaken a gate's
 * requirement level — or drop one the repository requires — is refused rather
 * than recorded. The moment a failing suite can be re-labelled advisory is the
 * moment the plan stops being a constraint and becomes a record of what was
 * convenient.
 *
 * Ids are stable: `VG-001` means the same gate for the life of the plan, so an
 * evidence file written three revisions ago still points at something real.
 */

export const PLAN_SCHEMA_VERSION = 1;

/** Three digits is far more gates than one run will ever hold. */
const GATE_ID = z.string().regex(/^VG-\d{3}$/, 'expected a gate id like VG-001');

/** Gate names: the Stage 2 kinds, and MergeSutra's own labels for its own checks. */
const GATE_NAME = z
  .string()
  .regex(/^[a-z][a-z0-9:_-]{1,39}$/, 'expected a lowercase gate name such as `test`');

const CRITERION_ID = z.string().regex(/^AC-\d+$/, 'expected an acceptance criterion id like AC-1');

/** Where a gate earns more than the default allowance. */
const LONG_RUNNERS = /^(?:test|build)$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 600_000;

/** How demanding a level is, so a revision can be checked for weakening. */
const REQUIREMENT_RANK = {
  REPOSITORY_REQUIRED: 3,
  REPOSITORY_SUGGESTED: 2,
  USER_REQUESTED: 1,
  MERGESUTRA_ADDITIONAL: 0,
} as const;

export const plannedGateSchema = z
  .object({
    id: GATE_ID,
    name: GATE_NAME,
    /** The argv spelled out, for a reader; `argv` is what actually runs. */
    command: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1).readonly(),
    /** Repository-relative directory the command runs in. */
    cwd: z.string().min(1),
    /**
     * Every spelling MergeSutra treats as this command: the invocation it runs,
     * first, then the script bodies it reaches from there.
     *
     * A criterion quotes a check the way a contributor reads it — the body of the
     * script — while the gate was planned from the words CI used. They are one
     * command, and the plan is where that fact gets written down once, so the
     * evidence stage never has to guess that `npm test` and `vitest run` agree.
     */
    commandForms: z.array(z.string().min(1)).min(1).readonly(),
    requirementLevel: requirementLevelSchema,
    provenance: gateProvenanceSchema,
    corroboratedBy: z.array(gateProvenanceSchema).readonly(),
    relevantCriteria: z.array(CRITERION_ID).readonly(),
    executionClass: executionClassSchema,
    /** Derived by the tool policy, never accepted from a caller. */
    risk: z.enum(RISK_CLASSES),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type PlannedGate = z.infer<typeof plannedGateSchema>;

const refusedCandidateSchema = z
  .object({
    command: z.string().min(1),
    provenance: gateProvenanceSchema,
    risk: z.enum(RISK_CLASSES),
    reason: z.string().min(1),
  })
  .strict();

export const planRevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    at: z.string().min(1),
    reason: z.string().min(1),
    /** The evidence that made the plan change, not a restatement of the change. */
    source: gateProvenanceSchema,
    added: z.array(GATE_ID).readonly(),
    removed: z.array(GATE_ID).readonly(),
    /** Both sides in full, so a reader can compare them without the older file. */
    before: z.array(plannedGateSchema).readonly(),
    after: z.array(plannedGateSchema).readonly(),
  })
  .strict();
export type PlanRevision = z.infer<typeof planRevisionSchema>;

export const verificationPlanSchema = z
  .object({
    schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
    mergeSutraVersion: z.string().min(1),
    runId: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
    /** Digest of the patch these gates will be run against. Supplied, not derived. */
    patchIdentity: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().min(1),
    revision: z.number().int().positive(),
    gates: z.array(plannedGateSchema).readonly(),
    revisions: z.array(planRevisionSchema).readonly(),
    /** What discovery refused to make a gate, kept so a report can list it. */
    refused: z.array(refusedCandidateSchema).readonly(),
    missingPrerequisites: z.array(z.string()).readonly(),
    notes: z.array(z.string()).readonly(),
  })
  .strict();
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;

/** A check MergeSutra adds on its own authority, never the repository's. */
export interface AdditionalGateSpec {
  readonly name: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** Why MergeSutra adds it; this becomes the provenance a reviewer reads. */
  readonly reason: string;
  readonly relevantCriteria?: readonly string[];
  readonly timeoutMs?: number;
}

export interface PlanSources {
  readonly discovered: DiscoveryOutcome;
  readonly additional?: readonly AdditionalGateSpec[];
}

export interface BuildPlanInput extends PlanSources {
  readonly runId: string;
  readonly baseSha: string;
  readonly patchIdentity: string;
  readonly now?: () => Date;
}

export interface RevisePlanInput extends PlanSources {
  readonly reason: string;
  readonly source: GateProvenance;
  readonly now?: () => Date;
}

/** A gate with everything except the number this module assigns. */
type UnplannedGate = Omit<PlannedGate, 'id'>;

export function buildVerificationPlan(input: BuildPlanInput): VerificationPlan {
  const gates = planGates(input).map((gate, index) => ({ ...gate, id: gateId(index + 1) }));
  return parseVerificationPlan({
    schemaVersion: PLAN_SCHEMA_VERSION,
    mergeSutraVersion: VERSION,
    runId: input.runId,
    baseSha: input.baseSha,
    patchIdentity: input.patchIdentity,
    createdAt: stamp(input.now),
    revision: 1,
    gates,
    revisions: [],
    ...disclosures(input.discovered),
  });
}

/**
 * Revise a plan without rewriting the plan that already exists.
 *
 * The proposal is a fresh reading of the repository, not a list of edits: a gate
 * that survives keeps its id wherever the new discovery happened to place it, and
 * only genuinely new commands are numbered. That is what lets a receipt written
 * against `VG-002` still mean something after CI gains a step.
 */
export function reviseVerificationPlan(
  previous: VerificationPlan,
  input: RevisePlanInput,
): VerificationPlan {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new AppError({
      kind: 'validation',
      message:
        'Refusing to revise a verification plan without a reason: an unexplained change to what must pass is exactly what this document exists to rule out.',
      remediation: 'Name the evidence that changed — a workflow step, a manifest, a human request.',
    });
  }

  const byIdentity = new Map(previous.gates.map((gate) => [identityOf(gate), gate]));
  const gates: PlannedGate[] = [];
  let next = highestIdNumber(previous.gates) + 1;
  for (const fresh of planGates(input)) {
    const earlier = byIdentity.get(identityOf(fresh));
    if (!earlier) {
      gates.push({ ...fresh, id: gateId(next) });
      next += 1;
      continue;
    }
    if (REQUIREMENT_RANK[fresh.requirementLevel] < REQUIREMENT_RANK[earlier.requirementLevel]) {
      throw weakened(earlier, fresh);
    }
    // The newer facts about the same command, under the id that never changes.
    gates.push({ ...fresh, id: earlier.id });
  }
  gates.sort((a, b) => a.id.localeCompare(b.id));
  assertNothingRequiredIsMissing(previous, gates);

  const previousIds = previous.gates.map((gate) => gate.id);
  const newIds = gates.map((gate) => gate.id);
  const revision: PlanRevision = {
    revision: previous.revision + 1,
    at: stamp(input.now),
    reason,
    source: input.source,
    added: newIds.filter((id) => !previousIds.includes(id)).sort(),
    removed: previousIds.filter((id) => !newIds.includes(id)).sort(),
    before: previous.gates,
    after: gates,
  };

  return parseVerificationPlan({
    ...previous,
    revision: revision.revision,
    gates,
    revisions: [...previous.revisions, revision],
    ...disclosures(input.discovered),
  });
}

export function parseVerificationPlan(value: unknown): VerificationPlan {
  const parsed = verificationPlanSchema.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new AppError({
      kind: 'validation',
      message: `Refusing to use a verification plan that does not match MergeSutra's own shape: ${describeIssue(issue)}.`,
      remediation:
        'Re-derive the plan from the run record. Editing a plan by hand is how a gate goes missing without anyone noticing.',
    });
  }
  return parsed.data as VerificationPlan;
}

function planGates(input: PlanSources): UnplannedGate[] {
  return [
    ...input.discovered.gates.map(fromDiscovery),
    ...(input.additional ?? []).map(fromAdditional),
  ];
}

function fromDiscovery(gate: DiscoveredGate): UnplannedGate {
  return {
    name: gate.name,
    command: gate.argv.join(' '),
    argv: gate.argv,
    cwd: gate.cwd,
    commandForms: gate.commandForms,
    requirementLevel: gate.requirementLevel,
    provenance: gate.provenance,
    corroboratedBy: gate.corroboratedBy,
    relevantCriteria: gate.relevantCriteria,
    executionClass: gate.executionClass,
    risk: gate.risk,
    timeoutMs: defaultTimeoutFor(gate.name),
  };
}

function fromAdditional(spec: AdditionalGateSpec): UnplannedGate {
  const argv = [...spec.argv];
  const cwd = spec.cwd ?? '.';
  return {
    name: spec.name,
    command: argv.join(' '),
    argv,
    cwd,
    // MergeSutra's own check reaches no script, so it has exactly one spelling.
    commandForms: [normalizeCommand(argv.join(' '))],
    // Derived, never read back from the spec: a caller cannot declare its own
    // preference to be the repository's requirement.
    requirementLevel: 'MERGESUTRA_ADDITIONAL',
    provenance: {
      source: 'MERGESUTRA_BUILTIN',
      file: null,
      detail: `MergeSutra adds this check on its own authority: ${spec.reason}`,
      line: null,
    },
    corroboratedBy: [],
    relevantCriteria: [...(spec.relevantCriteria ?? [])],
    executionClass: executionClassOf([argv.join(' ').toLowerCase()]),
    risk: riskOf({ op: 'execute', argv, cwd }),
    timeoutMs: spec.timeoutMs ?? defaultTimeoutFor(spec.name),
  };
}

function weakened(earlier: PlannedGate, fresh: UnplannedGate): AppError {
  return new AppError({
    kind: 'validation',
    message: `Refusing to revise the verification plan: ${earlier.id} (\`${earlier.command}\`) is ${earlier.requirementLevel} and this revision would make it ${fresh.requirementLevel}. A gate that fails does not become optional — fix the patch or report the failure.`,
    remediation: 'Keep the gate at the level the repository asked for.',
    details: {
      gateId: earlier.id,
      from: earlier.requirementLevel,
      to: fresh.requirementLevel,
    },
  });
}

function assertNothingRequiredIsMissing(
  previous: VerificationPlan,
  gates: readonly PlannedGate[],
): void {
  for (const earlier of previous.gates) {
    if (earlier.requirementLevel !== 'REPOSITORY_REQUIRED') continue;
    if (gates.some((gate) => gate.id === earlier.id)) continue;
    throw new AppError({
      kind: 'validation',
      message: `Refusing to revise the verification plan: ${earlier.id} (\`${earlier.command}\`) is required by the repository and is missing from the revision. A step CI runs does not leave the plan because it is inconvenient.`,
      remediation:
        'A base change that genuinely drops a gate belongs to a new plan for the new base, not to a revision of this one.',
      details: { gateId: earlier.id, command: earlier.command },
    });
  }
}

function defaultTimeoutFor(name: string): number {
  return LONG_RUNNERS.test(name) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * What makes two proposals the same gate.
 *
 * Command plus directory, not label and not level: the level is a conclusion
 * about a command, and a conclusion that strengthens is something a revision has
 * to be able to express — while `npm run lint` stays the same gate.
 */
function identityOf(gate: Pick<PlannedGate, 'name' | 'argv' | 'cwd'>): string {
  return `${gate.name}\u0000${gate.cwd}\u0000${gate.argv.join(' ')}`;
}

function gateId(number: number): string {
  return `VG-${String(number).padStart(3, '0')}`;
}

function highestIdNumber(gates: readonly PlannedGate[]): number {
  let highest = 0;
  for (const gate of gates) highest = Math.max(highest, Number(gate.id.slice(3)));
  return highest;
}

function disclosures(discovered: DiscoveryOutcome) {
  return {
    refused: discovered.refused,
    missingPrerequisites: discovered.missingPrerequisites,
    notes: discovered.notes,
  };
}

function stamp(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function describeIssue(issue: z.ZodIssue | undefined): string {
  if (!issue) return 'the document is not a plan';
  const path = issue.path.join('.') || 'document';
  return `${path}: ${issue.message}`;
}
