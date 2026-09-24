import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { runInspect } from '../../src/discovery/inspect.js';
import { runIntake } from '../../src/intake/intake.js';
import { parseRunRecord, type RunRecord } from '../../src/state/run-record.js';
import type { RunStore } from '../../src/state/run-store.js';
import { acceptanceContractSchema, type AcceptanceContract } from '../../src/contract/schema.js';
import { toIssueDocument } from '../../src/github/schemas.js';
import {
  cleanCloneTable,
  fakeGitHub,
  memoryRunStore,
  type MemoryRunStore,
  scriptedRunner,
} from '../helpers/github.js';
import { makeFixtureTree, NODE_REPO_FILES } from '../helpers/fixture.js';
import { issuePayload } from '../fixtures/github-payloads.js';

/**
 * `mergesutra contract` is the stage that creates obligations, so what matters
 * here is what it must not do: invent a criterion nobody asked for, promote a
 * `PENDING` to a `PASS`, keep a secret copied out of issue text, or imply that a
 * check ran.
 *
 * Everything is offline. The run it reads is produced by the real Stage 1 and
 * Stage 2 code against a temp fixture tree and an in-memory run store.
 */

const NOW = () => new Date('2026-09-25T08:00:00.000Z');
const SENSITIVE_KEY = 'sk-contractcmd-SECRETVALUE-777';

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

function cli(
  argv: string[],
  store: RunStore,
  c: ReturnType<typeof capture>,
  json = false,
): Promise<number> {
  return run(['node', 'mergesutra', ...(json ? ['--json'] : []), ...argv], {
    write: c.write,
    writeErr: c.writeErr,
    env: { PATH: '/usr/bin', NO_COLOR: '1', BHARATCODE_API_KEY: SENSITIVE_KEY },
    contract: { store, now: NOW, random: () => 0.7 },
  });
}

/** The record this command wrote — found by stage, because its id is generated. */
function writtenByContract(store: MemoryRunStore): RunRecord {
  const records = [...store.files.values()].map((text) => parseRunRecord(JSON.parse(text)));
  const contracts = records.filter((record) => record.stage === 'contract');
  if (contracts.length !== 1) {
    throw new Error(`expected one contract-stage record, got ${contracts.length}`);
  }
  return contracts[0]!;
}

function contractOf(record: RunRecord): AcceptanceContract {
  return acceptanceContractSchema.parse(record.acceptanceContract);
}

function labelled(text: string, name: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.startsWith(`${name}:`))
      ?.trim() ?? ''
  );
}

/** A Stage 2 run against a fixture repository, stored and ready to derive from. */
async function inspectedRun(store: MemoryRunStore): Promise<RunRecord> {
  const root = await makeFixtureTree(NODE_REPO_FILES);
  created.push(root);
  const result = await runInspect(
    { repoPath: root },
    { run: scriptedRunner(cleanCloneTable(root)).run, store, now: NOW, random: () => 0.5 },
  );
  return result.record;
}

/** A Stage 1 run: an issue with the given body, and no repository contract. */
async function intakeRun(body: string, store: MemoryRunStore): Promise<RunRecord> {
  const result = await runIntake(
    { issueUrl: 'https://github.com/projectbharat/datekit/issues/123' },
    {
      github: fakeGitHub({ issue: async () => toIssueDocument({ ...issuePayload, body }) }),
      run: scriptedRunner({}).run,
      store,
      now: NOW,
      random: () => 0.4,
    },
  );
  return result.record;
}

describe('mergesutra contract — the obligations a run must prove', () => {
  it('turns each CI-required gate into a criterion that cites the file', async () => {
    const store = memoryRunStore();
    const source = await inspectedRun(store);
    const c = capture();
    const code = await cli(['contract'], store, c);

    expect(code).toBe(EXIT.OK);
    const text = c.text();
    expect(text).toContain('MergeSutra — acceptance contract');
    expect(text).toContain('CONTRACT_DERIVED');
    expect(text).toContain('from .github/workflows/ci.yml');
    expect(text).toContain('prettier --check .');
    expect(text).toContain('will check:');
    expect(labelled(text, 'From run')).toContain(source.runId);
  });

  it('stores a schema-valid contract in which nothing is verified', async () => {
    const store = memoryRunStore();
    await inspectedRun(store);
    await cli(['contract'], store, capture());

    const record = writtenByContract(store);
    expect(record.outcome).toBe('CONTRACT_DERIVED');
    const contract = contractOf(record);
    expect(contract.criteria.length).toBeGreaterThan(0);
    expect(contract.criteria.every((item) => item.status === 'PENDING')).toBe(true);
    expect(contract.criteria.every((item) => item.evidence.length === 0)).toBe(true);
    expect(contract.revisions).toHaveLength(0);
    expect(record.checks.find((check) => check.name === 'Verification')?.status).toBe(
      'NOT_AVAILABLE',
    );
    expect(record.limitations.join(' ')).toContain('PENDING');
  });

  it('says out loud that it has verified nothing', async () => {
    const store = memoryRunStore();
    await inspectedRun(store);
    const c = capture();
    await cli(['contract'], store, c);
    expect(c.text()).toContain('Nothing has been verified yet');
    expect(c.text()).toContain('nothing has run, so no criterion is proven');
  });

  it('carries the issue’s own acceptance list, verbatim and unproven', async () => {
    const store = memoryRunStore();
    await intakeRun(
      [
        '## Problem',
        '',
        '`parseDate("")` returns the epoch.',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] Empty input is rejected.',
        '- [ ] Valid ISO dates still parse.',
      ].join('\n'),
      store,
    );
    const c = capture();
    const code = await cli(['contract'], store, c);

    expect(code).toBe(EXIT.OK);
    const contract = contractOf(writtenByContract(store));
    const fromIssue = contract.criteria.filter((item) => item.source.kind === 'issue');
    expect(fromIssue.map((item) => item.statement)).toEqual([
      'Empty input is rejected.',
      'Valid ISO dates still parse.',
    ]);
    expect(fromIssue.every((item) => item.status === 'PENDING')).toBe(true);
    expect(c.text()).toContain('from the issue');
    expect(c.text()).toContain('Repository contract');
  });

  it('refuses to invent criteria when neither the issue nor the repository says anything', async () => {
    const store = memoryRunStore();
    const source = await intakeRun('## Problem\n\n`parseDate("")` returns the epoch.\n', store);
    const c = capture();
    const code = await cli(['contract', source.runId], store, c);

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(c.text()).toContain('no criterion could be derived');
    expect(c.text()).toContain('No criterion could be derived');
    const record = writtenByContract(store);
    expect(record.acceptanceContract).toBeNull();
    expect(record.nextStage).toContain('INSPECT');
  });

  it('redacts a credential pasted into issue text before printing or storing it', async () => {
    const store = memoryRunStore();
    await intakeRun(
      `## Acceptance criteria\n\n- [ ] Rotate the token ${SENSITIVE_KEY} before release.\n`,
      store,
    );
    const c = capture();
    await cli(['contract'], store, c);

    expect(c.text()).not.toContain(SENSITIVE_KEY);
    expect(c.errorText()).not.toContain(SENSITIVE_KEY);
    // Stage 1 keeps the issue body verbatim (it hashes what it read); this stage
    // must not repeat it into a contract that gets printed and forwarded.
    const contractRecord = JSON.stringify(writtenByContract(store).acceptanceContract);
    expect(contractRecord).toContain('Rotate the token');
    expect(contractRecord).not.toContain(SENSITIVE_KEY);
    expect(contractRecord).toContain('[REDACTED]');
  });

  it('uses the run it is told to, not simply the newest one', async () => {
    const store = memoryRunStore();
    const issueOnly = await intakeRun(
      '## Acceptance criteria\n\n- [ ] Rejects empty input.\n',
      store,
    );
    const inspected = await inspectedRun(store);

    const fromInspected = capture();
    expect(await cli(['contract', inspected.runId], store, fromInspected)).toBe(EXIT.OK);
    expect(labelled(fromInspected.text(), 'From run')).toContain(inspected.runId);

    const fromIssueOnly = capture();
    expect(await cli(['contract', issueOnly.runId], store, fromIssueOnly)).toBe(EXIT.OK);
    expect(labelled(fromIssueOnly.text(), 'From run')).toContain(issueOnly.runId);
    expect(fromIssueOnly.text()).toContain('this run never compiled one');
  });

  it('--json carries the whole record and keeps the honest exit code', async () => {
    const store = memoryRunStore();
    await inspectedRun(store);
    const c = capture();
    const code = await cli(['contract'], store, c, true);

    expect(code).toBe(EXIT.OK);
    const payload = JSON.parse(c.text()) as { record: RunRecord; recordFile: string | null };
    expect(payload.record.outcome).toBe('CONTRACT_DERIVED');
    expect(payload.recordFile).toContain(payload.record.runId);
    expect(contractOf(payload.record).criteria.every((item) => item.status === 'PENDING')).toBe(
      true,
    );
  });

  it('reports a run record it could not write instead of claiming it can be resumed', async () => {
    const store = memoryRunStore();
    const source = await inspectedRun(store);
    const failing: RunStore = {
      save: async () => {
        throw new Error('disk is read-only');
      },
      load: async () => source,
      list: async () => ({
        runs: [
          {
            runId: source.runId,
            createdAt: source.createdAt,
            outcome: source.outcome,
            canonical: '(no issue)',
            file: `/runs/${source.runId}.json`,
          },
        ],
        unreadable: [],
      }),
    };
    const c = capture();
    const code = await cli(['contract'], failing, c);

    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain('not written — disk is read-only');
    expect(c.text()).toContain('CONTRACT_DERIVED');
  });
});
