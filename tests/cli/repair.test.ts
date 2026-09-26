import { afterAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { run } from '../../src/cli/program.js';
import type { RepairStageDeps } from '../../src/repair/stage.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import {
  GRANTED_AT,
  parserOf,
  REPAIRED,
  repairedAnswers,
  reviewedRun,
  type RepairFixture,
} from '../helpers/repairRun.js';
import { cleanUp, hasGit, put, NOW } from '../helpers/verifyRun.js';

/**
 * `mergesutra repair [run-id]` — Stage 9R judged as output.
 *
 * A command that edits a repository has one job beyond doing the edit correctly:
 * never letting a terminal reading look like an authorisation. So the flag surface
 * is the finding here. There is exactly one way to say yes — `--approve-plan
 * <digest>`, the digest of the plan that was frozen before any edit — and there is
 * deliberately no flag that says yes in advance: no `--yes`, no `--force`, no
 * `--approve-all`, because a repair whose consent can be typed before the plan is
 * read is not consented to.
 *
 * The other job is not overclaiming in the other direction. A cycle that ran exits
 * 3, not 0, because the bytes it left have to be verified by a round that has not
 * happened yet; and a run that only got as far as showing its plan leaves the
 * record and the workspace exactly as they were, which is asserted here by
 * measuring both afterwards rather than by trusting what was printed.
 *
 * These tests drive the same fixture as the stage's own suite — a real Git
 * workspace, Stage 7 run twice so the consent on file is one the product derived —
 * because the command must not have a softer path to the transition than the
 * module does. Only the model is scripted; nothing here holds a credential.
 */

vi.setConfig({ testTimeout: 90_000 });

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

/** Git-Bash-reported paths and Node's separators differ on Windows; compare one form. */
function slashes(text: string): string {
  return text.split('\\').join('/');
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

async function aRun(options: { reviewCycle?: number } = {}): Promise<RepairFixture> {
  const fixture = await reviewedRun(made, options);
  return fixture;
}

function depsFor(
  fixture: RepairFixture,
  client: RepairStageDeps['client'],
): Partial<RepairStageDeps> {
  return {
    store: fixture.store,
    client,
    now: () => NOW,
    runsRoot: fixture.runsRoot,
    runFor: fixture.runFor,
    cwd: fixture.workspace,
  };
}

describe.skipIf(!AVAILABLE)('mergesutra repair', () => {
  it('says the plan it would execute and the exact approval it needs, and does nothing', async () => {
    const fixture = await aRun();
    const io = capture();
    const client = scriptedClient([]);

    const code = await run(
      ['node', 'mergesutra', 'repair', fixture.record.runId, '--repo', fixture.workspace],
      { ...io, env: {}, repair: depsFor(fixture, client) },
    );

    const text = io.text();
    expect(text).toContain(repairPlanDigest(fixture.plan));
    expect(text).toMatch(/--approve-plan/);
    expect(text).toContain('src/parse.ts');
    expect(text).toMatch(/Nothing was edited/);
    // A command that edits must not print a completion word it has not earned. What
    // is banned is the verdict, not the phrase: Stage 7's own next-stage wording
    // ("nothing in this record calls the contribution ready") is carried here
    // verbatim, and it is a denial — removing it would make the screen less true.
    expect(text).not.toMatch(/CONTRIBUTION_READY/);
    expect(text).not.toMatch(/^Outcome\s+.*(APPROVED|READY|COMPLETE|PASS)\b/im);
    expect(text.toLowerCase()).not.toMatch(/ready to ship|repair complete|this run is ready/);
    expect(text).toMatch(/Next\s+REVIEW/);
    expect(client.calls).toHaveLength(0);
    // The run is where `review` left it: no cycle filed, no pack rewritten.
    expect((await fixture.store.load(fixture.record.runId)).repairExecutions).toEqual([]);
    expect(await parserOf(fixture.workspace)).not.toBe(REPAIRED);
    expect(code).toBe(EXIT.INCONCLUSIVE);
  });

  it('needs no credential to show a plan, because showing one asks nothing of a model', async () => {
    const fixture = await aRun();
    const io = capture();

    // No `client` dep and an empty environment: the dry run must not fail on a key
    // it never uses, or `--approve-plan` becomes a flag readers cannot test.
    const code = await run(
      ['node', 'mergesutra', 'repair', fixture.record.runId, '--repo', fixture.workspace],
      { ...io, env: {}, repair: { store: fixture.store, now: () => NOW, cwd: fixture.workspace } },
    );

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(io.text()).toContain(repairPlanDigest(fixture.plan));
    expect(io.errorText()).not.toMatch(/BHARATCODE_API_KEY/);
  });

  it('refuses an approval digest that names another plan, and keeps the bytes it was given', async () => {
    const fixture = await aRun();
    const io = capture();
    const client = scriptedClient([]);

    const code = await run(
      [
        'node',
        'mergesutra',
        'repair',
        fixture.record.runId,
        '--repo',
        fixture.workspace,
        '--approve-plan',
        'f'.repeat(64),
      ],
      { ...io, env: {}, repair: depsFor(fixture, client) },
    );

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(io.text()).toContain(repairPlanDigest(fixture.plan));
    expect(client.calls).toHaveLength(0);
    expect(await parserOf(fixture.workspace)).not.toBe(REPAIRED);
    expect((await fixture.store.load(fixture.record.runId)).repairExecutions).toEqual([]);
  });

  it('executes the approved cycle through the stage, files it in the record and prints where the pack is', async () => {
    const fixture = await aRun();
    const current = await parserOf(fixture.workspace);
    const io = capture();

    const code = await run(
      [
        'node',
        'mergesutra',
        'repair',
        fixture.record.runId,
        '--repo',
        fixture.workspace,
        '--approve-plan',
        repairPlanDigest(fixture.plan),
      ],
      {
        ...io,
        env: {},
        repair: depsFor(fixture, scriptedClient(repairedAnswers(current, fixture.criteria))),
      },
    );

    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
    const record = await fixture.store.load(fixture.record.runId);
    expect(record.stage).toBe('repair');
    expect(record.outcome).toBe('REPAIR_APPLIED');
    expect(record.repairExecutions).toHaveLength(1);
    // The human's yes, handed over and not re-minted by this command.
    expect(record.executionConsent?.grantedAt).toBe(GRANTED_AT);
    const text = io.text();
    expect(text).toContain('REPAIR_APPLIED');
    expect(slashes(text)).toContain(slashes(fixture.runsRoot) + '/' + fixture.record.runId);
    // Bytes moved and the gates that measured them have to be re-run by whoever
    // reads this, so the command exits 3 rather than calling its own work done.
    expect(code).toBe(EXIT.INCONCLUSIVE);
  });

  it('prints the whole record as JSON when asked, without deciding anything extra', async () => {
    const fixture = await aRun();
    const current = await parserOf(fixture.workspace);
    const io = capture();

    const code = await run(
      [
        'node',
        'mergesutra',
        'repair',
        fixture.record.runId,
        '--repo',
        fixture.workspace,
        '--approve-plan',
        repairPlanDigest(fixture.plan),
        '--json',
      ],
      {
        ...io,
        env: {},
        repair: depsFor(fixture, scriptedClient(repairedAnswers(current, fixture.criteria))),
      },
    );

    const payload = JSON.parse(io.text()) as {
      recordFile: string | null;
      record: { outcome: string; repairExecutions: unknown[] };
    };
    expect(payload.record.outcome).toBe('REPAIR_APPLIED');
    expect(payload.record.repairExecutions).toHaveLength(1);
    expect(payload.recordFile).toContain(fixture.record.runId);
    expect(code).toBe(EXIT.INCONCLUSIVE);
  });

  it('asks for a credential only on the path that would spend one', async () => {
    const fixture = await aRun();
    const io = capture();

    // Approved, no `client` dep, empty environment: the cycle has to reach a model,
    // and the honest news is a configuration refusal before any byte is edited.
    const code = await run(
      [
        'node',
        'mergesutra',
        'repair',
        fixture.record.runId,
        '--repo',
        fixture.workspace,
        '--approve-plan',
        repairPlanDigest(fixture.plan),
      ],
      { ...io, env: {}, repair: { store: fixture.store, now: () => NOW, cwd: fixture.workspace } },
    );

    expect(code).toBe(EXIT.CONFIG);
    expect(io.errorText()).toMatch(/BHARATCODE_API_KEY/);
    expect(await parserOf(fixture.workspace)).not.toBe(REPAIRED);
    expect((await fixture.store.load(fixture.record.runId)).repairExecutions).toEqual([]);
  });

  it('takes no flag that approves in advance, and still edits nothing', async () => {
    for (const forbidden of ['--yes', '--force', '--approve-all', '--all']) {
      const fixture = await aRun();
      const io = capture();
      const client = scriptedClient([]);

      const code = await run(['node', 'mergesutra', 'repair', fixture.record.runId, forbidden], {
        ...io,
        env: {},
        repair: depsFor(fixture, client),
      });

      expect(code).not.toBe(EXIT.OK);
      expect(io.errorText() + io.text()).toMatch(/unknown option/i);
      expect(client.calls).toHaveLength(0);
      expect((await fixture.store.load(fixture.record.runId)).repairExecutions).toEqual([]);
      expect(await parserOf(fixture.workspace)).not.toBe(REPAIRED);
    }
  });

  it('names itself in help, with the approval flag it is the only way to give', async () => {
    const io = capture();

    // No deps at all: help must not need a run, a store or a credential, or a
    // reader cannot find out what the command requires before supplying them.
    const code = await run(['node', 'mergesutra', 'repair', '--help'], { ...io, env: {} });

    const text = io.text();
    expect(code).toBe(0);
    // Commander renders the declared form as `Usage: mergesutra repair [options]
    // [run-id]`, so the assertion is on the signature it actually prints.
    expect(text).toMatch(/repair \[options\] \[run-id\]/);
    expect(text).toMatch(/--approve-plan <digest>/);
    expect(text).toMatch(/lowering only|--max-repair-cycles/);
    expect(text.toLowerCase()).not.toMatch(/--yes|--force|--approve-all/);
  });

  it('keeps a spent review budget out of the wording, and still reports the cycle it ran', async () => {
    const fixture = await aRun({ reviewCycle: 2 });
    const current = await parserOf(fixture.workspace);
    const io = capture();

    const code = await run(
      [
        'node',
        'mergesutra',
        'repair',
        fixture.record.runId,
        '--repo',
        fixture.workspace,
        '--approve-plan',
        repairPlanDigest(fixture.plan),
      ],
      {
        ...io,
        env: {},
        repair: depsFor(fixture, scriptedClient(repairedAnswers(current, fixture.criteria))),
      },
    );

    const text = io.text();
    expect(text).toMatch(/NEEDS_HUMAN_REVIEW|a person|human/i);
    expect(text).not.toMatch(/run `mergesutra review .* again/i);
    expect((await fixture.store.load(fixture.record.runId)).outcome).toBe('REPAIR_APPLIED');
    expect(code).toBe(EXIT.INCONCLUSIVE);
  });

  it('reports a pack it could not write instead of pretending it is there', async () => {
    const fixture = await aRun();
    const current = await parserOf(fixture.workspace);
    const io = capture();
    const runsRoot = path.join(fixture.runsRoot, 'blocked');
    await put(fixture.runsRoot, 'blocked', 'not a directory\n');

    const code = await run(
      [
        'node',
        'mergesutra',
        'repair',
        fixture.record.runId,
        '--repo',
        fixture.workspace,
        '--approve-plan',
        repairPlanDigest(fixture.plan),
      ],
      {
        ...io,
        env: {},
        repair: {
          ...depsFor(fixture, scriptedClient(repairedAnswers(current, fixture.criteria))),
          runsRoot,
        },
      },
    );

    expect(code).toBe(EXIT.INCONCLUSIVE);
    const text = io.text();
    expect(text).toMatch(/Evidence pack/);
    expect(slashes(text)).not.toContain(
      slashes(path.join(runsRoot, fixture.record.runId, 'report.md')),
    );
    // The cycle happened and is filed, whatever the renderer could not do.
    expect((await fixture.store.load(fixture.record.runId)).repairExecutions).toHaveLength(1);
  });
});
