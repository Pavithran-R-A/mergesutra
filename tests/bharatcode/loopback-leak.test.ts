import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runPlanStage } from '../../src/plan/plan.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { createBharatCodeClient } from '../../src/bharatcode/client.js';
import { loadBharatCodeConfig, summarizeConfig } from '../../src/config/load-config.js';
import { AppError } from '../../src/core/errors.js';
import { Redactor } from '../../src/security/redaction.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';
import { planBodyFor } from '../helpers/bharatcode.js';

/**
 * What a live run puts on the wire, and what it does with what comes back.
 *
 * The live suite (`tests/plan/live.test.ts`) can only say "the key I spent did not
 * turn up in the record", which is a statement about one answer a model happened to
 * give. This file gets the same guarantee without a credential by running the real
 * adapter — real `fetch`, real config loading, real stage — against a gateway on the
 * loopback interface that answers whatever a misbehaving one might:
 *
 * - a header the client sends is the credential, so the first job here is to prove the
 *   request really carried it. Without that, every "does not contain" below would pass
 *   on an empty run;
 * - a gateway echoes the request back in an error body, which is how a debug proxy or a
 *   captured request puts a credential into the text this build reports;
 * - a gateway puts the credential *inside the completion itself*, so it arrives as the
 *   model's own words and gets filed in the run record and printed in the evidence pack
 * — the artifact that leaves the machine.
 *
 * The sentinel is deliberately shaped so no secret *pattern* recognises it: it is not
 * `sk-…`, not `ghp_…`, and never appears as `NAME=value`. A pattern-only redactor
 * therefore cannot mask it, and each absence below is evidence that the configured
 * value is known to the masking, not evidence of lucky shape-matching.
 */

const SENTINEL = 'bharatcode-loopback-7f3a9c2e1d';

interface Captured {
  readonly authorization: string | undefined;
  readonly path: string;
  readonly body: string;
}

interface Gateway {
  readonly base: string;
  readonly seen: readonly Captured[];
}

let server: Server | null = null;
const tempDirs: string[] = [];

async function openGateway(
  answer: (request: Captured) => { status: number; body: string },
): Promise<Gateway> {
  const seen: Captured[] = [];
  const listener = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const request: Captured = {
        authorization: req.headers.authorization,
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(request);
      const reply = answer(request);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  server = listener;
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/v1`, seen };
}

function completion(content: string, model = 'bharatcode-loopback-model'): string {
  return JSON.stringify({
    id: 'chatcmpl-loopback',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  });
}

async function envFor(base: string): Promise<NodeJS.ProcessEnv> {
  return {
    BHARATCODE_API_KEY: SENTINEL,
    BHARATCODE_MODEL: 'bharatcode-loopback-model',
    BHARATCODE_API_BASE: base,
    BHARATCODE_MAX_RETRIES: '0',
  };
}

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
  const open = server;
  server = null;
  if (!open) return;
  open.closeAllConnections();
  await new Promise<void>((resolve) => {
    open.close(() => resolve());
  });
});

describe('the credential a live run sends', () => {
  it('really does go out on the wire, so an absence below means something', async () => {
    const gateway = await openGateway(() => ({ status: 500, body: '{"error":"nope"}' }));
    const client = createBharatCodeClient({
      config: loadBharatCodeConfig(await envFor(gateway.base)),
    });

    await expect(client.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      AppError,
    );

    expect(gateway.seen).toHaveLength(1);
    expect(gateway.seen[0]!.path).toBe('/v1/chat/completions');
    expect(gateway.seen[0]!.authorization).toBe(`Bearer ${SENTINEL}`);
    // The prompt is not a place a credential belongs either.
    expect(gateway.seen[0]!.body).not.toContain(SENTINEL);
  });
});

describe('an error body that echoes the request header', () => {
  it('comes back masked, and only the configured value could have masked it', async () => {
    const echoBody = JSON.stringify({
      error: {
        message: 'upstream rejected the request',
        gateway_echo: `Bearer ${SENTINEL}`,
      },
    });
    expect(echoBody.length).toBeLessThan(500);
    // The control: with the value unregistered, the reported bytes still hold it. So
    // whatever hides it below is the seeded secret, not a pattern.
    expect(new Redactor().text(echoBody)).toContain(SENTINEL);

    const gateway = await openGateway(() => ({ status: 500, body: echoBody }));
    const client = createBharatCodeClient({
      config: loadBharatCodeConfig(await envFor(gateway.base)),
    });

    const failure = await client
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    const reported = `${String(failure)} ${JSON.stringify((failure as AppError).details)}`;
    expect(reported).not.toContain(SENTINEL);
    expect(reported).toContain('[REDACTED]');
    expect(gateway.seen[0]!.authorization).toBe(`Bearer ${SENTINEL}`);
  });
});

describe('a gateway that puts the credential in the completion', () => {
  it('keeps it out of the run record the stage files', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const echoed = planBodyFor(prepared.criteria);
    // A debug proxy or a model that was shown its own headers answers with the
    // credential inside the text the stage is about to store as its plan.
    echoed.summary = `Confirmed against the key ${SENTINEL}.`;
    const gateway = await openGateway(() => ({
      status: 200,
      body: completion(JSON.stringify(echoed)),
    }));

    const result = await runPlanStage(
      { runId: prepared.record.runId },
      { store: prepared.store, now: () => NOW, random: () => 0.7, env: await envFor(gateway.base) },
    );

    // The stage asked, the gateway answered, and the answer did carry the credential:
    // without these, a passing assertion below would only prove nothing was filed.
    expect(gateway.seen[0]!.authorization).toBe(`Bearer ${SENTINEL}`);
    expect(result.record.outcome).toBe('PLAN_COMPLETE');
    expect(JSON.stringify(result.record)).not.toContain(SENTINEL);
    expect(JSON.stringify(result.record)).toContain('[REDACTED]');
    // The bytes the run leaves on disk, not only the object in this process: a
    // record is the file a person attaches to a bug report.
    for (const [file, text] of prepared.store.files) {
      expect(text, file).not.toContain(SENTINEL);
    }
  });

  /**
   * A pin, not a proof of the masking below.
   *
   * The pack renders receipts, gate rows and model *claims* taken from the
   * implementation and review documents; it prints no plan prose, so this passes
   * while nothing in it is masked. It exists to fail on the day a renderer starts
   * quoting the plan — the change that would turn a filed credential into a
   * published one. The record assertions above are what the fix is measured by.
   */
  it('keeps it out of every file of the evidence pack', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const echoed = planBodyFor(prepared.criteria);
    echoed.assumptions = [`the request was authorised with ${SENTINEL}`];
    const gateway = await openGateway(() => ({
      status: 200,
      body: completion(JSON.stringify(echoed)),
    }));

    const result = await runPlanStage(
      { runId: prepared.record.runId },
      { store: prepared.store, now: () => NOW, random: () => 0.7, env: await envFor(gateway.base) },
    );
    const pack = buildEvidencePack(result.record);

    expect(Object.keys(pack.files).sort()).toEqual(['commands.jsonl', 'report.json', 'report.md']);
    expect(gateway.seen[0]!.authorization).toBe(`Bearer ${SENTINEL}`);
    for (const [name, text] of Object.entries(pack.files)) {
      expect(text, name).not.toContain(SENTINEL);
    }
  });
});

describe('the safe configuration summary a screen may print', () => {
  it('names the credential without quoting it', async () => {
    const gateway = await openGateway(() => ({ status: 500, body: '{}' }));
    const config = loadBharatCodeConfig(await envFor(gateway.base));
    const summary = summarizeConfig(config);

    expect(summary.configured).toBe(true);
    expect(summary.apiKeySource).toBe('environment');
    expect(JSON.stringify(summary)).not.toContain(SENTINEL);
    expect(JSON.stringify(summary)).toContain('127.0.0.1');
  });
});
