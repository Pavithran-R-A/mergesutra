import type { GitHubSource } from '../../src/github/gh-client.js';
import type {
  CommitRef,
  IssueDocument,
  RepositoryContext,
  RepositoryIdentity,
} from '../../src/github/types.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import type { RunResult, Runner } from '../../src/core/runner.js';
import type { RunRecord } from '../../src/state/run-record.js';
import type { RunStore } from '../../src/state/run-store.js';
import { AppError } from '../../src/core/errors.js';
import { commitPayload, issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';

/**
 * Offline stand-ins for the outside world.
 *
 * Nothing in the test suite talks to GitHub or spawns a real `gh`: the fake
 * source returns validated fixture payloads, and the scripted runner answers
 * `git`/`gh` invocations from a table so argv can be asserted directly.
 */

export const TEST_REPO: RepositoryContext = {
  host: 'github.com',
  owner: 'projectbharat',
  repo: 'datekit',
};

export const ISSUE_URL = 'https://github.com/projectbharat/datekit/issues/123';

export interface FakeGitHubOptions {
  readonly repository?: () => Promise<RepositoryIdentity>;
  readonly issue?: () => Promise<IssueDocument>;
  readonly branchHead?: () => Promise<CommitRef>;
}

export function fakeGitHub(options: FakeGitHubOptions = {}): GitHubSource & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async repository(ctx) {
      calls.push(`repository:${ctx.owner}/${ctx.repo}`);
      return options.repository?.() ?? toRepositoryIdentity(repositoryPayload, TEST_REPO);
    },
    async issue(ctx) {
      calls.push(`issue:${ctx.owner}/${ctx.repo}#${ctx.number}`);
      return options.issue?.() ?? toIssueDocument(issuePayload);
    },
    async branchHead(ctx) {
      calls.push(`branchHead:${ctx.owner}/${ctx.repo}@${ctx.branch}`);
      return (
        options.branchHead?.() ?? {
          sha: commitPayload.sha,
          shortSha: commitPayload.sha.slice(0, 10),
          source: 'github-api',
        }
      );
    },
  };
}

export type ScriptTable = Record<string, RunResult | ((args: readonly string[]) => RunResult)>;

export const ok = (stdout: string, stderr = ''): RunResult => ({ code: 0, stdout, stderr });
export const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });

export interface ScriptedRun {
  readonly run: Runner;
  readonly calls: { file: string; args: readonly string[] }[];
}

/** A Runner that records every argv and answers from `table`, first prefix match wins. */
export function scriptedRunner(table: ScriptTable): ScriptedRun {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: Runner = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args.join(' ')}`;
    for (const [pattern, result] of Object.entries(table)) {
      if (key.startsWith(pattern)) {
        return typeof result === 'function' ? result(args) : result;
      }
    }
    return fail(`${file}: unexpected invocation '${key}'`);
  };
  return { run, calls };
}

export const GIT_MAIN_SHA = '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182';

export interface MemoryRunStore extends RunStore {
  readonly files: Map<string, string>;
}

/**
 * A run store that keeps records in memory so tests never touch a real disk.
 *
 * `load` is keyed by run id and `list` sorts newest-first, the same contract the
 * file store promises — a stage that resumes from a previous run can be tested
 * against it without a fake that quietly ignores the id it was given.
 */
export function memoryRunStore(): MemoryRunStore {
  const files = new Map<string, string>();
  const records = new Map<string, RunRecord>();
  return {
    files,
    async save(record) {
      const file = `/runs/${record.runId}.json`;
      records.set(record.runId, record);
      files.set(file, JSON.stringify(record, null, 2));
      return file;
    },
    async load(runId) {
      const record = records.get(runId);
      if (!record) {
        throw new AppError({ kind: 'not-found', message: `No run record '${runId}'.` });
      }
      return record;
    },
    async list() {
      const runs = [...records.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .map((record) => ({
          runId: record.runId,
          createdAt: record.createdAt,
          outcome: record.outcome,
          canonical: record.issueRef?.canonical ?? '(no issue)',
          file: `/runs/${record.runId}.json`,
        }));
      return { runs, unreadable: [] };
    },
  };
}

/** A clean clone of projectbharat/datekit on main at GIT_MAIN_SHA. */
export function cleanCloneTable(
  toplevel = '/repo/datekit',
  overrides: ScriptTable = {},
): ScriptTable {
  const base: ScriptTable = {
    'git -C': (args) => {
      const sub = args.slice(2).join(' ');
      switch (true) {
        case sub.startsWith('rev-parse --is-inside-work-tree'):
          return ok('true\n');
        case sub.startsWith('rev-parse --is-bare-repository'):
          return ok('false\n');
        case sub.startsWith('rev-parse --show-toplevel'):
          return ok(toplevel + '\n');
        case sub.startsWith('rev-parse HEAD'):
          return ok(GIT_MAIN_SHA + '\n');
        case sub.startsWith('rev-parse --abbrev-ref HEAD'):
          return ok('main\n');
        case sub.startsWith('rev-parse --path-format'):
          return ok(toplevel + '/.git\n');
        case sub.startsWith('status --porcelain'):
          return ok('');
        case sub.startsWith('config --get remote.origin.url'):
          return ok('https://github.com/projectbharat/datekit.git\n');
        case sub.startsWith('symbolic-ref'):
          return ok('origin/main\n');
        case sub.startsWith('--version'):
          return ok('git version 2.55.0.windows.5\n');
        default:
          return fail(`unexpected git invocation: ${sub}`);
      }
    },
  };
  return { ...base, ...overrides };
}
