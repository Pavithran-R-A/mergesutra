import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import { newRunId, createRunRecord, type RunRecord } from '../../src/state/run-record.js';
import { createFileRunStore, type RunStore } from '../../src/state/run-store.js';
import { newestRunId } from '../../src/state/run-selection.js';
import { issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';
import { TEST_REPO } from '../helpers/github.js';

/**
 * Which run an omitted run id means.
 *
 * Every command that takes an optional run id asked the store for its readable runs and
 * took the first, which is the newest *readable* record. A directory holding a newer
 * record this build cannot read therefore answered a different question — "which run can
 * I still parse?" — in a voice that said "here is your current run", and everything the
 * command then did, from `status`'s screen to `verify`'s choice of workspace, described
 * the older one. The selection is shared now, and it treats the unreadable list as part
 * of the same question: when the record it cannot read is newer than the one it would
 * pick, or cannot be dated at all, it refuses and says which id to pass.
 *
 * Nothing here reads an `mtime`. A run id's own name is the only ordering evidence a
 * file this build cannot parse can offer, and `run-<timestamp>-<suffix>` is the shape
 * `newRunId` writes, so a name outside that shape is exactly what it sounds like: an
 * age nobody can tell.
 */

let root: string;
let store: RunStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mergesutra-select-'));
  store = createFileRunStore(path.join(root, 'runs'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(at: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return createRunRecord({
    runId: `run-${at.replace(/[-:]/g, '')}Z-aaaaaa`,
    createdAt: `${at}Z`,
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
  } as Parameters<typeof createRunRecord>[0]);
}

/** Drop a file into the run directory that this build cannot turn into a record. */
async function unreadable(
  name: string,
  bytes = '{ "runId": "a record with the tail cut off',
): Promise<void> {
  const dir = path.join(root, 'runs');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.json`), bytes, 'utf8');
}

describe('choosing the run an omitted run id means', () => {
  it('takes the newest readable record when every record can be read', async () => {
    await store.save(record('2026-01-01T00:00:00'));
    await store.save(record('2026-09-24T00:00:00'));

    expect(await newestRunId(store)).toBe('run-20260924T000000Z-aaaaaa');
  });

  it('refuses to call an older run current when a newer record cannot be read', async () => {
    await store.save(record('2026-09-24T00:00:00'));
    await unreadable('run-20261001T000000Z-zzzzzz');

    const error = await newestRunId(store).catch((cause) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).kind).toBe('validation');
    expect((error as AppError).message).toMatch(/cannot be read/i);
    // The file is named so a person can go and look at it.
    expect((error as AppError).message).toContain('run-20261001T000000Z-zzzzzz.json');
    // And the refusal says what would have been chosen, so the way forward is one copy.
    expect((error as AppError).remediation).toContain('run-20260924T000000Z-aaaaaa');
  });

  it('quotes none of an unreadable record it is refusing over', async () => {
    await store.save(record('2026-09-24T00:00:00'));
    await unreadable('run-20261001T000000Z-zzzzzz', '{"outcome":"SECRET_TOKEN=a-b-c"');

    const error = (await newestRunId(store).catch((cause) => cause)) as AppError;

    expect(`${error.message} ${error.remediation}`).not.toMatch(/SECRET_TOKEN|a-b-c/);
  });

  it('refuses when the unreadable record was made in the same second as the one it would pick', async () => {
    await store.save(record('2026-09-24T00:00:00'));
    await unreadable('run-20260924T000000Z-zzzzzz');

    const error = (await newestRunId(store).catch((cause) => cause)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toMatch(/cannot be read/i);
  });

  it('still picks the newest run when the unreadable record is older than it', async () => {
    await store.save(record('2026-09-24T00:00:00'));
    await unreadable('run-20260101T000000Z-zzzzzz');

    expect(await newestRunId(store)).toBe('run-20260924T000000Z-aaaaaa');
  });

  it('refuses a record whose name cannot be dated against the run list', async () => {
    // A file this build did not name is a file whose age nobody can tell, and "which
    // run is current" is not a question that can be answered around it.
    await store.save(record('2026-09-24T00:00:00'));
    await unreadable('run-oldschema');

    const error = (await newestRunId(store).catch((cause) => cause)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toMatch(/age|date/i);
    expect(error.message).toContain('run-oldschema.json');
  });

  it('applies the same refusal to a filtered selection, measured against what the filter picks', async () => {
    await store.save(record('2026-01-01T00:00:00', { outcome: 'INCONCLUSIVE' }));
    await store.save(record('2026-06-01T00:00:00'));
    // Newer than the newest record the filter accepts, and unreadable.
    await unreadable('run-20260924T000000Z-zzzzzz');

    const error = (await newestRunId(
      store,
      (candidate) => candidate.outcome === 'INCONCLUSIVE',
    ).catch((cause) => cause)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toContain('run-20260924T000000Z-zzzzzz.json');
  });

  it('takes the newest record a filter accepts when nothing newer is unreadable', async () => {
    await store.save(record('2026-01-01T00:00:00', { outcome: 'INCONCLUSIVE' }));
    await store.save(record('2026-09-24T00:00:00'));
    await unreadable('run-20260601T000000Z-zzzzzz');

    expect(await newestRunId(store, (candidate) => candidate.outcome === 'INCONCLUSIVE')).toBe(
      'run-20260101T000000Z-aaaaaa',
    );
  });

  it('says there is no readable run rather than inventing one', async () => {
    await unreadable('run-20260924T000000Z-zzzzzz');

    expect(await newestRunId(store)).toBeNull();
  });

  it('names a few of the records in the way and counts the rest', async () => {
    await store.save(record('2026-09-24T00:00:00'));
    for (let index = 0; index < 7; index += 1) {
      await unreadable(`run-2026100${String(index)}T000000Z-zzzzzz`);
    }

    const error = (await newestRunId(store).catch((cause) => cause)) as AppError;

    const named = (error.message.match(/run-2026100\dT000000Z-zzzzzz\.json/g) ?? []).length;
    expect(named).toBeLessThanOrEqual(5);
    expect(error.message).toMatch(/2 more|more record/i);
  });

  it('leaves an explicit run id alone: a corrupt record is refused, not stepped around', async () => {
    await store.save(record('2026-09-24T00:00:00'));
    await unreadable('run-20261001T000000Z-zzzzzz');

    // Nothing in this build falls back when a person names the run they mean: the id
    // they typed is the id that is loaded, and a broken one stays broken on the page.
    await expect(store.load('run-20261001T000000Z-zzzzzz')).rejects.toBeInstanceOf(AppError);
    expect(await store.load('run-20260924T000000Z-aaaaaa')).toBeInstanceOf(Object);
  });

  it('builds ids this test can reason about', () => {
    // A guard on the fixture itself: the ordering above is the timestamp inside the id,
    // so if `newRunId` ever stops writing a sortable name these cases prove nothing.
    expect(newRunId(new Date('2026-09-24T00:00:00.000Z'), () => 0.5)).toMatch(
      /^run-\d{8}T\d{6}Z-[0-9a-f]{6}$/,
    );
  });
});
