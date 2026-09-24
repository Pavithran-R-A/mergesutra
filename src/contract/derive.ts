import type { Gate, RepositoryContract } from '../discovery/contract.js';
import {
  type AcceptanceContract,
  type AcceptanceCriterion,
  acceptanceContractSchema,
  type ContractRevision,
  type VerificationStep,
} from './schema.js';

/** A criterion before it has an id, and before anything has run. */
type Draft = Omit<Extract<AcceptanceCriterion, { status: 'PENDING' }>, 'id'>;

/** The verification kinds that are allowed to name a command. */
type CommandKind = Extract<VerificationStep, { command: string }>['kind'];

/**
 * Criteria derivation — Stage 3, deterministic half.
 *
 * Two families of criteria can be derived without asking a model anything, and
 * both come from files this repository already has:
 *
 * 1. **Repository policy.** Every gate `inspect` marked `REPOSITORY_REQUIRED`
 *    becomes a criterion, because CI will block on it whatever the patch says.
 * 2. **Issue structure.** An issue body that contains an explicit acceptance
 *    list (a checkbox, a numbered list under an "acceptance criteria" heading,
 *    or a `- [ ]` line anywhere) states its own criteria, and MergeSutra copies
 *    them *verbatim*. Copying is not understanding, and the contract says so.
 *
 * What is deliberately **not** here: any attempt to infer a criterion from
 * issue prose that is not a list, and any `PASS`. Inferring needs judgment, so
 * it is the model's job in Stage 4 — behind a Zod schema — and a `PASS` needs
 * evidence, which is Stage 7. A contract fresh from this module is a list of
 * obligations, all `PENDING`, each pointing at the file or issue that produced
 * it.
 */

export interface IssueProse {
  url: string | null;
  title: string;
  body: string | null;
  commentBodies?: readonly string[];
}

/** A criterion contributed by something outside the repository's own files. */
export interface InjectedCriterion {
  statement: string;
  /** Who or what supplied it. Recorded, because provenance is mandatory. */
  by: string;
  requirementType: AcceptanceCriterion['requirementType'];
  /** How it will be checked; `null` means a human must decide. */
  check: { command: string; kind: CommandKind } | null;
}

export interface DeriveInput {
  runId: string;
  issue: IssueProse | null;
  /** Pinned identity from intake; derivation may not move it. */
  repository: AcceptanceContract['repository'];
  contract: RepositoryContract | null;
  injectedCriteria?: readonly InjectedCriterion[];
  now?: () => string;
}

/** Headings under which an issue states its own acceptance list. */
const ACCEPTANCE_HEADING =
  /^\s{0,3}(#{1,6}\s+|\*\*)?\s*(accept(?:ance)?\s+criteria|acceptance\s+condition[s]?|definition\s+of\s+done|dod|requirements?|must\s+have|checklist)\b/i;

/** A list item: `- [ ]`, `* [x]`, `1.`, `-` followed by text. */
const LIST_ITEM = /^\s*(?:[-*]\s*\[[ xX]\]\s*|[-*]\s+|\d+[.)]\s+)(\S.*?)\s*$/;

/** A bullet that is clearly not a requirement, whatever heading it sits under. */
const NOT_A_CRITERION =
  /^[\s>*_~-]*$|^(?:see|link|ref|example|e\.?g\.?|note|screenshot|stack\s?trace|log|cc|thanks|todo)\b|^\W*(?:https?:\/\/|\.{3}$)/i;

export function deriveAcceptanceCriteria(input: DeriveInput): AcceptanceContract {
  const criteria: Draft[] = [];
  const limitations: string[] = [];

  criteria.push(...criteriaFromIssue(input.issue, limitations));
  criteria.push(...criteriaFromContract(input.contract, limitations));
  criteria.push(...criteriaFromInjection(input.injectedCriteria ?? []));

  if (criteria.length === 0) {
    // The schema forbids an empty contract on purpose: "no obligations" is a
    // claim about the issue, not an observation, and nothing here may make it.
    limitations.push(
      'No criterion could be derived. `contract` refuses to emit an empty contract, so this run has no Acceptance Contract.',
    );
    throw new AcceptanceContractUnavailable(limitations);
  }

  return parseContract({
    schemaVersion: 1,
    version: 1,
    runId: input.runId,
    issueUrl: input.issue?.url ?? null,
    repository: input.repository,
    criteria: criteria.map((criterion, index) => ({ ...criterion, id: `AC-${index + 1}` })),
    revisions: [],
    limitations,
    untrusted: true,
  });
}

/** Raised when nothing can be derived: an empty contract would be a lie. */
export class AcceptanceContractUnavailable extends Error {
  readonly limitations: string[];
  constructor(limitations: string[]) {
    super('No acceptance criterion could be derived from the issue or repository contract.');
    this.name = 'AcceptanceContractUnavailable';
    this.limitations = limitations;
  }
}

function criteriaFromIssue(issue: IssueProse | null, limitations: string[]): Draft[] {
  if (!issue) {
    limitations.push(
      'No issue was supplied, so the contract can only carry what the repository demands.',
    );
    return [];
  }

  const lines = [...(issue.body ?? '').split('\n'), ...issueLinesFromComments(issue)];
  const statements: string[] = [];
  let inAcceptanceSection = false;

  for (const line of lines) {
    if (ACCEPTANCE_HEADING.test(line)) {
      inAcceptanceSection = true;
      continue;
    }
    if (/^\s*(#{1,6}\s+|\*\*)\s*\S/.test(line) && !ACCEPTANCE_HEADING.test(line)) {
      // Any other heading closes the acceptance section: a list two headings
      // later belongs to something else.
      inAcceptanceSection = false;
    }
    const item = line.match(LIST_ITEM)?.[1];
    if (!item) continue;
    if (inAcceptanceSection || /\[[ xX]\]/.test(line)) {
      if (NOT_A_CRITERION.test(item) || item.length < 4) continue;
      statements.push(item);
    }
  }

  if (statements.length === 0) {
    limitations.push(
      'The issue states no explicit acceptance list. MergeSutra did not guess criteria from prose; the planner (Stage 4) proposes those as model output, validated against this schema and labelled `MODEL CLAIM`.',
    );
    return [];
  }

  // Duplicate statements would produce two ids for one obligation, and then a
  // run could report "1/2 criteria verified" about a single sentence.
  const unique = [...new Set(statements)];
  if (unique.length < statements.length) {
    limitations.push(
      `${statements.length - unique.length} repeated acceptance item(s) in the issue were merged into one criterion.`,
    );
  }

  return unique.map((statement) => ({
    statement,
    requirementType: 'functional' as const,
    source: { kind: 'issue' as const, detail: 'issue body' },
    // A criterion copied from prose has no determined check yet. `manual` is
    // the honest value: a human or Stage 4 must choose the verification.
    verificationPlan: [
      {
        kind: 'manual' as const,
        source: 'OPTIONAL' as const,
        from: 'copied from the issue, not yet bound to a command',
      },
    ],
    status: 'PENDING' as const,
    evidence: [],
    limitations: ['Statement copied verbatim from the issue. MergeSutra has not interpreted it.'],
  }));
}

function issueLinesFromComments(issue: IssueProse): string[] {
  // Comments are the lowest-authority prose in the product (§15). They are
  // searched only for an explicit list, never for a statement to trust, and a
  // criterion sourced from a comment says so in `source.detail`.
  return (issue.commentBodies ?? []).flatMap((body) => body.split('\n')).map((line) => line);
}

function criteriaFromContract(contract: RepositoryContract | null, limitations: string[]): Draft[] {
  if (!contract) {
    limitations.push(
      "No repository contract was available, so the repository's own required checks are missing from this contract. Run `mergesutra inspect` first.",
    );
    return [];
  }

  const required = contract.gates.filter(
    (gate: Gate) => gate.status === 'REPOSITORY_REQUIRED' && gate.command !== null,
  );
  if (required.length === 0) {
    limitations.push(
      'The repository requires no gate CI enforces, so nothing here is demanded by the repository.',
    );
    return [];
  }

  return required.map((gate) => ({
    statement: `The repository's required \`${gate.kind}\` check passes.`,
    requirementType: 'convention' as const,
    source: {
      kind: 'repository_policy' as const,
      file: gate.provenance?.file ?? 'unknown',
      line: gate.provenance?.line ?? null,
    },
    verificationPlan: [
      {
        kind: kindForGate(gate.kind),
        command: gate.command as string,
        source: 'REPOSITORY_REQUIRED' as const,
        from: gate.provenance?.detail ?? null,
      },
    ],
    status: 'PENDING' as const,
    evidence: [],
    limitations: [gate.why],
  }));
}

function criteriaFromInjection(injected: readonly InjectedCriterion[]): Draft[] {
  // The `human` source sits above repository policy in the authority hierarchy
  // (§14), so it is the one route by which a requirement MergeSutra cannot read
  // from a file may enter the contract — and it must name who added it.
  return injected.map((criterion) => ({
    statement: criterion.statement,
    requirementType: criterion.requirementType,
    source: { kind: 'human' as const, by: criterion.by },
    verificationPlan: criterion.check
      ? [
          {
            kind: criterion.check.kind,
            command: criterion.check.command,
            source: 'MERGESUTRA_ADDITIONAL' as const,
            from: 'supplied with the criterion',
          },
        ]
      : [
          {
            kind: 'manual' as const,
            source: 'MERGESUTRA_ADDITIONAL' as const,
            from: 'no automatic check was supplied',
          },
        ],
    status: 'PENDING' as const,
    evidence: [],
    limitations: [
      criterion.check === null
        ? 'No automatic check was supplied for this criterion, so it needs human review.'
        : 'This requirement came from a human, not from a file in the repository.',
    ],
  }));
}

function kindForGate(kind: Gate['kind']): CommandKind {
  return kind;
}

/**
 * Replace criteria with a new set, keeping history. Stage 6 needs this (an
 * implementation can genuinely discover the issue was wider than it looked),
 * and the whole point of the version field is that it cannot be done silently:
 * a revision without a reason is a rewritten contract pretending to be honest.
 */
export function withRevision(
  contract: AcceptanceContract,
  criteria: AcceptanceCriterion[],
  reason: string,
  now: string,
): AcceptanceContract {
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new Error(
      'A contract revision requires a reason. Criteria may not be changed to make a run look successful.',
    );
  }
  const previousIds = new Set(contract.criteria.map((criterion) => criterion.id));
  const revision: ContractRevision = {
    version: contract.version + 1,
    reason: trimmed,
    affectedCriterionIds: [
      ...criteria.filter((criterion) => !previousIds.has(criterion.id)).map((c) => c.id),
      ...[...previousIds].filter((id) => !criteria.some((criterion) => criterion.id === id)),
    ],
    createdAt: now,
  };
  return parseContract({
    ...contract,
    version: revision.version,
    criteria,
    revisions: [...contract.revisions, revision],
  });
}

function parseContract(value: unknown): AcceptanceContract {
  // `parse` is the whole point: every derived contract has to survive its own
  // schema before a caller can see it. A criterion that accidentally carries
  // evidence with `PENDING` fails here rather than in a report.
  return acceptanceContractSchema.parse(value);
}
