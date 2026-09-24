import { rm } from 'node:fs/promises';
import { runContractStage } from '../../src/cli/contract.js';
import { runInspect } from '../../src/discovery/inspect.js';
import { runIntake } from '../../src/intake/intake.js';
import { toIssueDocument } from '../../src/github/schemas.js';
import type { AcceptanceContract } from '../../src/contract/schema.js';
import { parseRunRecord, type RunRecord } from '../../src/state/run-record.js';
import {
  cleanCloneTable,
  fakeGitHub,
  memoryRunStore,
  scriptedRunner,
  type MemoryRunStore,
} from './github.js';
import { makeFixtureTree, NODE_REPO_FILES } from './fixture.js';
import { issuePayload } from '../fixtures/github-payloads.js';

/**
 * Runs that have genuinely reached Stage 3, built with the real Stage 1/2/3 code.
 *
 * The planner is the first stage that spends a model call, and what is worth
 * testing is what it does with a real contract — so these build one instead of
 * hand-writing a record that merely looks like the previous stage's output.
 */

export const NOW = new Date('2026-09-25T09:00:00.000Z');

export const ACCEPTANCE_BODY = [
  '## Problem',
  '',
  '`parseDate("")` returns the epoch instead of rejecting.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] Empty input is rejected with a TypeError.',
  '- [ ] Valid ISO dates still parse.',
  '- [ ] The README example is updated.',
].join('\n');

export interface Prepared {
  store: MemoryRunStore;
  record: RunRecord;
  contract: AcceptanceContract;
  criteria: readonly string[];
  root: string;
}

/** A run built from the repository: its required gates became the criteria. */
export async function contractBackedRun(tempDirs: string[]): Promise<Prepared> {
  const store = memoryRunStore();
  const root = await makeFixtureTree(NODE_REPO_FILES);
  tempDirs.push(root);

  const inspected = await runInspect(
    { repoPath: root },
    { run: scriptedRunner(cleanCloneTable(root)).run, store, now: () => NOW, random: () => 0.5 },
  );
  const { record } = await runContractStage(
    { runId: inspected.record.runId },
    { store, now: () => NOW, random: () => 0.6 },
  );
  return prepared(record, root, store);
}

/** A run built from an issue that writes its own acceptance list. */
export async function issueBackedRun(
  tempDirs: string[],
  body = ACCEPTANCE_BODY,
): Promise<Prepared> {
  const store = memoryRunStore();
  const intake = await runIntake(
    { issueUrl: 'https://github.com/projectbharat/datekit/issues/123' },
    {
      github: fakeGitHub({ issue: async () => toIssueDocument({ ...issuePayload, body }) }),
      run: scriptedRunner({}).run,
      store,
      now: () => NOW,
      random: () => 0.4,
    },
  );
  const { record } = await runContractStage(
    { runId: intake.record.runId },
    { store, now: () => NOW, random: () => 0.6 },
  );
  return prepared(record, '', store);
}

function prepared(record: RunRecord, root: string, store: MemoryRunStore): Prepared {
  if (!record.acceptanceContract) throw new Error('fixture run produced no Acceptance Contract');
  return {
    store,
    record,
    root,
    contract: record.acceptanceContract,
    criteria: record.acceptanceContract.criteria.map((criterion) => criterion.id),
  };
}

export async function cleanUp(tempDirs: readonly string[]): Promise<void> {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The single plan-stage record a store holds. */
export function planRecord(store: MemoryRunStore): RunRecord {
  const records = [...store.files.values()]
    .map((text) => parseRunRecord(JSON.parse(text) as unknown))
    .filter((record) => record.stage === 'plan');
  if (records.length !== 1) {
    throw new Error(`expected one plan-stage record, got ${records.length}`);
  }
  return records[0]!;
}
