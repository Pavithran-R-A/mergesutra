import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBharatCodeClient } from '../../src/bharatcode/client.js';
import { loadBharatCodeConfig } from '../../src/config/load-config.js';
import { fakeFetch, recordingSleeper, TEST_KEY } from '../helpers/fetch.js';
import { cleanUp } from '../helpers/implement.js';
import type { CompletionRequest } from '../../src/bharatcode/types.js';

/**
 * The pre-request completion budget: what a run may spend, enforced before a byte
 * leaves the process rather than read back off the records after it.
 *
 * The chain's ceiling has always been a *qualification* rule — `MAX_MODEL_COMPLETIONS`
 * compares the counts three stages filed and declares a finished run unqualified when the
 * sum is past it. That answers "was this run within budget" and cannot answer "may this
 * request be sent", so a thirteenth request was reachable by any route that re-enters a
 * stage: `plan`'s own next-stage line tells the operator to run it again, `implement` can
 * be resumed, and a non-zero `BHARATCODE_MAX_RETRIES` turns one completion into several
 * POSTs without any stage noticing. These tests pin the guard at the one place every
 * completion actually goes through, and pin it to HTTP requests rather than to the
 * caller's idea of a turn.
 *
 * Everything here runs through the real environment loader and the real client against a
 * transport that only counts. A budget enforced anywhere the transport can still be
 * reached is a budget with a hole in it.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

async function newLedger(prefix = 'mergesutra-request-budget-'): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

const answered = {
  ok: true,
  status: 200,
  body: {
    status: 'completed',
    model: 'bc-large',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    ],
  },
};

const modelUnavailable = { ok: false, status: 503, body: { error: 'upstream busy' } };

/** The same answer with a body the structured route can parse. */
const answeredJson = {
  ok: true,
  status: 200,
  body: {
    status: 'completed',
    model: 'bc-large',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '{"answer":42,"ok":true}' }],
      },
    ],
  },
};

const catalog = { ok: true, status: 200, body: { data: [{ id: 'bc-large' }] } };

const ping: CompletionRequest = { messages: [{ role: 'user', content: 'ping' }] };

function clientWith(
  env: Record<string, string | undefined>,
  responses: Array<typeof answered | typeof modelUnavailable | typeof catalog>,
) {
  const { fetch, calls } = fakeFetch(responses);
  const sleeper = recordingSleeper();
  const client = createBharatCodeClient({
    config: loadBharatCodeConfig({
      BHARATCODE_API_KEY: TEST_KEY,
      BHARATCODE_MODEL: 'bc-large',
      BHARATCODE_MAX_RETRIES: '0',
      ...env,
    }),
    fetch,
    sleeper: sleeper.sleep,
  });
  return { client, calls, sleeper };
}

function configError(env: Record<string, string | undefined>): unknown {
  try {
    loadBharatCodeConfig({ BHARATCODE_API_KEY: TEST_KEY, ...env });
  } catch (error) {
    return error;
  }
  return null;
}

describe('the pre-request completion budget', () => {
  it('refuses the request past the ceiling before it reaches the transport', async () => {
    const ledger = await newLedger();
    const { client, calls } = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '2', BHARATCODE_REQUEST_LEDGER: ledger },
      [answered, answered, answered],
    );

    await client.complete(ping);
    await client.complete(ping);
    await expect(client.complete(ping)).rejects.toMatchObject({ kind: 'blocked' });

    // Two POSTs, not three: the third was refused on this side of `fetch`, so the
    // provider never saw a request it would have answered and charged.
    expect(calls).toHaveLength(2);
  });

  it('charges the structured route through the same ceiling', async () => {
    // The reservation's comment claims every completion route passes through it because
    // `completeStructured` delegates to `complete`. That is true of the code as it is
    // written and is exactly the kind of claim that has shipped a hole before: S19-R4
    // records the smoke's one-request guard covering `complete` and missing the sibling,
    // so the delegation is pinned here rather than trusted.
    //
    // The assertions are that the structured call *spends* a slot and that the next one is
    // refused without a POST — not merely that a pre-exhausted ledger rejects it, which a
    // guard placed inside the JSON branch would also pass.
    const ledger = await newLedger();
    const { client, calls } = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '1', BHARATCODE_REQUEST_LEDGER: ledger },
      [answeredJson, answeredJson],
    );

    await expect(
      client.completeStructured({
        messages: [{ role: 'user', content: 'ping' }],
        validate: (value) => value as { answer: number; ok: boolean },
      }),
    ).resolves.toEqual({ answer: 42, ok: true });
    expect(calls).toHaveLength(1);
    expect(await readdir(ledger)).toHaveLength(1);

    await expect(
      client.completeStructured({
        messages: [{ role: 'user', content: 'ping' }],
        validate: (value) => value as { answer: number; ok: boolean },
      }),
    ).rejects.toMatchObject({ kind: 'blocked', details: { code: 'REQUEST_BUDGET_EXHAUSTED' } });
    expect(calls).toHaveLength(1);
  });

  it('charges every retry attempt against the same ceiling', async () => {
    const ledger = await newLedger();
    // The live job pins `BHARATCODE_MAX_RETRIES: '0'`, but the ceiling has to hold on a
    // run that does not: the shipped default is three additional attempts, so one
    // completion is four POSTs and a counter that asked the *stage* how many turns it
    // took would report one and watch four requests leave.
    const { client, calls, sleeper } = clientWith(
      {
        BHARATCODE_MAX_COMPLETION_REQUESTS: '2',
        BHARATCODE_REQUEST_LEDGER: ledger,
        BHARATCODE_MAX_RETRIES: '3',
      },
      [modelUnavailable],
    );
    expect(
      loadBharatCodeConfig({ BHARATCODE_API_KEY: TEST_KEY, BHARATCODE_MODEL: 'bc-large' }).retry
        .maxRetries,
      'the shipped default retries, which is the hole this ceiling has to close',
    ).toBeGreaterThan(0);

    // One completion, several attempts on its own retry policy. The ceiling is a ceiling
    // on what the provider is asked, so the second 503 is the last POST this may send.
    await expect(client.complete(ping)).rejects.toMatchObject({ kind: 'blocked' });
    expect(calls).toHaveLength(2);
    expect(sleeper.delays.length).toBeGreaterThan(0);
  });

  it('refuses a resumed process whose ledger already holds the ceiling', async () => {
    const ledger = await newLedger();
    const first = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '1', BHARATCODE_REQUEST_LEDGER: ledger },
      [answered],
    );
    await first.client.complete(ping);

    // A new client object is the outside of a new process: nothing it holds in memory can
    // know what the previous one spent, so the only honest answer comes from the directory
    // both of them were pointed at. This is the resume case, and the stage-level bounds
    // do not cover it — `implement` carries its own residual, and nothing carries `plan`.
    const second = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '1', BHARATCODE_REQUEST_LEDGER: ledger },
      [answered],
    );
    await expect(second.client.complete(ping)).rejects.toMatchObject({ kind: 'blocked' });

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });

  it('lets exactly one of two concurrent requests take the last slot', async () => {
    const ledger = await newLedger();
    const a = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '1', BHARATCODE_REQUEST_LEDGER: ledger },
      [answered],
    );
    const b = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '1', BHARATCODE_REQUEST_LEDGER: ledger },
      [answered],
    );

    const settled = await Promise.allSettled([a.client.complete(ping), b.client.complete(ping)]);
    const refused = settled.filter((entry) => entry.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: { kind: 'blocked' } });
    expect(a.calls.length + b.calls.length).toBe(1);
  });

  it('does not charge the authenticated catalogue read', async () => {
    const ledger = await newLedger();
    const { client, calls } = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '1', BHARATCODE_REQUEST_LEDGER: ledger },
      [catalog, answered],
    );

    // `doctor --connect` and the workflow's catalog step both list models before the chain
    // starts. A ceiling on completions that also ate those reads would refuse the first
    // request of a run that had only just proved it could make one.
    await client.listModels();
    await client.complete(ping);
    expect(calls).toHaveLength(2);
  });

  it('refuses the request instead of sending it when the ledger cannot be written', async () => {
    const occupied = await newLedger('mergesutra-budget-blocked-');
    const blocker = path.join(occupied, 'not-a-directory');
    await writeFile(blocker, 'x', 'utf8');
    const { client, calls } = clientWith(
      {
        BHARATCODE_MAX_COMPLETION_REQUESTS: '12',
        BHARATCODE_REQUEST_LEDGER: path.join(blocker, 'ledger'),
      },
      [answered],
    );

    // Fail-closed is the point: a guard that lets a request through because it could not
    // do its bookkeeping is a guard that spends whenever the disk is odd.
    //
    // The two refusals carry different codes, because an operator who is told the budget
    // ran out when the ledger could not be created goes looking for a spent run instead of
    // a path that will not hold a file.
    await expect(client.complete(ping)).rejects.toMatchObject({
      kind: 'blocked',
      details: { code: 'REQUEST_BUDGET_UNAVAILABLE' },
    });
    expect(calls).toHaveLength(0);
  });

  it('names the ceiling and says the request never left, in its own refusal', async () => {
    const ledger = await newLedger();
    const { client } = clientWith(
      { BHARATCODE_MAX_COMPLETION_REQUESTS: '1', BHARATCODE_REQUEST_LEDGER: ledger },
      [answered],
    );
    await client.complete(ping);

    const error = await client.complete(ping).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('1');
    expect(message).not.toContain(TEST_KEY);
    expect((error as { retryable?: boolean }).retryable).toBe(false);
    expect((error as { details?: Record<string, unknown> }).details?.code).toBe(
      'REQUEST_BUDGET_EXHAUSTED',
    );
  });

  it('leaves every request uncounted when no budget is configured', async () => {
    // Normal customer runs set neither variable. The guard is a property of a bounded
    // experiment, not a new default that changes what an ordinary run may ask.
    const { client, calls } = clientWith({}, [answered, answered, answered]);
    await client.complete(ping);
    await client.complete(ping);
    await client.complete(ping);
    expect(calls).toHaveLength(3);
  });

  it('leaves the ledger directory untouched when no budget is configured', async () => {
    const ledger = await newLedger();
    const { client } = clientWith({}, [answered]);
    await client.complete(ping);
    expect(await readdir(ledger)).toEqual([]);
  });
});

describe('the request budget environment', () => {
  it('reads a ceiling and a ledger together', () => {
    const config = loadBharatCodeConfig({
      BHARATCODE_API_KEY: TEST_KEY,
      BHARATCODE_MAX_COMPLETION_REQUESTS: '12',
      BHARATCODE_REQUEST_LEDGER: '/tmp/mergesutra-ledger',
    });
    expect(config.requestBudget).toEqual({
      limit: 12,
      ledgerDirectory: '/tmp/mergesutra-ledger',
    });
  });

  it('reads nothing when neither variable is set', () => {
    expect(loadBharatCodeConfig({ BHARATCODE_API_KEY: TEST_KEY }).requestBudget).toBeUndefined();
  });

  it('refuses a ceiling with no ledger before any request is made', () => {
    // The half-configured case is the dangerous one: an operator who pins the number and
    // forgets where it lives would get an unenforced promise of a budget.
    const error = configError({ BHARATCODE_MAX_COMPLETION_REQUESTS: '12' });
    expect(error).toMatchObject({ kind: 'config' });
    expect((error as Error).message).toContain('BHARATCODE_REQUEST_LEDGER');
  });

  it('refuses a ledger with no ceiling', () => {
    const error = configError({ BHARATCODE_REQUEST_LEDGER: '/tmp/mergesutra-ledger' });
    expect(error).toMatchObject({ kind: 'config' });
    expect((error as Error).message).toContain('BHARATCODE_MAX_COMPLETION_REQUESTS');
  });

  it('refuses a ceiling that is not a whole number of requests', () => {
    for (const value of ['0', '-1', '1.5', 'twelve', '']) {
      const error = configError({
        BHARATCODE_MAX_COMPLETION_REQUESTS: value,
        BHARATCODE_REQUEST_LEDGER: '/tmp/mergesutra-ledger',
      });
      expect(error, `${JSON.stringify(value)} is not a countable ceiling`).toMatchObject({
        kind: 'config',
      });
    }
  });

  it('refuses a ledger path that is not absolute', () => {
    const error = configError({
      BHARATCODE_MAX_COMPLETION_REQUESTS: '12',
      BHARATCODE_REQUEST_LEDGER: 'relative/ledger',
    });
    expect(error).toMatchObject({ kind: 'config' });
    expect((error as Error).message).toContain('absolute');
  });
});
