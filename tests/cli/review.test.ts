import { afterAll, describe, expect, it } from 'vitest';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { CompletionRequest } from '../../src/bharatcode/types.js';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import type { ReviewStageDeps } from '../../src/review/stage.js';
import { memoryRunStore } from '../helpers/github.js';
import {
  cleanUp,
  hasGit,
  NOW,
  recordWith,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * `mergesutra review` — Stage 9 judged as output.
 *
 * The stage's own suite proves nothing is edited and the plan is frozen before
 * anything could be. This file proves the harder thing to get right: that a
 * person reading only the terminal cannot walk away thinking a model signed the
 * patch off. That failure does not need a bug — "review complete", "no issues
 * found" and a green tick are all accurate descriptions of a stubbed second
 * opinion, and every one of them is a lie about the contribution.
 *
 * So the assertions here are of two kinds: what the command must name (the
 * digest it reviewed, the reviewer's own id, each finding's disposition, and the
 * limits it left behind), and what it must never print at any outcome — which is
 * why the refusal path is tested with no credential in the environment: the
 * honest answer there is exit 78, not a review.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    out: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

/** The reviewer, written so its citations come from the page it was actually shown. */
function reviewer(
  make: (wire: string, criterion: string) => readonly Record<string, unknown>[],
  options: { beforeAnswer?: () => Promise<void>; failure?: unknown } = {},
): { client: BharatCodeClient; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const client: BharatCodeClient = {
    async complete(request) {
      requests.push(request);
      if (options.failure) throw options.failure;
      await options.beforeAnswer?.();
      return {
        text: JSON.stringify({
          summary: 'One input shape still reaches a Date that should never have been built.',
          findings: make(request.messages.map((message) => message.content).join('\n'), 'AC-1'),
        }),
        model: 'bharatcode-deepseek-reviewer',
        finishReason: 'stop',
        usage: { promptTokens: 3_900, completionTokens: 260, totalTokens: 4_160 },
      };
    },
    async listModels() {
      throw new Error('the review command may not enumerate models');
    },
    async completeStructured() {
      throw new Error('the review command may not ask for structured output');
    },
    async healthCheck() {
      throw new Error('the review command may not probe the service');
    },
  };
  return { client, requests };
}

function citing(wire: string, path: string): string {
  const found = new RegExp(`(CTX-\\d{3}) type: PATCH file: ${path.replace(/\./g, '\\.')}\\b`).exec(
    wire,
  );
  if (!found?.[1]) throw new Error(`the reviewed page names no reference for ${path}`);
  return found[1];
}

const candidateFindings = (wire: string, criterion: string): Record<string, unknown>[] => [
  {
    severity: 'HIGH',
    category: 'CORRECTNESS',
    statement: 'An impossible day can still reach a Date on one input shape.',
    impact: 'A caller stores the wrong day and never hears about it.',
    evidence: 'The parser builds a Date straight from the unvalidated string.',
    file: 'src/parse.ts',
    criterionIds: [criterion],
    contextRefs: [citing(wire, 'src/parse.ts')],
    proposedAction: 'Change src/parse.ts to reject the day before constructing a Date.',
    confidence: 'HIGH',
  },
];

interface Case {
  readonly findings?: (wire: string, criterion: string) => readonly Record<string, unknown>[];
  readonly movePatchAfterVerification?: boolean;
  readonly unverified?: boolean;
  readonly failure?: unknown;
  readonly beforeAnswer?: () => Promise<void>;
}

async function aRun(testCase: Case = {}): Promise<{
  fixture: ReviewFixture;
  deps: Partial<ReviewStageDeps>;
  store: ReturnType<typeof memoryRunStore>;
  requests: CompletionRequest[];
}> {
  const fixture = await reviewFixture(made, {
    ...(testCase.movePatchAfterVerification ? { movePatchAfterVerification: true } : {}),
  });
  const store = memoryRunStore();
  await store.save(
    testCase.unverified
      ? recordWith(fixture.record, {
          verification: null,
          verificationPlan: null,
          evidence: null,
          executionConsent: null,
          stage: 'implement',
          outcome: 'IMPLEMENTED_BY_MODEL',
        })
      : fixture.record,
  );
  const model = reviewer(testCase.findings ?? candidateFindings, {
    ...(testCase.beforeAnswer ? { beforeAnswer: testCase.beforeAnswer } : {}),
    ...(testCase.failure === undefined ? {} : { failure: testCase.failure }),
  });
  return {
    fixture,
    store,
    requests: model.requests,
    deps: { store, client: model.client, now: () => NOW },
  };
}

async function cli(
  args: readonly string[],
  c: ReturnType<typeof capture>,
  deps: Partial<ReviewStageDeps> | undefined,
  env: Record<string, string> = { PATH: '/usr/bin', NO_COLOR: '1' },
): Promise<number> {
  return run(['node', 'mergesutra', ...args], {
    write: c.write,
    writeErr: c.writeErr,
    env,
    ...(deps ? { review: deps } : {}),
  });
}

describe.skipIf(!AVAILABLE)('mergesutra review', () => {
  it('names the bytes it reviewed, the reviewer that read them and the disposition given', async () => {
    const { fixture, deps } = await aRun();
    const c = capture();

    const code = await cli(['review', fixture.record.runId], c, deps);

    const text = c.out();
    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(text).toContain(fixture.record.runId);
    expect(text).toContain('REVIEW_RECORDED');
    expect(text).toContain(fixture.patch.identity.slice(0, 12));
    expect(text).toContain('bharatcode-deepseek-reviewer');
    expect(text).toContain('RF-001');
    expect(text).toContain('VALID_REPAIR_CANDIDATE');
    expect(text).toContain('An impossible day can still reach a Date');
  });

  it('never reports a review as an approval, at any outcome', async () => {
    const empty = await aRun({ findings: () => [] });
    const stale = await aRun({
      movePatchAfterVerification: true,
      findings: candidateFindings,
    });
    const broken = await aRun({
      findings: () => [],
      failure: new Error('socket hang up'),
    });

    for (const runCase of [empty, stale, broken]) {
      const c = capture();
      const code = await cli(['review', runCase.fixture.record.runId], c, runCase.deps);
      expect(code, String(code)).not.toBe(0);
      for (const line of [c.out(), c.errorText()]) {
        expect(line).not.toMatch(/CONTRIBUTION_READY|APPROVED|LGTM|looks correct|signed off/i);
      }
    }
  });

  it('prints a review that filed nothing as a limit on what was read', async () => {
    const { fixture, deps } = await aRun({ findings: () => [] });
    const c = capture();

    const code = await cli(['review', fixture.record.runId], c, deps);

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(c.out()).toContain('no findings');
    expect(c.out()).toMatch(/absence of findings|not a sign-off/i);
  });

  it('says the review went stale, and plans nothing from it', async () => {
    const { fixture, deps } = await aRun({
      movePatchAfterVerification: true,
      findings: candidateFindings,
      beforeAnswer: async () => {
        const { readFile, writeFile } = await import('node:fs/promises');
        const file = `${fixture.workspace}/src/parse.ts`;
        await writeFile(file, `${await readFile(file, 'utf8')}\n// moved\n`, 'utf8');
      },
    });
    const c = capture();

    const code = await cli(['review', fixture.record.runId], c, deps);

    expect(code).toBe(EXIT.BLOCKED);
    expect(c.out()).toContain('REVIEW_STALE');
    expect(c.out()).toMatch(/STALE/);
    expect(c.out()).not.toContain('Repair plan');
  });

  it('shows the frozen work order as a plan, and says nothing was edited', async () => {
    const { fixture, deps } = await aRun();
    const c = capture();

    await cli(['review', fixture.record.runId], c, deps);

    expect(c.out()).toContain('src/parse.ts');
    expect(c.out()).toMatch(/nothing was edited|no file was changed/i);
  });

  it('--json carries the record with its review and the file it was written to', async () => {
    const { fixture, deps } = await aRun();
    const c = capture();

    const code = await cli(['--json', 'review', fixture.record.runId], c, deps);
    const payload = JSON.parse(c.out()) as {
      recordFile: string | null;
      record: {
        outcome: string;
        review: { findings: { id: string; disposition: string }[] } | null;
      };
    };

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(payload.recordFile).toContain(fixture.record.runId);
    expect(payload.record.outcome).toBe('REVIEW_RECORDED');
    expect(payload.record.review?.findings).toEqual([
      expect.objectContaining({ id: 'RF-001', disposition: 'VALID_REPAIR_CANDIDATE' }),
    ]);
  });

  it('refuses to review a run that has never been verified, without asking a model', async () => {
    const { fixture, deps, requests, store } = await aRun({ unverified: true });
    const c = capture();

    const code = await cli(['review', fixture.record.runId], c, deps);

    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toMatch(/verif/i);
    expect(requests).toHaveLength(0);
    expect((await store.load(fixture.record.runId)).review).toBeNull();
  });

  it('asks for the credential instead of inventing a review when none is set', async () => {
    const { fixture, deps, store } = await aRun();
    const c = capture();

    const code = await cli(
      ['review', fixture.record.runId],
      c,
      { store: deps.store, now: () => NOW },
      { PATH: '/usr/bin', NO_COLOR: '1' },
    );

    expect(code).toBe(EXIT.CONFIG);
    expect(c.errorText()).toMatch(/BHARATCODE_API_KEY/);
    expect((await store.load(fixture.record.runId)).review).toBeNull();
  });

  it('refuses a cycle budget above the ceiling before it spends a request', async () => {
    const { fixture, deps, requests } = await aRun();
    const c = capture();

    const code = await cli(['review', fixture.record.runId, '--max-review-cycles', '9'], c, deps);

    expect(code).toBe(EXIT.CONFIG);
    expect(c.errorText()).toMatch(/--max-review-cycles.*1 to 3/s);
    expect(requests).toHaveLength(0);
  });

  it('is a working command now, and fails as a stage would with nothing to review', async () => {
    const c = capture();

    const code = await cli(['review'], c, { store: memoryRunStore(), now: () => NOW });

    expect(code).not.toBe(EXIT.PLANNED);
    expect(c.out()).not.toContain('is planned, not yet implemented');
    expect(code).not.toBe(0);
    expect(c.errorText()).toMatch(/no run|nothing to review|record/i);
  });
});
