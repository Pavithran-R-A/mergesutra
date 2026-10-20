import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunRecord, type RunRecord } from '../../src/state/run-record.js';
import type { AppError } from '../../src/core/errors.js';
import type { Runner } from '../../src/core/runner.js';
import { IMPL_SCHEMA_VERSION, type ImplementationRecord } from '../../src/implement/state.js';
import { hasGit, runWorkspace } from './git.js';
import { NODE_REPO_FILES } from './fixture.js';
import { cleanUp, contractBackedRun, NOW } from './plan.js';
import { SUCCEEDED } from './verification.js';

/**
 * A run that has genuinely reached Stage 7: real Stages 1→3, and a real Git
 * workspace holding a dirty patch.
 *
 * Stage 7's whole claim is about bytes a human could go and read, so the
 * fixture refuses to fake any of them. Only the gate processes are scripted —
 * installing vitest into a temporary directory to watch it fail proves nothing
 * about verification.
 */

export interface VerifyFixture {
  readonly prepared: Awaited<ReturnType<typeof contractBackedRun>>;
  readonly source: RunRecord;
  /** The workspace the run owns: a linked worktree Stage 5 made from `primaryDir`. */
  readonly repoDir: string;
  /** The human's checkout — the repository the run belongs to. */
  readonly primaryDir: string;
  readonly base: string;
}

export async function implementedRun(tempDirs: string[]): Promise<VerifyFixture> {
  const prepared = await contractBackedRun(tempDirs);
  const {
    primary: primaryDir,
    workspace: repoDir,
    relativePath,
    branch,
    base,
  } = await runWorkspace(
    {
      ...NODE_REPO_FILES,
      'src/parse.ts':
        'export function parseDate(input: string): Date {\n  return new Date(input);\n}\n',
      'README.md': '# datekit\n\nRun `npm run check` before pushing.\n',
    },
    prepared.record.runId,
  );
  tempDirs.push(primaryDir);
  await put(
    repoDir,
    'src/parse.ts',
    'export function parseDate(i: string): Date {\n  if (!i) throw new Error("empty");\n  return new Date(i);\n}\n',
  );
  await put(repoDir, 'test/parse.test.ts', 'it("rejects empty", () => {});\n');

  const implementation = stubImplementation(
    prepared.record,
    prepared.contract.criteria.map((c) => c.id),
    base,
    { relativePath, branch },
  );
  const source = createRunRecord({
    runId: prepared.record.runId,
    createdAt: prepared.record.createdAt,
    stage: 'implement',
    outcome: 'IMPLEMENTED_BY_MODEL',
    issueRef: prepared.record.issueRef,
    issue: prepared.record.issue,
    repository: prepared.record.repository,
    base: prepared.record.base,
    local: prepared.record.local && {
      ...prepared.record.local,
      requestedPath: primaryDir,
      toplevel: primaryDir,
    },
    contract: prepared.record.contract,
    acceptanceContract: prepared.contract,
    implementation,
    checks: prepared.record.checks,
    nextStage: 'VERIFY',
  });
  await prepared.store.save(source);
  return { prepared, source, repoDir, primaryDir, base };
}

/**
 * A loop record with the one fact Stage 7 reads: which workspace, on which
 * base. Hand-written because these tests check what verify may *believe* of an
 * implementation record, not whether the loop could produce one.
 */
export function stubImplementation(
  record: RunRecord,
  criterionIds: readonly string[],
  baseSha: string,
  workspace: { relativePath: string; branch: string } = { relativePath: '.', branch: 'main' },
): ImplementationRecord {
  return {
    schemaVersion: IMPL_SCHEMA_VERSION,
    runId: record.runId,
    status: 'COMPLETED_BY_MODEL',
    termination: { kind: 'FINISH', detail: 'the scripted model asked to stop' },
    model: 'bcb-test-model',
    workspace: {
      relativePath: workspace.relativePath,
      branch: workspace.branch,
      baseSha,
      reused: false,
      primaryDirty: false,
    },
    contract: { runId: record.runId, version: 1, criterionIds: [...criterionIds] },
    contractUntouched: true,
    limits: { maxSteps: 12, maxWrites: 8, maxCommands: 6, maxRepeatedFailures: 3 },
    actions: [],
    changes: [],
    proposedRevisions: [],
    finishClaim: {
      summary: 'Fixed parseDate and added a regression test; all criteria are complete.',
      criteriaBelievedComplete: [...criterionIds],
    },
    summary: {
      steps: 3,
      modelRequests: 3,
      writes: 2,
      commands: 1,
      refusedActions: 0,
      rejectedAnswers: 0,
      proposedRevisions: 0,
      totalBytesWritten: 220,
    },
    createdAt: NOW.toISOString(),
    limitations: [],
    verified: false,
    untrusted: true,
  };
}

/** A runner for the engine's gates that answers everything and records argv. */
export function scriptedGates(): { calls: string[]; runFor: (spec: unknown) => Runner } {
  const calls: string[] = [];
  const runner: Runner = async (file, args) => {
    calls.push([file, ...args].join(' '));
    return SUCCEEDED;
  };
  return { calls, runFor: () => runner };
}

export async function put(dir: string, relative: string, contents: string): Promise<void> {
  const target = path.join(dir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

export function errorFrom(fn: () => Promise<unknown>): Promise<AppError> {
  return fn().then(
    () => {
      throw new Error('expected an AppError');
    },
    (error) => error as AppError,
  );
}

export { cleanUp, hasGit, NOW };
