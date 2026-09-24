import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  RUN_SCHEMA_VERSION,
  createRunRecord,
  newRunId,
  type NewRunRecordInput,
  type RunRecord,
} from '../../src/state/run-record.js';
import {
  createFileRunStore,
  defaultRunStoreRoot,
  type RunStore,
} from '../../src/state/run-store.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import { issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';
import { TEST_REPO } from '../helpers/github.js';

let root: string;
let store: RunStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mergesutra-runs-'));
  store = createFileRunStore(path.join(root, 'runs'));
});

afterEach(async () => {
  // The temp dir is created by the test process and removed by it; nothing
  // outside `root` is ever touched.
  await readdir(root);
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

describe('createFileRunStore', () => {
  it('writes under a runs directory it creates', async () => {
    const file = await store.save(record());
    expect(path.dirname(file)).toBe(path.resolve(path.join(root, 'runs')));
    expect(path.basename(file)).toMatch(/^run-.*\.json$/);
  });

  it('round-trips a record exactly', async () => {
    const saved = record();
    await store.save(saved);
    expect(await store.load(saved.runId)).toEqual(saved);
  });

  it('leaves no temporary files behind', async () => {
    await store.save(record());
    const names = await readdir(path.join(root, 'runs'));
    expect(names.filter((n) => n.endsWith('.json'))).toHaveLength(1);
    expect(names.filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('overwrites the same run id rather than forking a second file', async () => {
    const first = record({ outcome: 'INTAKE_COMPLETE' });
    await store.save(first);
    await store.save({ ...first, outcome: 'INCONCLUSIVE' } as RunRecord);
    const loaded = await store.load(first.runId);
    expect(loaded.outcome).toBe('INCONCLUSIVE');
    expect(
      (await readdir(path.join(root, 'runs'))).filter((n) => n.endsWith('.json')),
    ).toHaveLength(1);
  });

  it('refuses a run id that would escape the run directory', async () => {
    const evil = { ...record(), runId: '../evil' } as RunRecord;
    const error = await store.save(evil).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    // Rejected before the run directory is even created: nothing escapes.
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(root)).not.toContain('evil.json');
  });

  it('reports a missing run as not-found with a usable remediation', async () => {
    const error = await store.load('run-does-not-exist').catch((e) => e);
    expect((error as AppError).kind).toBe('not-found');
    expect((error as AppError).remediation).toContain('mergesutra issue');
  });

  it('lists newest first with a one-line summary each', async () => {
    const old = record({
      runId: 'run-20260101T000000Z-aaaaaa',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const fresh = record({
      runId: 'run-20260924T000000Z-bbbbbb',
      createdAt: '2026-09-24T00:00:00.000Z',
    });
    await store.save(old);
    await store.save(fresh);
    const listed = await store.list();
    expect(listed.runs.map((r) => r.runId)).toEqual([fresh.runId, old.runId]);
    expect(listed.runs[0]).toMatchObject({
      canonical: 'projectbharat/datekit#123',
      outcome: 'INTAKE_COMPLETE',
    });
    expect(listed.unreadable).toEqual([]);
  });

  it('reports unreadable files instead of hiding them', async () => {
    const dir = path.join(root, 'runs');
    await store.save(record());
    await writeFile(path.join(dir, 'run-20260101T000000Z-zzzzzz.json'), '{ not json', 'utf8');
    await writeFile(
      path.join(dir, 'run-20260101T000001Z-zzzzzz.json'),
      JSON.stringify({ schemaVersion: 1, runId: 'nope' }),
      'utf8',
    );
    const listed = await store.list();
    expect(listed.runs).toHaveLength(1);
    expect(listed.unreadable).toHaveLength(2);
    expect(listed.unreadable[0]?.reason).toBeTruthy();
  });

  it('treats a missing run directory as zero runs, not an error', async () => {
    const empty = createFileRunStore(path.join(root, 'never-created'));
    expect(await empty.list()).toEqual({ runs: [], unreadable: [] });
  });

  it('defaults to .mergesutra/runs below the given directory', () => {
    expect(defaultRunStoreRoot('/project')).toBe(path.join('/project', '.mergesutra', 'runs'));
  });

  it('persists without a credential field anywhere in the file', async () => {
    const secret = 'sk-bharatcode-SHOULDNEVERBEWRITTEN-1';
    const saved = record();
    const file = await store.save(saved);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(secret);
    expect(text.toLowerCase()).not.toContain('apikey');
    expect(text.toLowerCase()).not.toContain('api_key');
    expect(JSON.parse(text).schemaVersion).toBe(RUN_SCHEMA_VERSION);
  });
});
