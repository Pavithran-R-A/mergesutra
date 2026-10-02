import { afterEach, describe, expect, it } from 'vitest';
import { parseCompletion } from '../../src/bharatcode/schemas.js';
import { runPlanStage } from '../../src/plan/plan.js';
import { planBodyFor, scriptedClient, TEST_MODEL } from '../helpers/bharatcode.js';
import { cleanUp, contractBackedRun, NOW, type Prepared } from '../helpers/plan.js';

/**
 * Which model a run says it talked to — S12-27 (brief §37).
 *
 * `src/bharatcode/schemas.ts` takes the model name from the response envelope and
 * falls back to what was requested only when the envelope says nothing. So the
 * name in a run record is the gateway's report, not a local measurement: an
 * endpoint that answers for a different model gets to be quoted saying so. That
 * is not authority — nothing in this build branches on it — and this file is the
 * proof of the difference, because a comment reading "the model does not get to
 * record which model answered" is only true of the *answer text*, and a reader
 * who took it as true of the envelope would be reading a guarantee that was
 * never built.
 *
 * Five properties, four of them against the real Stage 4 planner:
 *
 * 1. the recorded name is exactly what the envelope carried, and the fallback is
 *    exactly the requested name;
 * 2. a gateway renaming itself changes no decision: the stored plan body, the run
 *    outcome and every check's status come out identical, with the name the only
 *    difference;
 * 3. the attribution field is a local literal — no response can move `source`;
 * 4. an answer *body* that tries to name its own model is refused whole, because
 *    the plan body schema is `.strict()`;
 * 5. a credential spelled into the asserted name is masked before the plan is
 *    stored, since that is the one way this field could carry what a customer
 *    would call a leak.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function planFor(prepared: Prepared, overrides: Record<string, unknown> = {}): unknown {
  return { ...planBodyFor(prepared.criteria), ...overrides };
}

const ENVELOPE = (body: unknown, model?: string): unknown => ({
  choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }],
  ...(model === undefined ? {} : { model }),
});

async function planWithModel(prepared: Prepared, answers: readonly unknown[], model: string) {
  return runPlanStage(
    { runId: prepared.record.runId },
    {
      store: prepared.store,
      now: () => NOW,
      random: () => 0.9,
      client: scriptedClient(answers, { model }),
    },
  );
}

/** The same plan with the gateway's self-report blanked out, to compare everything else. */
function withoutName(plan: NonNullable<Awaited<ReturnType<typeof planWithModel>>['plan']>) {
  return JSON.stringify({ ...plan, provenance: { ...plan.provenance, model: '<name>' } });
}

describe('the name the run records', () => {
  it('is what the response envelope said, whether or not it is what was asked for', () => {
    const parsed = parseCompletion(ENVELOPE({ ok: true }, 'a-model-nobody-requested'), 'asked-for');
    expect(parsed.model).toBe('a-model-nobody-requested');
  });

  it('falls back to the requested name only when the envelope names nothing', () => {
    expect(parseCompletion(ENVELOPE({ ok: true }), 'asked-for').model).toBe('asked-for');
  });

  it('reaches the stored plan unchanged, and the INFO check quotes the same report', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const result = await planWithModel(prepared, [planFor(prepared)], 'gateway-says-this-model');
    expect(result.plan?.provenance.model).toBe('gateway-says-this-model');
    const info = result.checks.find((check) => check.name === 'BharatCode');
    expect(info?.detail).toContain('gateway-says-this-model');
  });
});

describe('a gateway that renames itself', () => {
  it('changes nothing but the name it is recorded under', async () => {
    const honestRun = await contractBackedRun(tempDirs);
    const lyingRun = await contractBackedRun(tempDirs);
    const honest = await planWithModel(honestRun, [planFor(honestRun)], TEST_MODEL);
    const lying = await planWithModel(lyingRun, [planFor(lyingRun)], 'a-model-that-never-existed');

    expect(honest.plan).not.toBeNull();
    expect(lying.plan).not.toBeNull();
    expect(lying.record.outcome).toBe(honest.record.outcome);
    expect(lying.checks.map((check) => [check.name, check.status])).toEqual(
      honest.checks.map((check) => [check.name, check.status]),
    );
    expect(withoutName(lying.plan!)).toBe(withoutName(honest.plan!));
  });

  it('cannot move the attribution field, which is a local literal', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const result = await planWithModel(prepared, [planFor(prepared)], 'gateway-says-this-model');
    expect(result.plan?.provenance.source).toBe('bharatcode');
  });

  it('masks a credential spelled into the name it asserts before the plan is stored', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const secret = 'sk-planmodel-SECRETVALUE-7777';
    const result = await planWithModel(prepared, [planFor(prepared)], `bharatcode(${secret})`);
    expect(JSON.stringify(result.plan), 'the stored plan is not a place for a key').not.toContain(
      secret,
    );
    expect(result.plan?.provenance.model).toContain('[REDACTED]');
  });
});

describe('what the answer text may name', () => {
  it('is never its own model, because a body carrying that key is refused whole', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const selfNamed = planFor(prepared, { model: 'i-am-the-model' });
    const result = await planWithModel(prepared, [selfNamed, selfNamed], TEST_MODEL);
    expect(result.plan).toBeNull();
    expect(result.record.outcome).not.toBe('PLAN_COMPLETE');
  });

  it('is never its own attribution either', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const selfSourced = planFor(prepared, { source: 'someone-else' });
    const result = await planWithModel(prepared, [selfSourced, selfSourced], TEST_MODEL);
    expect(result.plan).toBeNull();
    expect(result.record.plan).toBeNull();
  });

  it('leaves a body that names nothing of the sort planned normally', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const result = await planWithModel(prepared, [planFor(prepared)], TEST_MODEL);
    expect(result.plan?.body).toEqual(planBodyFor(prepared.criteria));
  });
});
