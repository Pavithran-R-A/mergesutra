import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createBharatCodeClient, type FetchLike } from '../../src/bharatcode/client.js';
import { terminalSafeSingleLine } from '../../src/security/terminal-safety.js';
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

/**
 * A credential-shaped value that matches none of the global secret patterns.
 *
 * `TEST_KEY` is shaped like an `sk-...` key, so the redactor's pattern list masks it
 * whether or not the client ever registered the configured key. Anything that has to
 * prove *key-aware* masking has to use a value only the registration can know.
 */
const UNSHAPED_KEY = 'Qz7Hn2Wp9Tr4Xk8B';

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

  it('names the transport cause, because "fetch failed" alone cannot be diagnosed', async () => {
    // Node's fetch reports every socket-layer failure as `TypeError: fetch failed` and puts
    // the reason in `cause`. Run 39460563729 lost a paid plan request to a ~300 s transport
    // headers timeout and the whole evidence trail was the four words "fetch failed", which
    // is indistinguishable from a dead endpoint. The cause has to survive into the message —
    // and the key inside it has to be masked by *registration*, not by shape, or this proves
    // nothing about the client that seeds the redactor with its own configured key.
    const transportFailure = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(`Headers Timeout Error while sending ${UNSHAPED_KEY}`), {
        name: 'HeadersTimeoutError',
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    });
    const { fetch } = fakeFetch([transportFailure]);
    const client = createBharatCodeClient({
      config: baseConfig({
        apiKey: UNSHAPED_KEY,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('UND_ERR_HEADERS_TIMEOUT');
    expect(err.message).not.toContain(UNSHAPED_KEY);
    expect(err.message).toContain('[REDACTED]');
  });

  it('still reports a transport failure that carries no cause', async () => {
    const { fetch } = fakeFetch([new TypeError('fetch failed')]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    // The whole message, not a substring: `fetch failed` is inside the broken version of
    // the helper too (`fetch failed (cause: undefined undefined)`), and an error screen
    // that invents a cause the transport never sent is its own misdiagnosis. The name is
    // part of the report because a rejection's `name` is what separates a `TypeError`
    // from a socket error that happens to carry the same sentence.
    expect(err.message).toBe('Could not reach BharatCode: TypeError fetch failed');
  });

  it('holds one socket-said line to one bounded line', async () => {
    // `transportDetail` flattens and truncates because the text it handles comes off a
    // connection: a peer can put a newline where an operator's report expects a sentence,
    // and can keep talking for thousands of characters. Both halves of that rule have to
    // cover the message the transport actually wrote, not only the cause underneath it —
    // `fetch failed` itself is somebody else's string on Node, and `terminalSafeText` at
    // the CLI sink deliberately lets a newline through.
    const chatter = 'y'.repeat(5000);
    const transportFailure = Object.assign(
      new TypeError(`fetch failed\r\nsecond line ${chatter}`),
      {
        cause: Object.assign(new Error(`Headers Timeout Error\n${chatter}`), {
          name: 'HeadersTimeoutError',
          code: 'UND_ERR_HEADERS_TIMEOUT',
        }),
      },
    );
    const { fetch } = fakeFetch([transportFailure]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message).not.toContain(chatter);
    expect(err.message).toContain('UND_ERR_HEADERS_TIMEOUT');
  });

  it('leaves no line-breaking code point raw in a transport message', async () => {
    // The promise is "held to one line", and CR and LF are not the only code points that
    // break one: the terminal sink's set also holds VT, FF, ESC, the whole C1 range (NEL
    // lives in it), U+2028/U+2029 and the bidi controls. So the helper runs the value
    // through that same encoder instead of keeping a list of its own, and the assertion is
    // the encoder's own invariant — a message this client produced is already escaped, so
    // escaping it again changes nothing. A consumer that does not route through the sink
    // (the live driver's log files, a published artifact, a caller of this client) then
    // reads the control bytes as a visible spelling, never as a live cursor move.
    const chatter = 'y'.repeat(4000);
    const { fetch } = fakeFetch([
      Object.assign(
        new TypeError(`fetch failed\u2028second\u000b\u000c\u0085\u2029\u001b[31m${chatter}`),
        {
          cause: Object.assign(new Error('Headers Timeout Error'), {
            name: 'HeadersTimeoutError',
            code: 'UND_ERR_HEADERS_TIMEOUT',
          }),
        },
      ),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toBe(terminalSafeSingleLine(err.message));
    // The idempotence check above would also pass if the helper *deleted* the control
    // bytes, because an empty string is its own escape. The promise is that a reader sees a
    // spelling of what arrived, so the spelling is pinned: backslash, a lower-case `u`, four
    // hex digits — exactly what the encoder writes.
    expect(err.message).toContain('\\u001b[31m');
    expect(err.message).not.toContain(chatter);
    expect(err.message).toContain('UND_ERR_HEADERS_TIMEOUT');
  });

  it('masks a credential the socket quoted with a line break at its separator', async () => {
    // The redactor's generic rule needs whitespace between the name and the `:` or `=`,
    // and the encoder rewrites exactly the code points that are whitespace there. So a
    // message that encodes first, and masks afterwards, hands the rule a spelling it can
    // no longer find: `api_key\r\n= <secret>` becomes `api_key\u000d\u000a= <secret>`, the
    // separator stops matching, and the credential travels to the report whole. This is
    // the case the pattern list exists for — `this.redactor` only ever knows the
    // configured key, so a `GITHUB_TOKEN`-shaped value has no exact-match defence.
    const secret = 'q3WERTyuiop12345678';
    const { fetch } = fakeFetch([
      Object.assign(new TypeError(`fetch failed api_key\r\n= ${secret}`), {
        cause: Object.assign(new Error('Headers Timeout Error'), {
          name: 'HeadersTimeoutError',
          code: 'UND_ERR_HEADERS_TIMEOUT',
        }),
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).not.toContain(secret);
    expect(err.message).toContain('[REDACTED]');
  });

  it('masks a credential whose value continues past a raw line break', async () => {
    // The other half of the same measurement, and the reason the fix has to mask on both
    // sides of the encoder rather than only before it: the value class stops at
    // whitespace, so a raw `U+2028` inside a quoted credential masks its first half and
    // leaves the rest. Encoding rewrites that code point into six ASCII characters, which
    // the value class does not stop at, so the whole value is masked — but only if the
    // encoder still gets to run before the last look at the string.
    const tail = 'Kx9mZ2p7Lq4wN8b';
    const lineSeparator = String.fromCharCode(0x2028);
    const { fetch } = fakeFetch([
      Object.assign(new TypeError(`fetch failed token= abc${lineSeparator}${tail}`), {
        cause: Object.assign(new Error('Headers Timeout Error'), {
          name: 'HeadersTimeoutError',
          code: 'UND_ERR_HEADERS_TIMEOUT',
        }),
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).not.toContain(tail);
    // And not because the bound happened to cut it: the mask has to be seen firing.
    expect(err.message).toContain('[REDACTED]');
  });

  it('masks a credential quoted with a line break inside the cause, not only the headline', async () => {
    // The transport wraps its reason one level down, so the half of the report that leaks is
    // often the cause rather than the headline. `transportDetail` masks each half on its own
    // way out for this reason: a single pass over the joined, already-encoded string would
    // see the cause's `api_key\u000d\u000a= <secret>` spelling, match no separator, and
    // print the credential — which is the same defect the headline case above catches, one
    // level down, and it needs its own proof because the two halves are masked separately.
    const secret = 'z7Xcvbnm98QWERtyui';
    const { fetch } = fakeFetch([
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(`socket stalled api_key\r\n= ${secret}`), {
          name: 'SocketError',
        }),
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toContain('cause:');
    expect(err.message).not.toContain(secret);
    expect(err.message).toContain('[REDACTED]');
  });

  it('names the error that rejected the request when it carries the transport code itself', async () => {
    // Node wraps undici's timeout one level down, and that is the shape every other case
    // here uses. It is not the only shape: an adapter, or a later version of this client,
    // can propagate the coded error directly. Taking only `message` off the top-level error
    // throws away both its name and its code, and a headline without the code leaves
    // `transportWait` silent — the operator loses the sentence that says which of the two
    // waits ended the request.
    const { fetch } = fakeFetch([
      Object.assign(new Error('Headers Timeout Error while reading the response'), {
        name: 'HeadersTimeoutError',
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({
        timeoutMs: 812000,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('HeadersTimeoutError');
    expect(err.message).toContain('UND_ERR_HEADERS_TIMEOUT');
    // The sentence's meaning, not just the number in it: this branch exists to say the
    // transport stopped waiting first, and flipping that claim misleads the reader.
    expect(err.message).toContain('812000ms, which the transport did not reach');
  });

  it('keeps the diagnosis when reading the body fails outside the fetch call', async () => {
    // The fetch is guarded and the body read is the same transport failing one step later.
    // A locked or non-conforming stream throws out of `getReader()` rather than out of
    // `reader.read()`, so it escapes unconverted and the retry wrapper turns it into the
    // generic `BharatCode request failed`: no cause, no code, and — because the wrapper
    // classifies a non-AppError as not retryable — a transient failure recorded as one that
    // must never be retried.
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(completionBody),
      body: {
        getReader(): never {
          throw Object.assign(new Error('ReadableStream is locked'), {
            code: 'ERR_STREAM_ALREADY_LOCKED',
          });
        },
      } as unknown as ReadableStream<Uint8Array>,
    });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('ERR_STREAM_ALREADY_LOCKED');
    expect(err.retryable).toBe(true);
  });

  it('says how many errors an AggregateError hid', async () => {
    // undici's real multi-address connect failure is an AggregateError: its own message
    // distinguishes nothing and every useful code sits in `errors`. The values there are
    // not this message's to print — that is the leak the keys-only rule exists for — so the
    // count travels and the reader knows how much the transport withheld.
    const nested = [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:1'), { code: 'ETIMEDOUT' }),
    ];
    const { fetch } = fakeFetch([
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new AggregateError(nested, 'All connections failed'), {
          name: 'AggregateError',
        }),
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toContain('AggregateError');
    expect(err.message).toContain('2 nested errors');
    // The count says how much was withheld; the codes say what kind of failure was. A
    // socket's `message` is where its address lives — `connect ECONNREFUSED 127.0.0.1:1` is
    // the only place one appears in this test — while `code` is a fixed enum the transport
    // chose from a table, not a value the connection wrote.
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).toContain('ETIMEDOUT');
    expect(err.message).not.toContain('127.0.0.1');
  });

  it('survives a rejection whose own keys refuse to be listed', async () => {
    // `Object.keys` is not a total function. A Proxy with a throwing `ownKeys` trap makes
    // the *act of describing* a failure throw, and the diagnosis is then replaced by the
    // trap's own error — which is the same class of silence this whole helper exists to
    // end. Describing has to fail safe into a name.
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('do not look');
        },
      },
    );
    const fetch: FetchLike = async () => {
      throw hostile;
    };
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('could not be described');
  });

  it('survives a revocation that makes every question about a failure throw', async () => {
    // A revoked proxy throws on *every* operation, `instanceof` and `Object.keys` included,
    // so this is the case where each guard above is exercised at once. The rejection is
    // still a failure the operator has to hear about, and the message has to be this
    // side's name for an undescribable value — never the runtime's "proxy has been
    // revoked" text, which names the trap instead of the connection.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw proxy;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('could not be described');
    expect(err.message).not.toContain('revoked');
  });

  it('bounds on whole characters, never between the halves of one', async () => {
    // `slice` counts UTF-16 code units, so a limit can land between the surrogate pair that
    // makes one astral character and emit half of it. A lone surrogate is not a character,
    // and the terminal JSON sink does not repair it. The leading `!` is not decoration: it
    // puts the pair on an odd offset, so the 160-unit cut falls inside it whether or not
    // the error's own name is part of the headline.
    const { fetch } = fakeFetch([new TypeError(`!${'😀'.repeat(200)}`)]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(err.message).not.toMatch(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('survives a rejection that is a callable whose every answer is revoked', async () => {
    // `String(value)` is a read too: for a function it looks up `toString`, and a revoked
    // proxy makes that lookup throw. A callable is not a shape a transport rejects with
    // today, but it is the one remaining door into `describeForeign` that can fail, and
    // the rule this round enforces is that describing a failure never becomes the failure.
    const { proxy, revoke } = Proxy.revocable(function unreachable() {}, {});
    revoke();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw proxy;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('could not be described');
    expect(err.message).not.toContain('revoked');
  });

  it('names a rejection that is not an Error by its keys, never [object Object]', async () => {
    // A fetch that rejects with a bare object is reachable — `controller.abort(value)`
    // hands the value back untouched, and a mocked or future transport can do the same.
    // `String()` of that is `[object Object]`, which names nothing, and printing the
    // *values* of somebody else's object is how a request payload ends up on a screen.
    // Keys carry the diagnosis; the values do not get to travel. `fakeFetch` only ever
    // throws Errors, so this rejection is made here, exactly as Node makes it.
    const fetch: FetchLike = async () => {
      throw { endpoint: 'https://bharatcode.test/api/model/v1/chat/completions', attempt: 1 };
    };
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain('[object Object]');
    expect(err.message).toContain('endpoint');
    expect(err.message).not.toContain('chat/completions');
  });

  it('names the configured cap when the transport times out on its own', async () => {
    // The one failure an operator has to be able to price. When Node's fetch gives up on
    // a request that never answered, the reader's next question is whether this side's
    // budget fired — and a message that shows only the cause leaves 540000 and 60000
    // indistinguishable. So the cap is reported next to the transport's own code, without
    // claiming which of the two stopped the wait.
    const transportFailure = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Headers Timeout Error'), {
        name: 'HeadersTimeoutError',
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    });
    const { fetch } = fakeFetch([transportFailure]);
    const client = createBharatCodeClient({
      config: baseConfig({
        timeoutMs: 741000,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('UND_ERR_HEADERS_TIMEOUT');
    expect(err.message).toContain('741000ms');
  });

  it('does not quote the cap for a failure that was never a wait', async () => {
    const { fetch } = fakeFetch([
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          name: 'ConnectError',
          code: 'ECONNREFUSED',
        }),
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({
        timeoutMs: 741000,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).not.toContain('741000ms');
  });

  it('still names the wait when a generic code sits above the transport timeout', async () => {
    // Node's own shape puts the code one level down, so reading the top-level code first
    // and stopping there is invisible while it is only ever right about Node. A proxy, an
    // adapter or a keep-alive socket that resets mid-flight can carry `ECONNRESET` at the
    // top with the headers timeout underneath it, and then the sentence that says *which*
    // of the two waits ended the request goes missing exactly when the two disagree.
    const { fetch } = fakeFetch([
      Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
        cause: Object.assign(new Error('Headers Timeout Error'), {
          name: 'HeadersTimeoutError',
          code: 'UND_ERR_HEADERS_TIMEOUT',
        }),
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({
        timeoutMs: 741000,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toContain('ECONNRESET');
    expect(err.message).toContain('which the transport did not reach');
  });

  it('still names the wait when the cause is not an Error', async () => {
    // `cause` is whatever the thrower chose. A transport that serializes its failure, or an
    // adapter that wraps in a plain object, leaves the code on a non-Error — and a reader
    // that requires `cause instanceof Error` reports the wait as if nothing was known about
    // it, which is the silence this class of helper exists to end.
    const { fetch } = fakeFetch([
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'UND_ERR_HEADERS_TIMEOUT', errno: -1 },
      }),
    ]);
    const client = createBharatCodeClient({
      config: baseConfig({
        timeoutMs: 741000,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toContain('which the transport did not reach');
    expect(err.message).not.toContain('-1');
  });

  it('survives an Error whose own fields refuse to be read', async () => {
    // The keys of a hostile object are already guarded, because describing a failure must
    // not be able to become one. An `Error` takes the other branch, where `name`, `code`
    // and `message` are read one after another — and any of the three can be a getter that
    // throws, which is how the socket's failure gets replaced by the trap's. Each read has
    // to answer for itself, and say that it refused, rather than pretend the field was
    // never there.
    const hostile = new Error('the message is not for you');
    for (const key of ['name', 'code', 'message']) {
      Object.defineProperty(hostile, key, {
        configurable: true,
        get(): never {
          throw new Error(`do not read ${key}`);
        },
      });
    }
    const fetch: FetchLike = async () => {
      throw hostile;
    };
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('could not be read');
    expect(err.message).not.toContain('do not read');
    expect(err.message).not.toContain('not for you');
  });

  it('survives a cause that refuses to be read', async () => {
    // The same rule the three named fields answer to, one level down: `transportDetail`
    // reaches for `cause` to print the reason the transport gives underneath its own. A
    // proxy may answer that reach by throwing, and then the trap's message is what the
    // report carries instead of the socket's — which is the defect this whole group of
    // readers exists to close, still open on the one field that was read directly.
    const hostile = new Proxy(Object.assign(new TypeError('fetch failed at the socket'), {}), {
      get(target, key) {
        if (key === 'cause') throw new Error('do not read the cause');
        return Reflect.get(target, key);
      },
    });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw hostile;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('fetch failed at the socket');
    expect(err.message).toContain('cause could not be read');
    expect(err.message).not.toContain('do not read the cause');
  });

  it('survives a failure that refuses the question of what it is', async () => {
    // `instanceof` is not a safe read either: it walks the value's prototype chain, and a
    // proxy can make that walk throw. Refusing the question is not the same as answering
    // "not an error" — the fields are still readable, and they are the diagnosis. So the
    // refusal routes the value through the same guarded readers, and the report says what
    // the failure said rather than what the trap shouted.
    const hostile = new Proxy(
      { name: 'TypeError', message: 'fetch failed behind a refused prototype' },
      {
        getPrototypeOf(): never {
          throw new TypeError('trap on the prototype chain');
        },
      },
    );
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw hostile;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('fetch failed behind a refused prototype');
    expect(err.message).not.toContain('trap on the prototype chain');
  });

  it('does not let a failure that refuses its retry flag replace the diagnosis', async () => {
    // `response.body` is read before the conversion that would wrap a foreign failure, so a
    // proxy response can throw an `AppError`-shaped value straight into the retry loop. Its
    // identity answers "ours" without a throw; its `retryable` flag refuses. The classifier
    // must decide without reading through that trap, and the failure behind it must escape.
    const ours = new AppError({
      kind: 'network',
      message: 'fetch failed at the socket',
      retryable: true,
    });
    const hostile = new Proxy(ours, {
      get(target, key, receiver) {
        if (key === 'retryable') throw new TypeError('trap on the retry flag');
        return Reflect.get(target, key, receiver);
      },
    });
    const fetch: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(completionBody),
        get body(): never {
          throw hostile;
        },
      }) as unknown as Awaited<ReturnType<FetchLike>>;
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err).toBe(hostile);
    expect(err.message).toContain('fetch failed at the socket');
    expect(err.message).not.toContain('trap on the retry flag');
  });

  it('reports no kind it could not read, and still completes the retry', async () => {
    // The retry callback is the last read of the failure on this path. A failure that
    // answers `retryable` but refuses `kind` is still worth retrying; the report is not
    // worth throwing for, and a kind this side cannot read is not one it may invent.
    const ours = new AppError({ kind: 'network', message: 'the probe failed', retryable: true });
    const hostile = new Proxy(ours, {
      get(target, key, receiver) {
        if (key === 'kind') throw new TypeError('trap on the kind');
        return Reflect.get(target, key, receiver);
      },
    });
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(completionBody),
          get body(): never {
            throw hostile;
          },
        } as unknown as Awaited<ReturnType<FetchLike>>;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(completionBody),
        body: undefined,
      } as unknown as Awaited<ReturnType<FetchLike>>;
    };
    const seen: { attempt: number; kind: string }[] = [];
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
      onRetry: (info) => seen.push({ attempt: info.attempt, kind: info.kind }),
    });
    const result = await client.complete({ messages: [] });
    expect(result.text).toBe('hi there');
    expect(calls).toBe(2);
    // A progress callback that cannot be given an honest kind is not given one at all.
    expect(seen).toEqual([]);
  });

  it('survives an error list that refuses to be counted', async () => {
    // An `AggregateError`'s own message distinguishes nothing, so its entries are read by
    // position and the count comes from `length` — both of which a proxy over the list can
    // refuse. The names of the entries are still worth reporting, and the refusal of the
    // count is its own fact: a withheld tally is not a tally of one.
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
      code: 'ECONNREFUSED',
    });
    const hostile = Object.assign(new TypeError('fetch failed at the connect'), {
      errors: new Proxy([inner], {
        get(target, key) {
          if (key === 'length') throw new RangeError('the count is withheld');
          return Reflect.get(target, key);
        },
      }),
    });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw hostile;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('fetch failed at the connect');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).toContain('whose count could not be read');
    expect(err.message).not.toContain('the count is withheld');
  });

  it('survives an error list whose entries refuse to be reached', async () => {
    // The count is one number the list can withhold; the entries are the other thing it can
    // refuse, and a proxy that throws on every positional read replaces the diagnosis just as
    // completely as a thrown `length` does — `map` asks the same object for the same values.
    // Both halves of the aggregate report are therefore reached one guarded read at a time,
    // and a refused entry is named as refused: an entry this side could not look at is not the
    // same fact as an entry with neither a code nor a name.
    const inner = Object.assign(new Error('connect ETIMEDOUT 198.51.100.7:443'), {
      code: 'ETIMEDOUT',
    });
    const hostile = Object.assign(new TypeError('fetch failed at the connect'), {
      errors: new Proxy([inner], {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            throw new RangeError('the entries are withheld');
          }
          return Reflect.get(target, key);
        },
      }),
    });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw hostile;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('fetch failed at the connect');
    expect(err.message).toContain('entry 0 could not be read');
    expect(err.message).toContain('1 nested errors');
    expect(err.message).not.toContain('the entries are withheld');
    expect(err.message).not.toContain('ETIMEDOUT');
    expect(err.message).not.toContain('198.51.100.7');
  });

  it('reads past an absent entry in a nested error list', async () => {
    // A hole in the list is not the end of it. Stopping at the first `undefined` would drop
    // every later kind and print a tally with nothing behind it, which is exactly the fact
    // the summary exists to add: the count says how much, the kinds say which failures.
    const inner = Object.assign(new Error('connect ETIMEDOUT 198.51.100.7:443'), {
      code: 'ETIMEDOUT',
    });
    const hostile = Object.assign(new TypeError('fetch failed at the connect'), {
      errors: [undefined, inner],
    });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw hostile;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toContain('2 nested errors');
    expect(err.message).toContain('ETIMEDOUT');
    expect(err.message).not.toContain('198.51.100.7');
  });

  it('survives the nested error list being refused as a whole', async () => {
    // A count can be withheld and entries can be withheld; the list itself can refuse to be
    // looked at. Neither of those is the same fact as a failure that carries no aggregate,
    // and an array test that swallows the refusal reports the second one — the operator
    // reads a plain connect error and never learns that a hidden list was withheld.
    const hostile = new TypeError('fetch failed at the connect');
    Object.defineProperty(hostile, 'errors', {
      get(): never {
        throw new RangeError('the list is withheld');
      },
    });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw hostile;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('fetch failed at the connect');
    expect(err.message).toContain('errors could not be read');
    expect(err.message).not.toContain('the list is withheld');
  });

  it('survives a nested error list that is itself a revoked proxy', async () => {
    // `Array.isArray` is not total either: on a revoked proxy the language requires it to
    // throw, and it stands between the guarded read of `errors` and the summary. A list
    // that arrives revoked therefore replaced the connect failure with the runtime's own
    // "IsArray on a proxy that has been revoked" — the same swallowed diagnosis, one step
    // further in than the cases above.
    const { proxy: list, revoke } = Proxy.revocable([], {});
    revoke();
    const hostile = Object.assign(new TypeError('fetch failed at the connect'), { errors: list });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch: async () => {
        throw hostile;
      },
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('fetch failed at the connect');
    expect(err.message).toContain('errors could not be read');
    expect(err.message).not.toContain('revoked');
  });

  it('does not blame the header wait for a failure after the answer started', async () => {
    // The two-wait sentence says which wait this side did not reach, and it is only true of
    // a request that was never answered. Once the response has begun, a header-timeout code
    // on the thing that broke the stream is a different failure wearing a familiar code, and
    // quoting the per-request budget next to "the body stopped arriving" tells the operator
    // to raise a number that was never the problem.
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(completionBody),
      body: {
        getReader(): never {
          throw Object.assign(new Error('Headers Timeout Error'), {
            code: 'UND_ERR_HEADERS_TIMEOUT',
          });
        },
      } as unknown as ReadableStream<Uint8Array>,
    });
    const client = createBharatCodeClient({
      config: baseConfig({
        timeoutMs: 812000,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.message).toContain('stopped arriving');
    expect(err.message).not.toContain('which the transport did not reach');
  });

  it('reports a body that stopped arriving as a body that stopped arriving', async () => {
    // `Could not reach BharatCode` belongs to the failure that never got an answer. Once
    // the response has arrived, a stream that dies during the read is the same transport
    // one step later — same retry class, same cause to print — but a different place for
    // the operator to look, and the old sentence sends them to the network when the network
    // worked.
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(completionBody),
      body: {
        getReader(): never {
          throw Object.assign(new Error('ReadableStream is locked'), {
            code: 'ERR_STREAM_ALREADY_LOCKED',
          });
        },
      } as unknown as ReadableStream<Uint8Array>,
    });
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('ERR_STREAM_ALREADY_LOCKED');
    expect(err.message).toContain('stopped arriving');
    expect(err.message).not.toContain('Could not reach BharatCode');
  });

  it('bounds an endpoint body on whole characters, never between the halves of one', async () => {
    // `bounded` is what an endpoint's bytes become when they are quoted back in `details`,
    // and it counts UTF-16 code units, so the cut can land between the two units that hold
    // one astral character and keep half of it. A lone surrogate is not a character:
    // `JSON.stringify` writes it out raw and a consumer that re-parses the report gets a
    // replacement glyph where the response used to be. The leading `!` puts every pair on
    // an odd offset, so the 200-unit cut falls inside one.
    const { fetch } = fakeFetch([{ ok: true, status: 200, raw: `!${'😀'.repeat(200)}` }]);
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const err = await client.complete({ messages: [] }).catch((e) => e);
    expect(err.kind).toBe('invalid-response');
    const body = (err.details as { body: string }).body;
    expect(body).toContain('chars)');
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(body).not.toMatch(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
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

  it('survives a health failure whose status and message refuse to be read', async () => {
    // `healthCheck` asks an `AppError`-shaped failure for the two fields it reports. The
    // identity answer does not make those fields readable, and a probe that throws while
    // being described would replace its own answer with the trap's message.
    const ours = new AppError({
      kind: 'network',
      message: 'probe failed',
      retryable: true,
      status: 503,
    });
    const hostile = new Proxy(ours, {
      get(target, key, receiver) {
        if (key === 'status' || key === 'message') throw new TypeError('trap on the health fields');
        return Reflect.get(target, key, receiver);
      },
    });
    const fetch: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{}',
        get body(): never {
          throw hostile;
        },
      }) as unknown as Awaited<ReturnType<FetchLike>>;
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }),
      fetch,
    });
    const health = await client.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.note).toBe('message could not be read');
  });
});
