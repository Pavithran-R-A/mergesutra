import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { runIntake } from '../../src/intake/intake.js';
import { toIssueDocument } from '../../src/github/schemas.js';
import { RUN_SCHEMA_VERSION } from '../../src/state/run-record.js';
import type { RunStore } from '../../src/state/run-store.js';
import {
  GIT_MAIN_SHA,
  ISSUE_URL,
  cleanCloneTable,
  fakeGitHub,
  memoryRunStore,
  scriptedRunner,
} from '../helpers/github.js';
import { adversarialIssuePayload } from '../fixtures/github-payloads.js';

/**
 * Intake is the stage that decides what the rest of the run believes, so these
 * tests are less about formatting and more about honesty: does the record claim
 * only what was actually established, and does it say so when it could not?
 */

const REPO_DIR = process.cwd();

function names(result: { checks: readonly { name: string; status: string }[] }) {
  return result.checks.map((c) => `${c.name}=${c.status}`);
}

function statusOf(result: { checks: readonly { name: string; status: string }[] }, name: string) {
  return result.checks.find((c) => c.name === name)?.status;
}

function detailOf(result: { checks: readonly { name: string; detail: string }[] }, name: string) {
  return result.checks.find((c) => c.name === name)?.detail ?? '';
}

describe('runIntake — argument validation', () => {
  it('refuses to invent a run when given nothing', async () => {
    const error = await runIntake({}, {}).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).kind).toBe('validation');
    expect((error as AppError).message).toMatch(/nothing to intake/i);
  });

  it('treats blank strings as absent', async () => {
    const error = await runIntake({ issueUrl: '   ', repoPath: '' }, {}).catch((e) => e);
    expect((error as AppError).kind).toBe('validation');
  });

  it('fails loudly on a malformed URL instead of downgrading it to a warning', async () => {
    const error = await runIntake({ issueUrl: 'https://evil.example/a/b/issues/1' }, {}).catch(
      (e) => e,
    );
    expect((error as AppError).kind).toBe('validation');
  });
});

describe('runIntake — issue URL only', () => {
  it('builds a complete intake record from GitHub alone', async () => {
    const github = fakeGitHub();
    const store = memoryRunStore();
    const result = await runIntake(
      { issueUrl: ISSUE_URL },
      { github, store, now: () => new Date('2026-09-24T21:32:07.000Z'), random: () => 0.25 },
    );

    expect(names(result)).toEqual([
      'Issue URL=PASS',
      'Local repository=SKIP',
      'GitHub issue=PASS',
      'Repository=PASS',
      'Base commit=PASS',
      'Issue content trust=PASS',
    ]);
    expect(result.record).toMatchObject({
      schemaVersion: RUN_SCHEMA_VERSION,
      stage: 'intake',
      outcome: 'INTAKE_COMPLETE',
      contract: null,
      runId: 'run-20260924T213207Z-3fffff',
      mergeSutraVersion: expect.any(String),
    });
    expect(result.record.issue).toMatchObject({ number: 123, untrusted: true });
    expect(result.record.repository).toMatchObject({
      fullName: 'projectbharat/datekit',
      source: 'github-api',
    });
    expect(result.record.base).toEqual({
      sha: GIT_MAIN_SHA,
      shortSha: GIT_MAIN_SHA.slice(0, 10),
      source: 'github-api',
    });
    expect(result.record.local).toBeNull();
    expect(result.recordFile).toBe(`/runs/${result.record.runId}.json`);
    expect(result.saveError).toBeNull();
    expect(detailOf(result, 'Base commit')).toContain('GitHub head of main');
  });

  it('asks for the issue, the repository and the default-branch head, in that order', async () => {
    const github = fakeGitHub();
    await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(github.calls).toEqual([
      'issue:projectbharat/datekit#123',
      'repository:projectbharat/datekit',
      'branchHead:projectbharat/datekit@main',
    ]);
  });

  it('never spawns a process when no local path was supplied', async () => {
    const scripted = scriptedRunner({});
    await runIntake(
      { issueUrl: ISSUE_URL },
      { github: fakeGitHub(), run: scripted.run, store: memoryRunStore() },
    );
    expect(scripted.calls).toEqual([]);
  });

  it('records the import as untrusted data, never as instructions', async () => {
    const result = await runIntake(
      { issueUrl: ISSUE_URL },
      { github: fakeGitHub(), store: memoryRunStore() },
    );
    expect(result.record.limitations).toContain(
      'Issue text is data for the Acceptance Contract, not instructions to MergeSutra.',
    );
  });

  it('reports BLOCKED when GitHub refuses: the issue is the point of the run', async () => {
    const github = fakeGitHub({
      issue: () => {
        throw new AppError({
          kind: 'not-found',
          message: 'GitHub has no issue projectbharat/datekit#123 (it may be private or renamed).',
        });
      },
    });
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(statusOf(result, 'GitHub issue')).toBe('FAIL');
    expect(result.record.outcome).toBe('BLOCKED');
    expect(result.record.limitations.join(' ')).toMatch(/issue text unavailable/i);
  });

  it('calls a transient network failure WARN, not a verdict about the issue', async () => {
    const github = fakeGitHub({
      issue: () => {
        throw new AppError({
          kind: 'network',
          message: 'could not reach github.com',
          retryable: true,
        });
      },
    });
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(statusOf(result, 'GitHub issue')).toBe('WARN');
    expect(result.record.outcome).toBe('BLOCKED');
  });

  it('tells the user how to fix a missing gh CLI rather than blaming the issue', async () => {
    const github = fakeGitHub({
      issue: () => {
        throw new AppError({
          kind: 'config',
          message: "'gh' was not found on PATH.",
          remediation: 'Install the GitHub CLI, then run `gh auth login`.',
        });
      },
    });
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(detailOf(result, 'GitHub issue')).toContain('gh');
    expect(result.record.limitations.join(' ')).toContain('gh auth login');
  });

  it('keeps going without a repository identity, and marks the base NOT_AVAILABLE', async () => {
    const github = fakeGitHub({
      repository: () => {
        throw new AppError({ kind: 'auth', message: 'gh is not authenticated for github.com' });
      },
    });
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(statusOf(result, 'Repository')).toBe('NOT_AVAILABLE');
    expect(statusOf(result, 'Base commit')).toBe('NOT_AVAILABLE');
    expect(detailOf(result, 'Base commit')).toContain('no repository identity established');
    expect(result.record.outcome).toBe('INCONCLUSIVE');
  });

  it('does not fake a base commit when GitHub cannot name the branch head', async () => {
    const github = fakeGitHub({
      branchHead: () => {
        throw new AppError({ kind: 'invalid-response', message: 'branch reference was malformed' });
      },
    });
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(statusOf(result, 'Base commit')).toBe('NOT_AVAILABLE');
    expect(result.record.base).toBeNull();
    expect(result.record.outcome).toBe('INCONCLUSIVE');
  });

  it('flags an archived repository before anyone writes code', async () => {
    const github = fakeGitHub({
      repository: async () => ({
        host: 'github.com',
        owner: 'projectbharat',
        repo: 'datekit',
        fullName: 'projectbharat/datekit',
        defaultBranch: 'main',
        isFork: false,
        isArchived: true,
        isPrivate: false,
        htmlUrl: 'https://github.com/projectbharat/datekit',
        description: '',
        source: 'github-api',
      }),
    });
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(result.record.limitations.join(' ')).toMatch(/archived/);
  });
});

describe('runIntake — with a local clone', () => {
  it('prefers the local HEAD when the clone matches and sits on the default branch', async () => {
    const scripted = scriptedRunner(cleanCloneTable());
    const github = fakeGitHub({
      branchHead: () => {
        throw new AppError({ kind: 'network', message: 'should not be needed' });
      },
    });
    const result = await runIntake(
      { issueUrl: ISSUE_URL, repoPath: REPO_DIR },
      { github, run: scripted.run, store: memoryRunStore() },
    );

    expect(names(result)).toEqual([
      'Issue URL=PASS',
      'Local repository=PASS',
      'GitHub issue=PASS',
      'Repository=PASS',
      'Repository match=PASS',
      'Base commit=PASS',
      'Working tree=PASS',
      'Issue content trust=PASS',
    ]);
    expect(result.record.base).toMatchObject({ sha: GIT_MAIN_SHA, source: 'local-git' });
    expect(result.record.local).toMatchObject({ branch: 'main', isDirty: false });
    expect(result.record.outcome).toBe('INTAKE_COMPLETE');
    expect(github.calls).not.toContain('branchHead:projectbharat/datekit@main');
  });

  it('refuses to base a patch on a clone of the wrong repository', async () => {
    const scripted = scriptedRunner(
      cleanCloneTable('/repo/other', {
        'git -C': (args) => {
          const sub = args.slice(2).join(' ');
          const base = cleanCloneTable('/repo/other')['git -C'];
          if (sub.startsWith('config --get remote.origin.url')) {
            return { code: 0, stdout: 'https://github.com/someone/else.git\n', stderr: '' };
          }
          return typeof base === 'function'
            ? base(args)
            : { code: 1, stdout: '', stderr: 'no handler' };
        },
      }),
    );
    const remoteSha = 'a'.repeat(40);
    const github = fakeGitHub({
      branchHead: async () => ({
        sha: remoteSha,
        shortSha: remoteSha.slice(0, 10),
        source: 'github-api',
      }),
    });
    const result = await runIntake(
      { issueUrl: ISSUE_URL, repoPath: REPO_DIR },
      { github, run: scripted.run, store: memoryRunStore() },
    );

    expect(statusOf(result, 'Repository match')).toBe('FAIL');
    expect(detailOf(result, 'Repository match')).toContain('someone/else');
    expect(result.record.base).toEqual({
      sha: remoteSha,
      shortSha: remoteSha.slice(0, 10),
      source: 'github-api',
    });
    expect(result.record.limitations.join(' ')).toMatch(/will not use it as the base/i);
  });

  it('falls back to the remote default branch when the clone is on another branch', async () => {
    const scripted = scriptedRunner({
      ...cleanCloneTable(),
      'git -C': (args) => {
        const sub = args.slice(2).join(' ');
        if (sub.startsWith('rev-parse --abbrev-ref HEAD'))
          return { code: 0, stdout: 'wip-thing\n', stderr: '' };
        const base = cleanCloneTable()['git -C'];
        return typeof base === 'function'
          ? base(args)
          : { code: 1, stdout: '', stderr: 'no handler' };
      },
    });
    const result = await runIntake(
      { issueUrl: ISSUE_URL, repoPath: REPO_DIR },
      { github: fakeGitHub(), run: scripted.run, store: memoryRunStore() },
    );
    expect(result.record.base).toMatchObject({ source: 'github-api' });
    expect(result.record.limitations.join(' ')).toMatch(/Local checkout is on 'wip-thing'/);
  });

  it('records a dirty tree without touching it', async () => {
    const lines = ' M src/index.ts\n?? scratch.txt\n';
    const scripted = scriptedRunner({
      ...cleanCloneTable(),
      'git -C': (args) => {
        const sub = args.slice(2).join(' ');
        if (sub.startsWith('status --porcelain')) return { code: 0, stdout: lines, stderr: '' };
        const base = cleanCloneTable()['git -C'];
        return typeof base === 'function'
          ? base(args)
          : { code: 1, stdout: '', stderr: 'no handler' };
      },
    });
    const result = await runIntake(
      { issueUrl: ISSUE_URL, repoPath: REPO_DIR },
      { github: fakeGitHub(), run: scripted.run, store: memoryRunStore() },
    );
    expect(statusOf(result, 'Working tree')).toBe('WARN');
    expect(detailOf(result, 'Working tree')).toContain('2 uncommitted change');
    expect(result.record.local).toMatchObject({ isDirty: true, dirtyCount: 2 });
  });

  it('uses the clone for repository facts when GitHub is unreachable', async () => {
    const github = fakeGitHub({
      repository: () => {
        throw new AppError({
          kind: 'network',
          message: 'connection reset by github.com',
          retryable: true,
        });
      },
    });
    const result = await runIntake(
      { issueUrl: ISSUE_URL, repoPath: REPO_DIR },
      { github, run: scriptedRunner(cleanCloneTable()).run, store: memoryRunStore() },
    );
    expect(statusOf(result, 'Repository')).toBe('WARN');
    expect(detailOf(result, 'Repository')).toContain('used local clone');
    expect(result.record.repository).toMatchObject({ source: 'local-git', isArchived: null });
    expect(result.record.limitations.join(' ')).toMatch(/Fork\/archived\/private/);
  });

  it('reports a bad --repo path as a failed check, not a crash', async () => {
    const scripted = scriptedRunner({});
    const result = await runIntake(
      { issueUrl: ISSUE_URL, repoPath: '/definitely/not/here-xyz-merge-sutra' },
      { github: fakeGitHub(), run: scripted.run, store: memoryRunStore() },
    );
    expect(statusOf(result, 'Local repository')).toBe('FAIL');
    expect(detailOf(result, 'Local repository')).toContain('no such directory');
    expect(result.record.outcome).toBe('INTAKE_COMPLETE');
  });

  it('works from a local clone alone and says the contract cannot be derived yet', async () => {
    const result = await runIntake(
      { repoPath: REPO_DIR },
      { github: fakeGitHub(), run: scriptedRunner(cleanCloneTable()).run, store: memoryRunStore() },
    );
    expect(names(result)).toEqual([
      'Issue URL=SKIP',
      'Local repository=PASS',
      'Repository=PASS',
      'Base commit=PASS',
      'Working tree=PASS',
    ]);
    expect(result.record.outcome).toBe('INCONCLUSIVE');
    expect(result.record.issue).toBeNull();
    expect(result.record.issueRef).toBeNull();
    expect(result.record.limitations.join(' ')).toMatch(/issue url is required/i);
    expect(detailOf(result, 'Repository')).toContain('via local clone');
  });
});

describe('runIntake — untrusted issue content', () => {
  it('warns about an adversarial issue body and still imports it as data', async () => {
    const github = fakeGitHub({ issue: async () => toIssueDocument(adversarialIssuePayload) });
    const scripted = scriptedRunner(cleanCloneTable());
    const result = await runIntake(
      { issueUrl: 'https://github.com/projectbharat/datekit/issues/999', repoPath: REPO_DIR },
      { github, run: scripted.run, store: memoryRunStore() },
    );

    expect(statusOf(result, 'Issue content trust')).toBe('WARN');
    expect(result.record.issue?.injectionFindings.length).toBeGreaterThan(0);
    expect(detailOf(result, 'Issue content trust')).toMatch(
      /pattern\(s\) treated as data, not authority/,
    );
    // The check reports that the body is hostile, it does not reprint the body.
    expect(result.checks.every((c) => c.detail.length < 400)).toBe(true);
    expect(scripted.calls.every((c) => c.file === 'git')).toBe(true);
  });

  it('hashes the whole body even when the stored copy was truncated', async () => {
    const huge = { ...adversarialIssuePayload, body: 'x'.repeat(60_000) };
    const github = fakeGitHub({ issue: async () => toIssueDocument(huge) });
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github, store: memoryRunStore() });
    expect(result.record.issue).toMatchObject({ wasTruncated: true, bodyLength: 60_000 });
    expect(result.record.issue?.body.length).toBeLessThan(60_000);
    expect(result.record.limitations.join(' ')).toMatch(/truncated/);
  });
});

describe('runIntake — the record is the report', () => {
  it('persists exactly what it returns', async () => {
    const store = memoryRunStore();
    const result = await runIntake({ issueUrl: ISSUE_URL }, { github: fakeGitHub(), store });
    const written = store.files.get(result.recordFile ?? '');
    expect(written).toBeDefined();
    expect(JSON.parse(written ?? 'null')).toEqual(result.record);
  });

  it('reports a save failure instead of pretending the run is resumable', async () => {
    const failing: RunStore = {
      async save() {
        throw new AppError({ kind: 'validation', message: 'disk full' });
      },
      async load() {
        throw new AppError({ kind: 'not-found', message: 'unreachable' });
      },
      async list() {
        return { runs: [], unreadable: [] };
      },
    };
    const result = await runIntake(
      { issueUrl: ISSUE_URL },
      { github: fakeGitHub(), store: failing },
    );
    expect(result.recordFile).toBeNull();
    expect(result.saveError).toContain('disk full');
    expect(result.record.outcome).toBe('INTAKE_COMPLETE');
  });

  it('stamps a deterministic run id from the injected clock and randomness', async () => {
    const result = await runIntake(
      { issueUrl: ISSUE_URL },
      {
        github: fakeGitHub(),
        store: memoryRunStore(),
        now: () => new Date('2026-02-03T04:05:06.000Z'),
        random: () => 0,
      },
    );
    expect(result.record.runId).toBe('run-20260203T040506Z-000000');
    expect(result.record.createdAt).toBe('2026-02-03T04:05:06.000Z');
  });
});
