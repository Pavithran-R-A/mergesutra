import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { AppError } from '../../src/core/errors.js';
import type { RunRecord } from '../../src/state/run-record.js';
import type { ImplementStageDeps } from '../../src/implement/implement.js';
import {
  checkAction,
  cleanUp,
  finishAction,
  implementHarness,
  readAction,
  writeAction,
  type StageHarness,
  type StageHarnessOptions,
} from '../helpers/implement.js';
import { scriptedClient } from '../helpers/bharatcode.js';

/**
 * `mergesutra implement` — the command where a model's choice becomes a byte on
 * disk, judged here purely as output.
 *
 * The stage's own suite proves the boundaries hold. This one proves the
 * *reporting* holds: that a reader who never opens the record cannot walk away
 * thinking a criterion passed, that a refusal is printed as a refusal, and that
 * a mistyped budget fails before a worktree is created or a paid request is
 * made. Those are the two ways this command could mislead while every internal
 * invariant stayed correct.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
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

function harness(
  answers: readonly (string | unknown)[],
  options: StageHarnessOptions = {},
): Promise<StageHarness> {
  return implementHarness(tempDirs, answers, options);
}

async function cli(
  stage: StageHarness,
  args: string[],
  c: ReturnType<typeof capture>,
  deps: Partial<ImplementStageDeps> = stage.deps,
  env: Record<string, string> = { PATH: '/usr/bin', NO_COLOR: '1' },
): Promise<number> {
  return run(['node', 'mergesutra', ...args], {
    write: c.write,
    writeErr: c.writeErr,
    env,
    implement: deps,
  });
}

const argv = (stage: StageHarness, ...flags: string[]): string[] => [
  'implement',
  stage.runId,
  '--repo',
  stage.root,
  ...flags,
];

/** The row a named check produced, without its status column. */
function row(text: string, name: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.includes(name))
      ?.trim() ?? ''
  );
}

function labelled(text: string, name: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.startsWith(`${name}:`))
      ?.trim() ?? ''
  );
}

describe('mergesutra implement — what the reader is allowed to believe', () => {
  it('prints the budget, the workspace, and the bytes that actually changed', async () => {
    const stage = await harness([
      writeAction('src/guard.ts', 'export const guard = 1;\n', ['AC-1']),
      checkAction(['npm', 'test']),
      finishAction('Guard clause added.', ['AC-1']),
    ]);
    const c = capture();
    const code = await cli(stage, argv(stage), c);

    expect(code).toBe(EXIT.INCONCLUSIVE);
    const text = c.text();
    expect(text).toContain('MergeSutra — bounded implementation run');
    expect(labelled(text, 'Outcome')).toContain('IMPLEMENTED_BY_MODEL');
    expect(labelled(text, 'Loop status')).toContain('COMPLETED_BY_MODEL');
    expect(labelled(text, 'Model')).toContain('bharatcode-test-model');
    expect(labelled(text, 'Budget')).toMatch(/3\/12 steps/);
    expect(labelled(text, 'Budget')).toMatch(/1\/6 writes/);
    expect(labelled(text, 'Workspace')).toContain(`.mergesutra/worktrees/${stage.runId}`);
    expect(labelled(text, 'Workspace')).toContain(`mergesutra/${stage.runId}`);
    expect(text).toContain('Files written in this workspace');
    expect(text).toContain('src/guard.ts');
    // A digest, not the content: a reviewer can compare it against the worktree.
    expect(text).toMatch(/sha256 [0-9a-f]{64}/);
    expect(text).not.toContain('export const guard = 1');
    expect(labelled(text, 'Run record')).toContain('/runs/');
    expect(text).toContain(
      'BharatCode chose what to look at and what to write. MergeSutra decided what was allowed to run.',
    );
  });

  it('calls the model FINISH a claim, and never lets it read as a verdict', async () => {
    const stage = await harness([
      writeAction('src/guard.ts', 'export const guard = 1;\n', ['AC-1']),
      finishAction('Guard clause added.', ['AC-1']),
    ]);
    const c = capture();
    await cli(stage, argv(stage), c);
    const text = c.text();

    expect(text).toContain('Criteria the model claims');
    expect(text).toContain('believed complete: AC-1 — MODEL CLAIM, unverified');
    expect(text).toContain('no criterion changed status here');
    expect(row(text, 'Verification')).toContain('NOT_AVAILABLE');
    expect(row(text, 'Verification')).toContain('no criterion was verified');
    expect(row(text, 'Remote mutation')).toContain('NOT_AVAILABLE');
    expect(text).toContain(
      'Nothing here is verified: no criterion is PASS, and no push, pull request or comment was attempted.',
    );
    expect(text).not.toContain('CONTRIBUTION_READY');
    // The only PASS rows are MergeSutra's own gates, never a criterion id.
    for (const line of text.split('\n').filter((entry) => entry.includes('PASS'))) {
      expect(line).not.toMatch(/AC-\d/);
    }
  });

  it('prints a refusal as a refusal, and never leaks what it refused to read', async () => {
    const stage = await harness([
      checkAction(['git', 'push', 'origin', 'HEAD']),
      readAction('.env', 'load the key'),
      finishAction('Gave up.'),
    ]);
    const c = capture();
    await cli(stage, argv(stage), c);
    const text = c.text();

    expect(row(text, 'FAIL')).toContain('git push origin HEAD');
    expect(text).toContain('RUN_CHECK');
    expect(row(text, 'Refused actions')).toContain('WARN');
    expect(row(text, 'Refused actions')).toContain('2 action(s) refused');
    // Two refusals, and neither of them ran: the only program started was git,
    // and only for the workspace.
    expect([...new Set(stage.calls.map((call) => call[0]))]).toEqual(['git']);
    expect(text).not.toContain('sk-ws-SECRETVALUE');
    expect(text).not.toContain('BHARATCODE_API_KEY=');
  });

  it('says plainly when the loop stopped short of claiming anything', async () => {
    const stage = await harness([
      { action: 'BLOCKED', reason: 'the module the plan changes is not in this repository.' },
    ]);
    const c = capture();
    const code = await cli(stage, argv(stage), c);

    expect(code).toBe(EXIT.BLOCKED);
    expect(labelled(c.text(), 'Loop status')).toContain('BLOCKED');
    expect(c.text()).toContain(
      'none — the loop ended at MODEL_BLOCKED without a FINISH action, so nothing is claimed',
    );
    // The model's reason is printed, not swallowed: it is the useful half of the run.
    expect(c.text()).toContain('the module the plan changes is not in this repository');
    // A run that wrote nothing must not print a file list that looks like one.
    expect(c.text()).toContain('Files written in this workspace');
    expect(row(c.text(), 'Writes')).toContain('SKIP');
    expect(row(c.text(), 'Checks')).toContain('SKIP');
    expect(c.text()).toContain('Next stage:');
    expect(labelled(c.text(), 'Next stage')).toContain('mergesutra implement');
  });

  it('says so when a model never answered, and prints no actions it did not take', async () => {
    const stage = await harness([]);
    const unavailable = {
      ...scriptedClient([]),
      async complete() {
        throw new AppError({
          kind: 'server',
          status: 503,
          message: 'Model unavailable',
          retryable: true,
        });
      },
    };
    const c = capture();
    const code = await cli(stage, argv(stage), c, { ...stage.deps, client: unavailable });

    expect(code).toBe(EXIT.INCONCLUSIVE);
    const text = c.text();
    expect(text).toContain('nothing — the loop ended before an action ran');
    expect(labelled(text, 'Loop status')).toContain('INCONCLUSIVE');
    expect(row(text, 'Loop end')).toContain('MODEL_UNAVAILABLE');
    // A 503 is a stopped run, not a broken one: the workspace it made is named.
    expect(labelled(text, 'Workspace')).toContain(`.mergesutra/worktrees/${stage.runId}`);
    expect(text).not.toContain('MODEL CLAIM');
  });

  it('shows a revision the model asked for as a request that was not granted', async () => {
    const stage = await harness([
      {
        action: 'PROPOSE_CONTRACT_REVISION',
        criterionId: 'AC-1',
        previous: 'Empty input is rejected with a TypeError.',
        proposed: 'Empty input is accepted.',
        reason: 'the tests are easier this way',
        sourceEvidence: 'test/parse.test.ts line 3',
      },
      finishAction('Done after loosening the requirement.'),
    ]);
    const c = capture();
    await cli(stage, argv(stage), c);
    const text = c.text();

    expect(text).toContain('Revisions the model asked for (not applied)');
    expect(text).toContain('AC-1 (step 1)');
    expect(text).toContain('proposed: Empty input is accepted.');
    expect(text).toContain('a model cannot edit the criteria it is measured against');
    expect(row(text, 'Proposed revisions')).toContain('WARN');
    expect(row(text, 'Acceptance Contract')).toContain('no revision was applied');
  });

  it('--json carries the same record and the same honest exit code', async () => {
    const stage = await harness([
      writeAction('src/guard.ts', 'export const guard = 1;\n', ['AC-1']),
      finishAction('Guard clause added.', ['AC-1']),
    ]);
    const c = capture();
    const code = await cli(stage, ['--json', ...argv(stage)], c);

    expect(code).toBe(EXIT.INCONCLUSIVE);
    const payload = JSON.parse(c.text()) as { recordFile: string; record: RunRecord };
    expect(payload.recordFile).toBe(`/runs/${stage.runId}.json`);
    expect(payload.record.outcome).toBe('IMPLEMENTED_BY_MODEL');
    expect(payload.record.stage).toBe('implement');
    expect(payload.record.implementation?.finishClaim?.criteriaBelievedComplete).toEqual(['AC-1']);
    expect(payload.record.implementation?.verified).toBe(false);
    expect(payload.record.implementation?.contractUntouched).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('CONTRIBUTION_READY');
    // JSON, not colour: a pipe must not carry escape codes.
    expect(c.text()).not.toContain('\u001b[');
  });

  it('enables colour by explicit request and honors NO_COLOR', async () => {
    const quiet = async (env: Record<string, string>): Promise<string> => {
      const stage = await harness([finishAction()]);
      const c = capture();
      await cli(stage, argv(stage), c, stage.deps, env);
      return c.text();
    };

    expect(await quiet({ PATH: '/usr/bin', FORCE_COLOR: '1' })).toContain('\u001b[1m');
    const plain = await quiet({ PATH: '/usr/bin', NO_COLOR: '1', FORCE_COLOR: '1' });
    expect(plain).not.toContain('\u001b[');
    expect(plain).toContain('MergeSutra — bounded implementation run');
  });
});

describe('mergesutra implement — what must fail before anything is spent', () => {
  it('rejects a budget outside the ceiling before a worktree exists or a model is asked', async () => {
    for (const [flag, value, ceiling] of [
      ['--max-steps', '999', '40'],
      ['--max-writes', '21', '20'],
      ['--max-commands', '0', '15'],
      ['--max-steps', 'soon', '40'],
    ] as const) {
      const stage = await harness([finishAction()]);
      const c = capture();
      const code = await cli(stage, argv(stage, flag, value), c);

      expect(code).toBe(EXIT.ERROR);
      expect(c.errorText()).toContain(flag);
      expect(c.errorText()).toContain(ceiling);
      expect(c.errorText()).toContain('unbounded agent');
      // The point of validating first: nothing downstream happened.
      expect(stage.client.calls).toEqual([]);
      expect(stage.calls).toEqual([]);
    }
  });

  it('refuses a run with no Acceptance Contract, and says which command to run', async () => {
    const stage = await harness([finishAction()]);
    const inspectOnly = [...stage.store.files.values()]
      .map((text) => JSON.parse(text) as RunRecord)
      .find((record) => record.stage === 'inspect');
    if (!inspectOnly) throw new Error('fixture produced no Stage 2 record');

    const c = capture();
    const code = await cli(stage, ['implement', inspectOnly.runId, '--repo', stage.root], c);

    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toContain('no Acceptance Contract');
    expect(c.errorText()).toContain('mergesutra contract');
    expect(stage.client.calls).toEqual([]);
    expect(stage.calls).toEqual([]);
  });

  it('reports a missing credential as configuration, and never echoes a value', async () => {
    const stage = await harness([finishAction()]);
    const c = capture();
    // The client is the one dependency not supplied, so the real one is built
    // from an environment that has no key in it.
    const code = await cli(
      stage,
      argv(stage),
      c,
      { ...stage.deps, client: undefined, env: {} },
      { PATH: '/usr/bin', NO_COLOR: '1' },
    );

    expect(code).toBe(EXIT.CONFIG);
    expect(c.errorText()).toContain('BHARATCODE_API_KEY');
    expect(c.errorText()).not.toContain('sk-');
    // The configuration check comes first: no worktree, no model request.
    expect(stage.calls).toEqual([]);
    expect(stage.client.calls).toEqual([]);
  });

  it('leaves the worktree alone when the workspace would dirty the checkout', async () => {
    const stage = await harness([finishAction()], {
      refuseGit: (a) =>
        a.slice(2).join(' ').startsWith('check-ignore')
          ? { code: 1, stdout: '', stderr: '' }
          : null,
    });
    const c = capture();
    const code = await cli(stage, argv(stage), c);

    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toContain('not git-ignored');
    expect(c.errorText()).toContain('Add `.mergesutra/` to the repository .gitignore');
    expect(c.out).toEqual([]);
    expect(stage.client.calls).toEqual([]);
  });
});

describe('mergesutra implement — the commands around it', () => {
  it('is a working command, while the stages after it stay labelled as planned', async () => {
    const c = capture();
    const help = await run(['node', 'mergesutra', '--help'], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    expect(help).toBe(EXIT.OK);
    const text = c.text().replace(/\s+/g, ' ');
    expect(text).toContain('implement [options] [run-id]');
    expect(text).toContain('BharatCode proposes actions, MergeSutra executes the allowed ones');
    expect(text).not.toContain('allowed ones (planned)');
    expect(text).toContain('verify [options] [run-id]');
    expect(text).not.toContain('receipts record (planned)');
    expect(text).toContain('Unattended end-to-end pipeline across all stages. (planned)');
  });

  it('documents the budget it will enforce, including the ceiling', async () => {
    const c = capture();
    const help = await run(['node', 'mergesutra', 'implement', '--help'], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    expect(help).toBe(EXIT.OK);
    const text = c.text().replace(/\s+/g, ' ');
    expect(text).toContain('--max-steps <n>');
    expect(text).toContain('turn budget (1-40)');
    expect(text).toContain('--max-writes <n>');
    expect(text).toContain('--max-commands <n>');
    expect(text).toContain('--repo <path>');
    expect(text).toContain('--model <id>');
  });

  it('exits PLANNED for the pipeline commands that do not exist yet', async () => {
    // `pr` left this list at Stage 10: it is a wired command now, and
    // tests/cli/program.test.ts is what proves it no longer says "planned".
    for (const command of ['run']) {
      const stage = await harness([finishAction()]);
      const c = capture();
      const code = await cli(stage, [command], c);

      expect(code).toBe(EXIT.PLANNED);
      expect(c.text()).toContain(`'${command}' is planned, not yet implemented`);
      expect(c.text()).toContain('doctor, issue (intake), inspect, contract, plan, implement');
      // A planned command spends nothing: no model call, no git, no worktree.
      expect(stage.client.calls).toEqual([]);
      expect(stage.calls).toEqual([]);
    }
  });

  it('refuses to describe an unbuilt verification as a result', async () => {
    const stage = await harness([finishAction('Everything passes now.')]);
    const c = capture();
    await cli(stage, argv(stage), c);
    const text = c.text();

    expect(text).not.toMatch(/all tests pass|verified complete|ready to merge/i);
    expect(text).toContain('mergesutra verify');
    expect(text).toContain('is what will judge them');
  });
});
