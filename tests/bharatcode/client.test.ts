import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createBharatCodeClient, type FetchLike } from '../../src/bharatcode/client.js';
import { loadBharatCodeConfig } from '../../src/config/load-config.js';
import { AppError } from '../../src/core/errors.js';
import type { BharatCodeClientConfig } from '../../src/bharatcode/types.js';
import { fakeFetch, hangingFetch, recordingSleeper, TEST_KEY } from '../helpers/fetch.js';

function baseConfig(over: Partial<BharatCodeClientConfig> = {}): BharatCodeClientConfig {
  return {
    apiKey: TEST_KEY,
    baseUrl: 'https://bharatcode.test/api/model/v1',
    model: 'bc-large',
    timeoutMs: 5000,
    retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 400 },
    ...over,
  };
}

const completionBody = {
  choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
  model: 'bc-large',
};

describe('BharatCodeClient.listModels', () => {
  it('parses a valid OpenAI-style model list', async () => {
    const { fetch, calls } = fakeFetch([
      { ok: true, status: 200, body: { data: [{ id: 'bc-large' }, { id: 'bc-small' }] } },
    ]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    const list = await client.listModels();
    expect(list.models.map((m) => m.id)).toEqual(['bc-large', 'bc-small']);
    expect(calls[0]?.url).toBe('https://bharatcode.test/api/model/v1/models');
  });

  it('sends an Authorization bearer header (value available to redaction, not logs)', async () => {
    const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: { data: [] } }]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    await client.listModels();
    expect(calls[0]?.init?.headers?.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('rejects a malformed model list (missing id) as invalid-response', async () => {
    const { fetch } = fakeFetch([{ ok: true, status: 200, body: { data: [{ name: 'oops' }] } }]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    await expect(client.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

/**
 * The addresses a client reaches when nobody names any, §28.
 *
 * Every other test here runs against `bharatcode.test`, which proves the shape of
 * a request but says nothing about where a real `mergesutra` run would send it —
 * and the shape is exactly where a default can go wrong: an extra slash, a lost
 * `/api/model`, a catalogue path bolted onto the host root. So this goes through
 * the same loader the CLI goes through, with an empty environment, and reads the
 * URLs that actually left the client.
 */
describe('the endpoints a default-configured client calls', () => {
  function defaults(fetch: FetchLike) {
    return createBharatCodeClient({
      config: loadBharatCodeConfig({ BHARATCODE_API_KEY: TEST_KEY, BHARATCODE_MODEL: 'bc-large' }),
      fetch,
    });
  }

  it('asks that host for its model catalogue at <base>/models', async () => {
    const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: { data: [] } }]);

    await defaults(fetch).listModels();

    expect(calls.map((call) => call.url)).toEqual(['https://bharatcode.ai/api/model/v1/models']);
  });

  it('asks the same host for a completion, at <base>/chat/completions', async () => {
    const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: completionBody }]);

    await defaults(fetch).complete({ messages: [{ role: 'user', content: 'ping' }] });

    expect(calls.map((call) => call.url)).toEqual([
      'https://bharatcode.ai/api/model/v1/chat/completions',
    ]);
  });

  it('carries an overridden base through to both, without doubling a slash', async () => {
    const { fetch, calls } = fakeFetch([
      { ok: true, status: 200, body: { data: [] } },
      { ok: true, status: 200, body: completionBody },
    ]);
    const client = createBharatCodeClient({
      config: loadBharatCodeConfig({
        BHARATCODE_API_KEY: TEST_KEY,
        BHARATCODE_MODEL: 'bc-large',
        BHARATCODE_API_BASE: 'https://staging.example/api/model/v1/',
      }),
      fetch,
    });

    await client.listModels();
    await client.complete({ messages: [{ role: 'user', content: 'ping' }] });

    expect(calls.map((call) => call.url)).toEqual([
      'https://staging.example/api/model/v1/models',
      'https://staging.example/api/model/v1/chat/completions',
    ]);
  });
});

describe('BharatCodeClient.complete', () => {
  it('parses an expected completion response', async () => {
    const { fetch } = fakeFetch([{ ok: true, status: 200, body: completionBody }]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    const res = await client.complete({ messages: [{ role: 'user', content: 'ping' }] });
    expect(res.text).toBe('hi there');
    expect(res.model).toBe('bc-large');
    expect(res.finishReason).toBe('stop');
  });

  it('maps an explicit thinking preference into chat_template_kwargs', async () => {
    const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: completionBody }]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });

    await client.complete({
      messages: [{ role: 'user', content: 'return structured JSON' }],
      enableThinking: false,
      maxTokens: 4096,
    });

    const body = JSON.parse(calls[0]?.init?.body ?? '{}');
    expect(body.max_tokens).toBe(4096);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('requires a model selection', async () => {
    const { fetch } = fakeFetch([{ ok: true, status: 200, body: completionBody }]);
    const client = createBharatCodeClient({ config: { ...baseConfig(), model: undefined }, fetch });
    await expect(client.complete({ messages: [] })).rejects.toMatchObject({ kind: 'config' });
  });

  it('surfaces a 401 as a non-retryable auth error (single transport call)', async () => {
    const { fetch, calls } = fakeFetch([{ ok: false, status: 401, body: { error: 'bad key' } }]);
    const { sleep } = recordingSleeper();
    const client = createBharatCodeClient({ config: baseConfig(), fetch, sleeper: sleep });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('never includes the API key in normal error text', async () => {
    const { fetch } = fakeFetch([{ ok: false, status: 400, raw: `rejected ${TEST_KEY} here` }]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    const serialized = `${err.message} ${JSON.stringify(err.details ?? {})}`;
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('Retry policy (deterministic, offline)', () => {
  it('retries a 429 and honours Retry-After', async () => {
    const { fetch, calls } = fakeFetch([
      { ok: false, status: 429, headers: { 'retry-after': '3' }, body: {} },
      { ok: true, status: 200, body: completionBody },
    ]);
    const { sleep, delays } = recordingSleeper();
    const client = createBharatCodeClient({
      config: baseConfig(),
      fetch,
      sleeper: sleep,
      random: () => 1,
    });
    const res = await client.complete({ messages: [] });
    expect(res.text).toBe('hi there');
    expect(calls.length).toBe(2);
    expect(delays[0]).toBe(3000);
  });

  it('performs bounded retries for a 503 and stops at maxRetries', async () => {
    const { fetch, calls } = fakeFetch([{ ok: false, status: 503, body: {} }]);
    const { sleep, delays } = recordingSleeper();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 400 } }),
      fetch,
      sleeper: sleep,
      random: () => 1,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('server');
    expect(calls.length).toBe(3); // 1 initial + 2 retries
    expect(delays.length).toBe(2);
  });

  it('retries transient network errors but exhausts within bounds', async () => {
    const { fetch, calls } = fakeFetch([new Error('ECONNRESET')]);
    const { sleep } = recordingSleeper();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 20 } }),
      fetch,
      sleeper: sleep,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(calls.length).toBe(2);
  });

  it('never retries with infinite attempts (maxRetries=0 → single call)', async () => {
    const { fetch, calls } = fakeFetch([{ ok: false, status: 500, body: {} }]);
    const { sleep } = recordingSleeper();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
      sleeper: sleep,
    });
    await expect(client.complete({ messages: [] })).rejects.toBeInstanceOf(AppError);
    expect(calls.length).toBe(1);
  });
});

describe('Timeout & cancellation (offline)', () => {
  it('produces a controlled retryable timeout error', async () => {
    const client = createBharatCodeClient({
      config: baseConfig({ timeoutMs: 5, retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: hangingFetch(),
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('produces a controlled cancellation error when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createBharatCodeClient({
      config: baseConfig(),
      fetch: hangingFetch(),
    });
    const err = await client.complete({ messages: [], signal: controller.signal }).catch((e) => e);
    expect(err.kind).toBe('cancelled');
    expect(err.retryable).toBe(false);
  });
});

describe('Config guard', () => {
  it('throws a config error when no API key is present', async () => {
    const { fetch } = fakeFetch([{ ok: true, status: 200, body: { data: [] } }]);
    const client = createBharatCodeClient({
      config: { ...baseConfig(), apiKey: undefined },
      fetch,
    });
    const err = await client.listModels().catch((e) => e);
    expect(err.kind).toBe('config');
    expect(String(err.message)).not.toContain(TEST_KEY);
  });
});

describe('completeStructured (model output is untrusted)', () => {
  const schema = z.object({ answer: z.number(), ok: z.boolean() });

  it('parses and validates well-formed structured output', async () => {
    const content = JSON.stringify({ answer: 42, ok: true });
    const { fetch } = fakeFetch([
      { ok: true, status: 200, body: { choices: [{ message: { content } }] } },
    ]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    const value = await client.completeStructured({
      messages: [{ role: 'user', content: 'give JSON' }],
      validate: (v) => schema.parse(v),
    });
    expect(value).toEqual({ answer: 42, ok: true });
  });

  it('flags schema-mismatched structured output as a validation error', async () => {
    const content = JSON.stringify({ answer: 'nope', ok: true });
    const { fetch } = fakeFetch([
      { ok: true, status: 200, body: { choices: [{ message: { content } }] } },
    ]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    const err = await client
      .completeStructured({
        messages: [{ role: 'user', content: 'x' }],
        validate: (v) => schema.parse(v),
      })
      .catch((e) => e);
    expect(err.kind).toBe('validation');
  });

  it('rejects non-JSON structured output', async () => {
    const { fetch } = fakeFetch([
      { ok: true, status: 200, body: { choices: [{ message: { content: 'not json at all' } }] } },
    ]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    await expect(
      client.completeStructured({
        messages: [{ role: 'user', content: 'x' }],
        validate: (v) => schema.parse(v),
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('healthCheck', () => {
  it('reports not configured without a key (offline)', async () => {
    const client = createBharatCodeClient({ config: { ...baseConfig(), apiKey: undefined } });
    const health = await client.healthCheck();
    expect(health).toMatchObject({ reachable: false, configured: false });
  });

  it('reports reachable when models list', async () => {
    const { fetch } = fakeFetch([{ ok: true, status: 200, body: { data: [{ id: 'a' }] } }]);
    const client = createBharatCodeClient({ config: baseConfig(), fetch });
    const health = await client.healthCheck();
    expect(health).toMatchObject({ reachable: true, configured: true, modelCount: 1 });
  });
});
