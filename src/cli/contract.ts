import { AppError } from '../core/errors.js';
import {
  AcceptanceContractUnavailable,
  deriveAcceptanceCriteria,
  type InjectedCriterion,
} from '../contract/derive.js';
import type { AcceptanceContract } from '../contract/schema.js';
import { createRunRecord, newRunId, type RunCheck, type RunRecord } from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import { defaultRedactor } from '../security/redaction.js';
import { exitForOutcome } from './exit-codes.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';
import { PRODUCT_NAME } from '../version.js';

/**
 * `mergesutra contract [run-id]` — Stage 3.
 *
 * Turns what a run already knows into the list of things it must prove. This is
 * the only stage that creates obligations, and it creates none of its own: every
 * criterion here was written by the issue's own acceptance list, by a CI step,
 * or by a human who named themselves.
 *
 * It runs nothing. So every criterion it prints is `PENDING`, and the output
 * says that out loud — a contract is a promise to check, not a check.
 */

export interface ContractDeps {
  store: RunStore;
  /** Where `.mergesutra/runs` is found when no store is injected. */
  cwd: string;
  now: () => Date;
  random: () => number;
}

export interface ContractResult {
  readonly record: RunRecord;
  readonly acceptanceContract: AcceptanceContract | null;
  readonly sourceRunId: string;
  readonly recordFile: string | null;
  readonly saveError: string | null;
  readonly checks: readonly RunCheck[];
}

export async function runContractStage(
  input: { runId?: string; injectedCriteria?: readonly InjectedCriterion[] },
  deps: Partial<ContractDeps> = {},
): Promise<ContractResult> {
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(deps.cwd ?? process.cwd()));
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;

  const sourceRunId = input.runId ?? (await newestRunId(store));
  const source = await store.load(sourceRunId);

  const checks: RunCheck[] = [
    {
      name: 'Source run',
      status: 'PASS',
      detail: `${sourceRunId} (${source.stage}, ${source.outcome})`,
    },
  ];

  if (source.contract) {
    checks.push({
      name: 'Repository contract',
      status: 'PASS',
      detail: `${source.contract.gates.filter((gate) => gate.status === 'REPOSITORY_REQUIRED').length} required gate(s) available`,
    });
  } else {
    // Not a dead end: an issue that writes its own acceptance list is enough to
    // derive criteria. It is a gap, so it is recorded as one.
    checks.push({
      name: 'Repository contract',
      status: 'NOT_AVAILABLE',
      detail: 'this run never compiled one',
    });
  }

  const prose = source.issue
    ? {
        url: source.issue.url,
        title: source.issue.title,
        body: source.issue.body,
        // Comments are counted, not stored, in the issue record; the contract
        // does not get to claim it read text the run never kept.
        commentBodies: [] as string[],
      }
    : null;

  checks.push({
    name: 'Issue text',
    status: prose ? 'PASS' : 'SKIP',
    detail: prose
      ? `${source?.issue?.bodyLength ?? 0} character(s) of issue body`
      : 'no issue in this run',
  });

  const limitations: string[] = [];
  const recordRunId = newRunId(now(), random);
  const createdAt = now().toISOString();
  let acceptanceContract: AcceptanceContract | null = null;
  try {
    // A criterion statement is copied out of issue text, and issue text is
    // untrusted like any other input: redact before it is stored or printed, so
    // a credential pasted into an issue cannot be laundered into a run record.
    acceptanceContract = defaultRedactor.deep(
      deriveAcceptanceCriteria({
        runId: recordRunId,
        issue: prose,
        repository: {
          fullName: source.repository?.fullName ?? null,
          baseSha: source.base?.sha ?? null,
          localPath: source.local?.toplevel ?? null,
        },
        contract: source.contract,
        injectedCriteria: input.injectedCriteria,
      }),
    );
    checks.push({
      name: 'Acceptance Contract',
      status: 'PASS',
      detail: `${acceptanceContract.criteria.length} criteria, all PENDING`,
    });
  } catch (error) {
    if (!(error instanceof AcceptanceContractUnavailable)) throw error;
    limitations.push(...error.limitations);
    checks.push({
      name: 'Acceptance Contract',
      status: 'FAIL',
      detail: 'no criterion could be derived',
    });
  }

  limitations.push(...source.limitations.map((line) => `Carried from run ${sourceRunId}: ${line}`));

  // Pushed into the shared list, not only into the record: the table a reviewer
  // reads must carry the same "nothing ran" line as the file it can audit.
  checks.push({
    name: 'Verification',
    status: 'NOT_AVAILABLE',
    detail: 'nothing has run, so no criterion is proven',
  });

  const record = saveRecord({
    source,
    runId: acceptanceContract?.runId ?? recordRunId,
    createdAt,
    acceptanceContract,
    outcome: acceptanceContract ? 'CONTRACT_DERIVED' : 'INCONCLUSIVE',
    checks,
    limitations,
  });
  return persist(record, acceptanceContract, sourceRunId, checks, store);
}

async function newestRunId(store: RunStore): Promise<string> {
  const { runs, unreadable } = await store.list();
  if (runs.length === 0) {
    throw new AppError({
      kind: 'validation',
      message:
        unreadable.length > 0 ? 'No run record could be trusted.' : 'No run records exist yet.',
      remediation: 'Run `mergesutra issue <url>` or `mergesutra inspect <repo>` first.',
    });
  }
  return runs[0]!.runId;
}

function saveRecord(input: {
  source: RunRecord;
  runId: string;
  createdAt: string;
  acceptanceContract: AcceptanceContract | null;
  outcome: RunRecord['outcome'];
  checks: RunCheck[];
  limitations: string[];
}): RunRecord {
  const { source, acceptanceContract, checks, limitations, runId, createdAt, outcome } = input;
  return createRunRecord({
    runId,
    createdAt,
    stage: 'contract',
    outcome,
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract,
    checks: [...checks],
    nextStage: acceptanceContract
      ? 'PLAN — `mergesutra plan` asks BharatCode how to satisfy these criteria (Stage 4)'
      : 'INSPECT — then retry `mergesutra contract`',
    limitations: [
      ...new Set([
        ...limitations,
        ...(acceptanceContract?.limitations ?? []),
        'No criterion in this contract has been checked. `PENDING` is the only status MergeSutra could honestly assign.',
      ]),
    ],
  });
}

async function persist(
  record: RunRecord,
  acceptanceContract: AcceptanceContract | null,
  sourceRunId: string,
  checks: RunCheck[],
  store: RunStore,
): Promise<ContractResult> {
  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
    checks.push({ name: 'Run record', status: 'WARN', detail: `not written — ${saveError}` });
  }
  return {
    record,
    acceptanceContract,
    sourceRunId,
    recordFile,
    saveError,
    checks,
  };
}

export interface ContractCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Requirements a human states that no file states. The only route by which
   * text MergeSutra cannot read from the repository becomes a criterion — and it
   * has to name who said it, because `human` outranks repository policy in the
   * authority hierarchy and an anonymous upgrade would be worthless.
   */
  readonly criterion?: readonly string[];
  readonly by?: string;
}

export async function contractAction(
  runId: string | undefined,
  options: ContractCommandOptions,
  deps: Partial<ContractDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });
  const result = await runContractStage({ runId, injectedCriteria: humanCriteria(options) }, deps);

  if (options.json) {
    write(JSON.stringify({ recordFile: result.recordFile, record: result.record }, null, 2));
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — acceptance contract`));
  write('');
  write(formatContract(result, renderer));
  return exitForOutcome(result.record.outcome);
}

export function formatContract(result: ContractResult, renderer: Renderer): string {
  const {
    record,
    acceptanceContract: contract,
    checks,
    sourceRunId,
    recordFile,
    saveError,
  } = result;
  const lines: string[] = [];

  for (const check of checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(20)}${check.detail}`);
  }
  lines.push('');
  lines.push(label('From run', sourceRunId));
  lines.push(
    label('Repository', record.repository?.fullName ?? record.local?.toplevel ?? 'NOT_AVAILABLE'),
  );
  lines.push(
    label(
      'Base commit',
      record.base ? `${record.base.shortSha} (${record.base.source})` : 'NOT_AVAILABLE',
    ),
  );
  lines.push(
    label('Issue', record.issue ? `#${record.issue.number} ${record.issue.title}` : 'none'),
  );
  lines.push('');

  if (contract) {
    lines.push(renderer.heading(`Criteria (v${contract.version})`));
    for (const criterion of contract.criteria) {
      lines.push(
        `  ${criterion.id.padEnd(6)}${criterion.status.padEnd(9)}${sourceNote(criterion.source)}`,
      );
      lines.push(`        ${criterion.statement}`);
      const plan = criterion.verificationPlan
        .map((step) => (`command` in step ? `\`${step.command}\`` : step.kind))
        .join(', ');
      lines.push(renderer.dim(`        will check: ${plan}`));
    }
    lines.push('');
    if (contract.revisions.length > 0) {
      lines.push(label('Revisions', `${contract.revisions.length}`));
      for (const revision of contract.revisions) {
        lines.push(`  v${revision.version}: ${revision.reason}`);
      }
      lines.push('');
    }
  }

  lines.push(label('Outcome', record.outcome));
  lines.push('');

  const shown = contract ? [...contract.limitations, ...record.limitations] : record.limitations;
  const unique = [...new Set(shown)];
  if (unique.length > 0) {
    lines.push(renderer.heading('What this contract does not claim'));
    for (const limitation of unique) lines.push(`  ${limitation}`);
    lines.push('');
  }

  if (recordFile) lines.push(label('Run record', recordFile));
  else if (saveError) lines.push(label('Run record', `not written — ${saveError}`));
  lines.push(label('Next stage', record.nextStage));
  lines.push('');
  lines.push(
    renderer.dim(
      'A criterion became a requirement only because a file, the issue, or a named human said so.',
    ),
  );
  lines.push(
    renderer.dim('Nothing has been verified yet: every criterion above is PENDING by design.'),
  );
  return lines.join('\n');
}

/**
 * `--criterion` turns a human statement into a criterion. The name behind it is
 * mandatory: an unattributed requirement is the shape of the failure this whole
 * project is built to refuse.
 */
function humanCriteria(options: ContractCommandOptions): readonly InjectedCriterion[] | undefined {
  const statements = options.criterion ?? [];
  if (statements.length === 0) return undefined;
  const by = options.by?.trim();
  if (!by) {
    throw new AppError({
      kind: 'validation',
      message: 'A criterion a human states must name who stated it.',
      remediation: 'Add --by "<name or role>" alongside --criterion.',
    });
  }
  return statements.map((statement) => ({
    statement: statement.trim(),
    by,
    requirementType: 'functional' as const,
    // No command is invented on a human's word alone: the check is decided
    // later, in the open, rather than smuggled in with the requirement.
    check: null,
  }));
}

function sourceNote(source: AcceptanceContract['criteria'][number]['source']): string {
  switch (source.kind) {
    case 'issue':
      return 'from the issue';
    case 'repository_policy':
      return `from ${source.file}${source.line === null ? '' : `:${source.line}`}`;
    case 'inferred':
      return `inferred: ${source.reason}`;
    case 'human':
      return `by ${source.by}`;
  }
}

function label(name: string, value: string): string {
  return `${(name + ':').padEnd(14)}${value}`;
}
