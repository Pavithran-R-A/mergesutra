import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import { formatIntake, issueAction } from '../../src/cli/issue.js';
import { runIntake } from '../../src/intake/intake.js';
import { createRenderer } from '../../src/cli/render.js';
import { AppError } from '../../src/core/errors.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import {
  GIT_MAIN_SHA,
  ISSUE_URL,
  cleanCloneTable,
  fakeGitHub,
  memoryRunStore,
  scriptedRunner,
} from '../helpers/github.js';

/**
 * The terminal is a product surface, so these assert what a reviewer reads:
 * the outcome word, the exit code, and the absence of anything that was never
 * established — a diff, a verdict, an issue body, a credential.
 */

const SENSITIVE_KEY = 'sk-issuecmd-SECRETVALUE-000';

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
  c: ReturnType<typeof capture>,
  deps = {},
  env: Record<string, string> = {},
) {
  return run(['node', 'mergesutra', ...argv], {
    write: c.write,
    writeErr: c.writeErr,
    env: { PATH: '/usr/bin', NO_COLOR: '1', BHARATCODE_API_KEY: SENSITIVE_KEY, ...env },
    ...deps,
  });
}

describe('mergesutra issue — rendered output', () => {
  it('prints the checks it actually ran and exits 0 on a complete intake', async () => {
    const c = capture();
    const code = await cli(['issue', ISSUE_URL], c, {
      issue: {
        github: fakeGitHub(),
        store: memoryRunStore(),
        run: scriptedRunner({}).run,
        now: () => new Date('2026-09-24T21:32:07.000Z'),
        random: () => 0.25,
      },
    });
    const text = c.text();
    expect(code).toBe(EXIT.OK);
    expect(text).toContain('MergeSutra — intake');
    expect(text).toContain('Issue URL');
    expect(text).toContain('Base commit');
    expect(text).toContain('Outcome:      INTAKE_COMPLETE');
    expect(text).toContain(GIT_MAIN_SHA);
    expect(text).toContain('run-20260924T213207Z-3fffff');
    expect(text).toContain('Stage 2');
  });

  it('says plainly what this command did not do', async () => {
    const c = capture();
    await cli(['issue', ISSUE_URL], c, {
      issue: { github: fakeGitHub(), store: memoryRunStore(), run: scriptedRunner({}).run },
    });
    const text = c.text();
    expect(text).toContain(
      'Stages implemented: 0 (foundation), 1 (intake), 2 (repository contract), 3 (acceptance contract).',
    );
    expect(text).toContain('No patch, verification, review or pull request was produced');
    expect(text).not.toMatch(/CONTRIBUTION_READY|diff submitted|tests passed/i);
  });

  it('imports the issue as data instead of printing its body', async () => {
    const c = capture();
    await cli(['issue', ISSUE_URL], c, {
      issue: { github: fakeGitHub(), store: memoryRunStore(), run: scriptedRunner({}).run },
    });
    expect(c.text()).not.toContain('Happy reviewing!');
    expect(c.text()).not.toContain('## Problem');
    expect(c.text()).toContain('Issue text was imported as data');
  });

  it('never echoes a credential, even when a failure message contains one', async () => {
    const c = capture();
    const code = await cli(['issue', ISSUE_URL], c, {
      issue: {
        github: fakeGitHub({
          issue: () => {
            throw new AppError({
              kind: 'auth',
              message: `Bearer ${SENSITIVE_KEY} was rejected by github.com`,
            });
          },
        }),
        store: memoryRunStore(),
        run: scriptedRunner({}).run,
      },
    });
    const all = c.text() + c.errorText();
    expect(code).toBe(EXIT.BLOCKED);
    expect(all).not.toContain(SENSITIVE_KEY);
    expect(all).not.toContain('sk-issuecmd');
  });

  it('reports a save failure rather than implying the run can be resumed', async () => {
    const c = capture();
    await cli(['issue', ISSUE_URL], c, {
      issue: {
        github: fakeGitHub(),
        store: {
          async save() {
            throw new AppError({ kind: 'validation', message: 'run directory is read-only' });
          },
          async load(): Promise<never> {
            throw new AppError({ kind: 'not-found', message: 'unused' });
          },
          async list() {
            return { runs: [], unreadable: [] };
          },
        },
        run: scriptedRunner({}).run,
      },
    });
    expect(c.text()).toContain('Run record:   not written — run directory is read-only');
  });
});

describe('mergesutra issue — exit codes', () => {
  it('exits BLOCKED (4) when the issue itself could not be read', async () => {
    const c = capture();
    const code = await cli(['issue', ISSUE_URL], c, {
      issue: {
        github: fakeGitHub({
          issue: () => {
            throw new AppError({
              kind: 'not-found',
              message: 'GitHub has no issue projectbharat/datekit#123 visible to this account.',
              remediation: 'Check the URL, or run `gh auth status`.',
            });
          },
        }),
        store: memoryRunStore(),
        run: scriptedRunner({}).run,
      },
    });
    expect(code).toBe(EXIT.BLOCKED);
    expect(c.text()).toContain('Outcome:      BLOCKED');
    expect(c.text()).toMatch(/FAIL\s+GitHub issue/);
  });

  it('exits INCONCLUSIVE (3) for a clone-only run that cannot form a contract', async () => {
    const c = capture();
    const code = await cli(['issue', '--repo', process.cwd()], c, {
      issue: {
        github: fakeGitHub(),
        store: memoryRunStore(),
        run: scriptedRunner(cleanCloneTable()).run,
      },
    });
    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(c.text()).toContain('Outcome:      INCONCLUSIVE');
    expect(c.text()).toMatch(/SKIP\s+Issue URL/);
  });

  it('exits 1 with a single clean error for a host MergeSutra will not talk to', async () => {
    const c = capture();
    const code = await cli(['issue', 'https://evil.example/a/b/issues/1'], c, {
      issue: { github: fakeGitHub(), store: memoryRunStore() },
    });
    expect(code).toBe(EXIT.ERROR);
    expect(c.text()).toBe('');
    expect(c.errorText()).toContain('error:');
    expect(c.errorText()).toMatch(/github\.com/);
  });

  it('exits 1 and explains itself when called with nothing to intake', async () => {
    const c = capture();
    const code = await cli(['issue'], c, {
      issue: { github: fakeGitHub(), store: memoryRunStore() },
    });
    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toContain('Nothing to intake');
    expect(c.errorText()).toContain('mergesutra issue https://');
  });
});

describe('mergesutra issue --json', () => {
  it('emits exactly one parseable document containing the persisted record', async () => {
    const c = capture();
    const store = memoryRunStore();
    const code = await cli(['issue', ISSUE_URL, '--json'], c, {
      issue: { github: fakeGitHub(), store, run: scriptedRunner({}).run },
    });
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(c.text()) as {
      recordFile: string;
      record: { outcome: string; checks: unknown[]; issue: { number: number } | null };
    };
    expect(parsed.record.outcome).toBe('INTAKE_COMPLETE');
    expect(parsed.record.issue?.number).toBe(123);
    expect(parsed.record.checks.length).toBeGreaterThan(3);
    expect(parsed.recordFile).toContain('run-');
  });

  it('carries the issue as marked-untrusted data and never a credential', async () => {
    const c = capture();
    await cli(['issue', ISSUE_URL, '--json'], c, {
      issue: { github: fakeGitHub(), store: memoryRunStore(), run: scriptedRunner({}).run },
    });
    const text = c.text();
    expect(text).not.toContain(SENSITIVE_KEY);
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text.toLowerCase()).not.toContain('bharatcode_api_key');
    // The record is the resumption source, so it keeps the body it read — but it
    // keeps it labelled as data, next to the hash that proves it whole.
    const parsed = JSON.parse(text) as {
      record: { issue: { untrusted: boolean; bodySha256: string } };
    };
    expect(parsed.record.issue.untrusted).toBe(true);
    expect(parsed.record.issue.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('issueAction', () => {
  it('returns the outcome-derived code without writing when colours are on', async () => {
    const c = capture();
    const code = await issueAction(
      ISSUE_URL,
      { env: { NO_COLOR: '1' } },
      { github: fakeGitHub(), store: memoryRunStore(), run: scriptedRunner({}).run },
      c.write,
    );
    expect(code).toBe(EXIT.OK);
    expect(c.text()).not.toContain('\u001b[');
  });

  it('honours --no-color even when the environment has no NO_COLOR', async () => {
    const c = capture();
    await cli(
      ['--no-color', 'issue', ISSUE_URL],
      c,
      {
        issue: { github: fakeGitHub(), store: memoryRunStore(), run: scriptedRunner({}).run },
      },
      { NO_COLOR: '' },
    );
    expect(c.text()).not.toContain('\u001b[');
    expect(c.text()).toContain('Outcome:      INTAKE_COMPLETE');
  });
});

describe('formatIntake', () => {
  it('renders a repository it could not establish as NOT_AVAILABLE', async () => {
    const result = await runIntake(
      { issueUrl: ISSUE_URL },
      {
        github: fakeGitHub({
          repository: () => {
            throw new AppError({ kind: 'auth', message: 'gh is not authenticated' });
          },
          branchHead: () => {
            throw new AppError({ kind: 'auth', message: 'gh is not authenticated' });
          },
        }),
        store: memoryRunStore(),
      },
    );
    const text = formatIntake(result, createRenderer({ color: false }));
    expect(text).toContain('Repository:   NOT_AVAILABLE');
    expect(text).toContain('Base commit:  NOT_AVAILABLE');
    expect(text).toContain('Local clone:  NOT_AVAILABLE');
    expect(text).toContain('Outcome:      INCONCLUSIVE');
  });
});
