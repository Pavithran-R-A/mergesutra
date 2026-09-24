import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import type { RunStore } from '../../src/state/run-store.js';
import type { RunRecord } from '../../src/state/run-record.js';
import { planBodyFor, scriptedClient, type ScriptedClient } from '../helpers/bharatcode.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';

/**
 * `mergesutra plan` is where a model's words first become something a reviewer
 * reads, so the CLI test is mostly about wording: the output must carry the
 * proposal without lending it authority it does not have.
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

function cli(
  argv: string[],
  prepared: { store: RunStore },
  c: ReturnType<typeof capture>,
  client: ScriptedClient,
  json = false,
  env: Record<string, string> = { PATH: '/usr/bin', NO_COLOR: '1' },
): Promise<number> {
  return run(['node', 'mergesutra', ...(json ? ['--json'] : []), ...argv], {
    write: c.write,
    writeErr: c.writeErr,
    env,
    plan: { store: prepared.store, now: () => NOW, random: () => 0.8, client },
  });
}

function labelled(text: string, name: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.startsWith(`${name}:`))
      ?.trim() ?? ''
  );
}

describe('mergesutra plan — the proposal a reviewer reads', () => {
  it('prints the plan, the model that answered, and the run it came from', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const c = capture();
    const client = scriptedClient([planBodyFor(prepared.criteria)]);
    const code = await cli(['plan'], prepared, c, client);

    expect(code).toBe(EXIT.OK);
    const text = c.text();
    expect(text).toContain('MergeSutra — implementation plan');
    expect(text).toContain('Reject empty date input at the parser boundary.');
    expect(text).toContain('src/parse.ts');
    expect(text).toContain('npm test');
    expect(labelled(text, 'Model')).toContain('bharatcode-test-model');
    expect(labelled(text, 'From run')).toContain(prepared.record.runId);
    expect(text).toContain('PLAN_COMPLETE');
  });

  it('states that nothing was executed and no criterion moved', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const c = capture();
    await cli(['plan'], prepared, c, scriptedClient([planBodyFor(prepared.criteria)]));

    const text = c.text();
    expect(text).toContain('never run here');
    expect(text).toContain('Nothing here was executed, changed, or verified.');
    expect(text).toContain('Criterion statuses move only when evidence exists');
    expect(text).toContain('planning runs nothing');
    expect(text).not.toMatch(/CONTRIBUTION_READY|tests passed|verified complete/i);
  });

  it('labels a model-proposed criterion as a claim, not a requirement', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const c = capture();
    await cli(
      ['plan'],
      prepared,
      c,
      scriptedClient([
        {
          ...planBodyFor(prepared.criteria),
          proposedCriteria: [
            {
              statement: 'Blank strings are rejected too.',
              requirementType: 'compatibility',
              reason: '"empty" usually means blank as well.',
            },
          ],
        },
      ]),
    );

    expect(c.text()).toContain('MODEL CLAIM, not requirements');
    expect(c.text()).toContain('Blank strings are rejected too.');
  });

  it('exits INCONCLUSIVE and keeps the refusal in the record when the answer is rejected', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const broken = { ...planBodyFor(prepared.criteria), status: 'PASS' };
    const c = capture();
    const code = await cli(['plan'], prepared, c, scriptedClient([broken, broken]));

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(c.text()).toContain('No plan was stored');
    expect(c.text()).toContain('What this plan does not establish');
    expect(c.text()).not.toContain('Reject empty date input');
  });

  it('--json carries the plan and the same honest exit code', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const c = capture();
    const code = await cli(
      ['plan'],
      prepared,
      c,
      scriptedClient([planBodyFor(prepared.criteria)]),
      true,
    );

    expect(code).toBe(EXIT.OK);
    const payload = JSON.parse(c.text()) as { record: RunRecord };
    expect(payload.record.outcome).toBe('PLAN_COMPLETE');
    expect(payload.record.plan?.provenance.model).toBe('bharatcode-test-model');
    expect(payload.record.plan?.untrusted).toBe(true);
  });

  it('refuses before the network when the run has no Acceptance Contract', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const stageTwo = [...prepared.store.files.values()]
      .map((text) => JSON.parse(text) as RunRecord)
      .find((record) => record.stage === 'inspect');
    if (!stageTwo) throw new Error('fixture produced no Stage 2 record');

    const c = capture();
    const client = scriptedClient([]);
    const code = await cli(['plan', stageTwo.runId], prepared, c, client);

    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toContain('no Acceptance Contract');
    expect(client.calls).toHaveLength(0);
  });

  it('reports a missing credential as configuration, and never echoes it', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const c = capture();
    const code = await run(['node', 'mergesutra', 'plan', prepared.record.runId], {
      write: c.write,
      writeErr: c.writeErr,
      env: { PATH: '/usr/bin', NO_COLOR: '1' },
      plan: { store: prepared.store, now: () => NOW, random: () => 0.8 },
    });

    expect(code).toBe(EXIT.CONFIG);
    expect(c.errorText()).toContain('BHARATCODE_API_KEY');
    expect(c.errorText()).not.toContain('sk-');
  });

  it('is a working command now, not a planned one', async () => {
    const c = capture();
    const help = await run(['node', 'mergesutra', '--help'], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    expect(help).toBe(0);
    expect(c.text()).toContain('plan [run-id]');
    expect(c.text()).not.toContain('BharatCode implementation plan. (planned)');
    // The stages after it must still be labelled as unbuilt.
    expect(c.text()).toContain('Implement in an isolated worktree (BharatCode).');
    expect(c.text()).toContain('(planned)');
  });
});
