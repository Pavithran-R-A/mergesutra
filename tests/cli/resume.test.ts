import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../src/core/errors.js';
import { acquireRunLock, runLockDirectory } from '../../src/lifecycle/lock.js';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { recordWith } from '../helpers/review.js';
import { plannedRun, planTouching } from '../helpers/implement.js';
import { reviewedRun } from '../helpers/repairRun.js';
import { implementedRun, scriptedGates } from '../helpers/verifyRun.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';
import { planBodyFor, scriptedClient } from '../helpers/bharatcode.js';
import { hasGit } from '../helpers/git.js';
import type { LoopLimits } from '../../src/implement/limits.js';
import type { ImplementationRecord } from '../../src/implement/state.js';
import type { ResumePlan } from '../../src/lifecycle/resume-plan.js';
import type { ResumeStageDeps } from '../../src/lifecycle/resume.js';
import type { ProgramDeps } from '../../src/cli/program.js';
import type { MemoryRunStore } from '../helpers/github.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * `mergesutra resume` — the command a person reaches for when a run stopped.
 *
 * Everything the service guarantees is decided here about *words and numbers*: the
 * screen a person reads before typing `--execute`, the exit code a script reads after,
 * and the one route by which a plan becomes an action — the dispatcher that hands a
 * stage's own runner the run id and the limits that are left. A preview that hid the
 * cost would let a person approve a model request they never saw; an exit code of 0
 * for a run that stopped at a boundary would let a script approve one it never read.
 *
 * §16 fixes the default (preview) and §37 fixes the codes, and the two rules pull in
 * opposite directions on one point: a resume that ran something must report what that
 * thing earned, while a resume that ran nothing must never report 0 as though it had.
 * So the codes here come from three places — 0 for a preview that described its plan,
 * the stage's own outcome for an action, and a stop code for every path where nothing
 * ran. The `--yes` case is tested rather than asserted because a flag that "just
 * confirms" is the one feature a recovery tool must not grow.
 *
 * Three cases run a real stage through the real dispatcher, with a scripted client and
 * no credential in the environment, because "the dispatcher routes by command" is a
 * claim about the record the stage files and about the gates the stage itself enforces —
 * and a spy would prove only that the spy was called. One of them is the `--allow` list:
 * the same repository command Stage 7 refuses without consent stays refused through
 * `resume`, and starts when the ids are named.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();
const PID = 4242;
const HOST = 'this-host';

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

interface Where {
  readonly store: MemoryRunStore;
  readonly runsRoot: string;
  readonly record: RunRecord;
}

async function contractRun(): Promise<Where> {
  const prepared = await contractBackedRun(tempDirs);
  return { store: prepared.store, runsRoot: prepared.root, record: prepared.record };
}

/** A run with a plan and no loop yet — the next step writes files. */
async function plannedWhere(): Promise<Where> {
  const run_ = await plannedRun(tempDirs);
  return {
    store: run_.prepared.store,
    runsRoot: run_.prepared.root,
    record: run_.record,
  };
}

/**
 * A run standing at Stage 7's door: bytes on disk, a plan on record, no receipts.
 *
 * `implementedRun` files the loop without a plan document, and a plan-less run is
 * offered `plan` before it is offered `verify`. The plan is attached here so the first
 * thing this run is genuinely owed is the gate run this case is about.
 */
async function verifiableRun(): Promise<Where> {
  const fixture = await implementedRun(tempDirs);
  const record = recordWith(fixture.source, { plan: planTouching(['src/parse.ts']) });
  await fixture.prepared.store.save(record);
  return { store: fixture.prepared.store, runsRoot: fixture.prepared.root, record };
}

/** A run whose loop was interrupted with most of its bound unspent. */
async function stoppedLoop(): Promise<Where> {
  const fixture = await reviewedRun(tempDirs);
  const implementation = fixture.record.implementation as ImplementationRecord;
  await fixture.store.save(
    recordWith(fixture.record, {
      implementation: {
        ...implementation,
        status: 'CANCELLED',
        termination: { kind: 'DEADLINE', detail: 'the human interrupted the loop' },
      },
    }),
  );
  return { store: fixture.store, runsRoot: fixture.runsRoot, record: fixture.record };
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

/** The deps a resume command gets: the service's view of the run, plus any stage's own. */
function depsFor(where: Where, extra: ProgramDeps = {}): ProgramDeps {
  const resume: Partial<ResumeStageDeps> = {
    store: where.store,
    runsRoot: where.runsRoot,
    cwd: where.record.local?.toplevel ?? where.runsRoot,
    now: () => NOW,
    pid: PID,
    host: HOST,
    ...(extra.resume ?? {}),
  };
  return { ...extra, resume, env: { NO_COLOR: '1' } };
}

/** The stage the command would run, recorded so a refusal can be proved by absence. */
interface StageSpy {
  readonly calls: { plan: ResumePlan; limits: Partial<LoopLimits> | null }[];
  readonly executeStage: NonNullable<ResumeStageDeps['executeStage']>;
}

function spy(record: RunRecord, onCall?: (plan: ResumePlan) => Promise<void>): StageSpy {
  const calls: StageSpy['calls'] = [];
  return {
    calls,
    executeStage: async (plan, limits) => {
      calls.push({ plan, limits });
      if (onCall) await onCall(plan);
      return record;
    },
  };
}

async function stored(where: Where): Promise<string> {
  return JSON.stringify(await where.store.load(where.record.runId));
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A client whose every property read is a failure: no preview may reach for one. */
function exploding(): never {
  return new Proxy(
    {},
    {
      get(_target, property): never {
        throw new Error(`resume reached for '${String(property)}' on a model client`);
      },
    },
  ) as never;
}

/**
 * The gate ids the repository's own commands are waiting on.
 *
 * Read from a separate run of the same shape, because asking Stage 7 what it would
 * run is itself a save, and the run under test has to be the one that never saw it.
 */
async function repositoryGateIds(): Promise<string[]> {
  const other = await implementedRun(tempDirs);
  const stage = await runVerifyStage(
    { runId: other.source.runId },
    { store: other.prepared.store, now: () => NOW, ...scriptedGates() },
  );
  return stage.plan.gates
    .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
    .map((gate) => gate.id);
}

describe.skipIf(!AVAILABLE)('the resume command', () => {
  it('shows the plan and changes nothing until the word execute appears', async () => {
    const where = await contractRun();
    const screen = capture();
    const stage = spy(where.record);
    const before = await stored(where);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.OK);
    expect(stage.calls).toHaveLength(0);
    expect(screen.text()).toContain('CREATE_PLAN');
    expect(screen.text()).toContain(where.record.runId);
    // §34: the digest is printed on the preview, because it is the only handle a
    // person has on the state a plan was read from.
    expect(screen.text()).toMatch(/[0-9a-f]{64}/);
    expect(screen.text()).toContain(`resume ${where.record.runId} --execute`);
    expect(screen.text()).toContain('NOTHING HAS BEEN RUN');
    expect(await stored(where)).toBe(before);
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('names the cost of each kind of action before a person is asked to execute', async () => {
    const where = await plannedWhere();
    const screen = capture();
    const stage = spy(where.record);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.OK);
    expect(screen.text()).toMatch(/model request/i);
    expect(screen.text()).toMatch(/credential/i);
    // The plan that edits files has to say so in words a person cannot misread as a
    // dry run, because this is the one transition that touches their work.
    expect(screen.text()).toMatch(/changes files|write[s]? to the workspace/i);
    expect(stage.calls).toHaveLength(0);
  });

  it('previews a plan that needs a credential with no credential anywhere', async () => {
    const where = await contractRun();
    const screen = capture();

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--json'], {
      ...depsFor(where, {
        plan: exploding(),
        implement: exploding(),
        review: exploding(),
        verify: exploding(),
        pr: exploding(),
      }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.OK);
    expect(screen.errorText()).toBe('');
    const json = JSON.parse(screen.text()) as Record<string, unknown>;
    expect(json.kind).toBe('PREVIEW');
    expect(json.action).toBe('CREATE_PLAN');
    expect(json.requiresModel).toBe(true);
    expect(json.requiresCredential).toBe(true);
    expect(String(json.observedStateDigest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries no verdict in a resume screen or its json', async () => {
    const where = await stoppedLoop();
    const screen = capture();
    const stage = spy(where.record);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.OK);
    expect(screen.text()).not.toMatch(
      /CONTRIBUTION_READY|PR ready|PASSED|SUCCESS|VERIFIED|DEFECT|published|pushed|merged/i,
    );
    // §19 on the screen a person reads: the numbers the loop already spent.
    expect(screen.text()).toMatch(/of 12 steps|steps left|9 of 12/i);
  });

  it('has no --yes, because a yes that names nothing is what this command is for', async () => {
    const where = await contractRun();
    const screen = capture();
    const stage = spy(where.record);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--yes'], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).not.toBe(EXIT.OK);
    expect(screen.errorText()).toMatch(/unknown option/i);
    expect(stage.calls).toHaveLength(0);
  });

  it('runs the stage the plan names, and files what that stage measured', async () => {
    const where = await contractRun();
    const stripped = recordWith(where.record, { acceptanceContract: null });
    await where.store.save(stripped);
    const screen = capture();

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, {
        contract: { store: where.store, now: () => NOW, random: () => 0.6 },
      }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    const after = await where.store.load(where.record.runId);
    expect(code).toBe(EXIT.OK);
    // No `executeStage` was injected, so the only way a contract can be back on this
    // run is the dispatcher routing `contract` to the real stage.
    expect(after.acceptanceContract).not.toBeNull();
    expect(after.outcome).toBe('CONTRACT_DERIVED');
    expect(screen.text()).toContain('CONTRACT_DERIVED');
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('says when the action it ran files no record, instead of printing the old one as new', async () => {
    // `findings: false` so this run is offered `report` and not a repair whose plan
    // nobody has approved: the action under test is the one that files nothing.
    const fixture = await reviewedRun(tempDirs, { findings: false });
    const where: Where = {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
      record: fixture.record,
    };
    const screen = capture();
    const stage = spy(fixture.record);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(stage.calls).toHaveLength(1);
    expect(stage.calls[0]?.plan.action).toBe('REGENERATE_EVIDENCE_PACK');
    // A pack is rendered from the record, so this action left the record exactly where
    // Stage 9 had it. The record's outcome is the authoritative one and still prints
    // (§37's "resulting lifecycle outcome" is about the run, not about a receipt for
    // this command) — but the stage row may not name a stage this action did not run,
    // because "Stage recorded review" after `resume --execute` reads as this command's
    // own filing, and no document behind it says that.
    expect(screen.text()).toContain('REGENERATE_EVIDENCE_PACK');
    expect(screen.text()).toContain('REVIEW_RECORDED');
    expect(screen.text()).toMatch(/Stage recorded\s+none/u);
    expect(screen.text()).toContain('files no record of its own');
  });

  it('spends a model request only when it was told to, and only through the stage', async () => {
    const where = await contractRun();
    const screen = capture();
    const criteria = where.record.acceptanceContract?.criteria.map((criterion) => criterion.id);
    const client = scriptedClient([planBodyFor(criteria ?? [])]);
    const known = new Set((await where.store.list()).runs.map((run) => run.runId));

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, {
        plan: {
          store: where.store,
          cwd: where.runsRoot,
          now: () => NOW,
          random: () => 0.7,
          client,
        },
      }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    const after = await where.store.load(where.record.runId);
    const filed = (await where.store.list()).runs
      .filter((run) => !known.has(run.runId))
      .map((run) => run.runId);
    expect(code).toBe(EXIT.OK);
    expect(client.calls).toHaveLength(1);
    // The planner is the one stage that files its answer as a new run rather than
    // advancing the run it was handed. `resume` does not rewrite that behaviour, and it
    // does not hide it either: the resumed record still has no plan, and the screen
    // names the record that does.
    expect(after.plan).toBeNull();
    expect(filed).toHaveLength(1);
    expect((await where.store.load(filed[0]!)).outcome).toBe('PLAN_COMPLETE');
    expect((await where.store.load(filed[0]!)).plan).not.toBeNull();
    expect(screen.text()).toContain(filed[0]!);
    expect(screen.text()).toContain('filed a new run');
    expect(screen.text()).toContain('PLAN_COMPLETE');
  });

  it('exits with the outcome the resumed stage filed, never with 0 for an attempt', async () => {
    const where = await contractRun();
    const screen = capture();
    const stage = spy(recordWith(where.record, { outcome: 'IMPLEMENTED_BY_MODEL' }));

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(stage.calls).toHaveLength(1);
    expect(screen.text()).toContain('IMPLEMENTED_BY_MODEL');
  });

  it('carries the gate ids a person names to the stage it dispatches, and brings none of its own', async () => {
    const ids = await repositoryGateIds();
    expect(ids.length).toBeGreaterThan(0);

    const unconsented = await verifiableRun();
    const unconsentGates = scriptedGates();
    const noScreen = capture();
    const blockedCode = await run(
      ['node', 'mergesutra', 'resume', unconsented.record.runId, '--execute'],
      {
        ...depsFor(unconsented, {
          verify: { store: unconsented.store, now: () => NOW, ...unconsentGates },
        }),
        write: noScreen.write,
        writeErr: noScreen.writeErr,
      },
    );

    const consented = await verifiableRun();
    const consentGates = scriptedGates();
    const screen = capture();
    const ranCode = await run(
      [
        'node',
        'mergesutra',
        'resume',
        consented.record.runId,
        '--execute',
        ...ids.flatMap((id) => ['--allow', id]),
      ],
      {
        ...depsFor(consented, {
          verify: { store: consented.store, now: () => NOW, ...consentGates },
        }),
        write: screen.write,
        writeErr: screen.writeErr,
      },
    );

    // §17 read at the one place the command layer can prove it: the `--allow` list is
    // handed to the stage, and nothing else consents on the run's behalf. Without the
    // flag the repository's own command never starts; with it the same command does.
    // The gate is Stage 7's, unchanged by arriving through `resume`.
    expect(unconsentGates.calls.join('\n')).not.toMatch(/\bnpm\b/);
    expect(blockedCode).toBe(EXIT.BLOCKED);
    expect(consentGates.calls.join('\n')).toMatch(/\bnpm\b/);
    expect(ranCode).toBe(EXIT.OK);
    expect(screen.text()).toContain('VERIFICATION_PASS');
  });

  it('exits BLOCKED at an approval a person has not given, and says whose it is', async () => {
    const fixture = await reviewedRun(tempDirs);
    const where: Where = {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
      record: fixture.record,
    };
    const screen = capture();
    const stage = spy(where.record);
    const before = await stored(where);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.BLOCKED);
    expect(screen.text()).toMatch(/approval|a person|human/i);
    expect(screen.text()).toContain('NOTHING WAS RUN');
    expect(stage.calls).toHaveLength(0);
    expect(await stored(where)).toBe(before);
  });

  it('exits INCONCLUSIVE when the loop asked for a person, because a resume answers for no one', async () => {
    const where = await verifiableRun();
    const loop = where.record.implementation as ImplementationRecord;
    await where.store.save(
      recordWith(where.record, {
        implementation: { ...loop, status: 'NEEDS_HUMAN_REVIEW' },
      }),
    );
    const screen = capture();
    const stage = spy(where.record);
    const before = await stored(where);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, { resume: stage }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    // The one stop that is neither a block nor an approval: a loop that stopped by
    // saying it needs a reader. §37 routes that to the same 3 the stage itself would
    // give, and never to 0 for having tried.
    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(stage.calls).toHaveLength(0);
    expect(screen.text()).toMatch(/needs a person/i);
    expect(screen.text()).toContain('NOTHING WAS RUN');
    expect(await stored(where)).toBe(before);
  });

  it('exits BLOCKED while another live process holds the run, and leaves that lock alone', async () => {
    const where = await contractRun();
    const acquired = await acquireRunLock(
      { runId: where.record.runId },
      {
        runsRoot: where.runsRoot,
        cwd: where.runsRoot,
        pid: 5151,
        host: 'another-host',
        now: () => NOW,
        isProcessAlive: () => true,
      },
    );
    expect(acquired.state).toBe('ACQUIRED');
    const screen = capture();
    const stage = spy(where.record);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, { resume: { ...stage, isProcessAlive: () => true } }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.BLOCKED);
    expect(stage.calls).toHaveLength(0);
    expect(screen.text()).toMatch(/pid 5151|5151/);
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(true);
  });

  it('routes a missing credential to the configuration exit and keeps no lock', async () => {
    const where = await contractRun();
    const screen = capture();
    const failing: StageSpy = {
      calls: [],
      executeStage: async (): Promise<RunRecord> => {
        throw new AppError({
          kind: 'config',
          message: 'BharatCode is not configured on this machine.',
          remediation: 'Set the endpoint and token, then run `mergesutra doctor`.',
        });
      },
    };

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, { resume: failing }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.CONFIG);
    expect(screen.errorText()).toMatch(/not configured/i);
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('reports a run whose workspace is gone as a block, and exits 4 without claiming it', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const where: Where = {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
      record: fixture.record,
    };
    // A checkout the record claims to own that is not on this machine, plus a workspace
    // the status screen already reports as a blocker: the plan is built from facts that
    // no command can clear by being attempted, so execution stops before the lock.
    await where.store.save(
      recordWith(where.record, {
        local: where.record.local ? { ...where.record.local, toplevel: where.runsRoot } : null,
      }),
    );
    const screen = capture();
    const stage = spy(where.record);
    const before = await stored(where);

    const code = await run(['node', 'mergesutra', 'resume', where.record.runId, '--execute'], {
      ...depsFor(where, {
        resume: { ...stage, cwd: path.join(where.runsRoot, 'no-such-checkout') },
      }),
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.BLOCKED);
    expect(stage.calls).toHaveLength(0);
    expect(screen.text()).toMatch(/cannot be observed|blocker|block/i);
    expect(screen.text()).toContain('NOTHING WAS RUN');
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
    expect(await stored(where)).toBe(before);
  });

  it('leaves `run` planned, because an unattended pipeline still has no consent in it', async () => {
    const screen = capture();

    const code = await run(['node', 'mergesutra', 'run'], {
      write: screen.write,
      writeErr: screen.writeErr,
      env: {},
    });

    expect(code).toBe(EXIT.PLANNED);
    expect(screen.text()).toMatch(/'run' is planned, not yet implemented/);
    expect(screen.text()).not.toMatch(/resume.*planned/i);
  });

  it('describes itself without promising a pull request', async () => {
    const screen = capture();

    const code = await run(['node', 'mergesutra', 'resume', '--help'], {
      write: screen.write,
      writeErr: screen.writeErr,
    });

    expect(code).toBe(EXIT.OK);
    expect(screen.text()).toMatch(/--execute/);
    expect(screen.text()).not.toMatch(
      /(opens|creates|publishes|pushes) (a |the )?(pull request|PR)/i,
    );
    expect(screen.text()).not.toMatch(/--yes/);
  });
});
