import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRunRecord,
  newRunId,
  type NewRunRecordInput,
  type RunRecord,
} from '../../src/state/run-record.js';
import { createFileRunStore, type RunStore } from '../../src/state/run-store.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import { issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';
import { TEST_REPO } from '../helpers/github.js';

/**
 * Two saves of one run id in one process (audit finding F02).
 *
 * `save` stages every record at `${target}.${pid}.tmp` and renames it into place.
 * The name carries the pid but nothing per-save, so two concurrent saves of the
 * same run compute one scratch path: one rename takes the file the other is about
 * to rename, and the loser fails with a raw ENOENT although its record was written.
 *
 * Production serialises these saves — each stage command saves once, at its
 * boundary, after awaiting everything before it, and the per-run operation lock
 * keeps a second process out. The collision is therefore not reachable through
 * the CLI today. It is pinned here because `save` is the durability boundary for a
 * run's whole belief state, and its atomicity should not rest on a caller promise
 * it does not enforce.
 */

let root: string;
let store: RunStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mergesutra-runs-concurrent-'));
  store = createFileRunStore(path.join(root, 'runs'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(overrides: Partial<NewRunRecordInput> = {}): RunRecord {
  return createRunRecord({
    runId: newRunId(new Date('2026-09-24T21:32:07.000Z'), () => 0.25),
    createdAt: '2026-09-24T21:32:07.000Z',
    stage: 'intake',
    outcome: 'INTAKE_COMPLETE',
    issueRef: {
      ...TEST_REPO,
      number: 123,
      canonical: 'projectbharat/datekit#123',
      url: 'https://x',
    },
    issue: toIssueDocument(issuePayload),
    repository: toRepositoryIdentity(repositoryPayload, TEST_REPO),
    base: {
      sha: '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182',
      shortSha: '3f2a1c9d8e',
      source: 'local-git',
    },
    local: null,
    contract: null,
    checks: [],
    nextStage: 'DISCOVERY',
    limitations: [],
    ...overrides,
  });
}

function reasonOf(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? String(result.reason) : 'fulfilled';
}

describe('createFileRunStore save concurrency', () => {
  it('does not let two saves of one run id trample one scratch file', async () => {
    const base = record();
    const [first, second] = await Promise.allSettled([
      store.save(base),
      store.save({ ...base, outcome: 'INCONCLUSIVE' } as RunRecord),
    ]);

    expect(first.status, `first save: ${reasonOf(first)}`).toBe('fulfilled');
    expect(second.status, `second save: ${reasonOf(second)}`).toBe('fulfilled');

    const loaded = await store.load(base.runId);
    expect(['INTAKE_COMPLETE', 'INCONCLUSIVE']).toContain(loaded.outcome);
    const names = await readdir(path.join(root, 'runs'));
    expect(names.filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
