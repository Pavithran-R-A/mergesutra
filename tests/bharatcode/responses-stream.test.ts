import { describe, expect, it } from 'vitest';
import { createBharatCodeClient, type FetchLike } from '../../src/bharatcode/client.js';
import { AppError } from '../../src/core/errors.js';
import type { BharatCodeClientConfig } from '../../src/bharatcode/types.js';
import { fakeFetch, recordingSleeper, TEST_KEY } from '../helpers/fetch.js';
import {
  completedEvent,
  deltaEvent,
  endlessSseFetch,
  failedEvent,
  incompleteEvent,
  sseComment,
  sseEvent,
  sseFetch,
  stallingSseFetch,
} from '../helpers/sse.js';

/**
 * The documented BharatCode Responses stream.
 *
 * The provider's page names the route, the fields and the terminal events. These cases
 * pin what the adapter does with each: text arrives as deltas, keepalives are not output,
 * `completed`/`incomplete` finish the response (`max_output_tokens` preserves partial
 * text), `failed` is an error, a started stream that dies is not a success, and every
 * byte the endpoint sends is bounded and redacted on the way to a report.
 */

function baseConfig(over: Partial<BharatCodeClientConfig> = {}): BharatCodeClientConfig {
  return {
    apiKey: TEST_KEY,
    baseUrl: 'https://bharatcode.test/api/model/v1',
    model: 'bc-large',
    timeoutMs: 5_000,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    ...over,
  };
}

function clientWith(fetch: FetchLike, over: Partial<BharatCodeClientConfig> = {}) {
  return createBharatCodeClient({ config: baseConfig(over), fetch });
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(AppError);
  return caught as AppError;
}

describe('the request the adapter sends to /responses', () => {
  it('uses the documented fields, and none of the chat-completions ones', async () => {
    const fixture = sseFetch(deltaEvent('ok') + completedEvent({ text: 'ok' }));
    const client = clientWith(fixture.fetch);

    await client.complete({
      messages: [
        { role: 'system', content: 'SYS A' },
        { role: 'system', content: 'SYS B' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      temperature: 0.2,
      maxTokens: 4096,
      enableThinking: false,
    });

    const call = fixture.calls[0];
    expect(call?.url).toBe('https://bharatcode.test/api/model/v1/responses');
    expect(call?.init?.headers?.accept).toBe('text/event-stream');
    expect(call?.init?.headers?.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({
      model: 'bc-large',
      instructions: 'SYS A\n\nSYS B',
      input: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      store: false,
      stream: true,
      temperature: 0.2,
      max_output_tokens: 4096,
      reasoning: { effort: 'none' },
    });
    const sent = call?.init?.body ?? '';
    expect(sent).not.toContain(TEST_KEY);
    expect(sent).not.toContain('"messages"');
    expect(sent).not.toContain('"max_tokens"');
    expect(sent).not.toContain('chat_template_kwargs');
  });

  it('omits reasoning when thinking is not disabled, and instructions when there is no system turn', async () => {
    const fixture = sseFetch(completedEvent({ text: '' }));
    await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'plain' }],
    });
    const body = JSON.parse(fixture.calls[0]?.init?.body ?? '{}');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('instructions');
    expect(body.input).toEqual([{ role: 'user', content: 'plain' }]);
  });

  it('does not invent a reasoning effort for an explicit thinking preference', async () => {
    const fixture = sseFetch(completedEvent({ text: '' }));
    await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'think' }],
      enableThinking: true,
    });
    expect(JSON.parse(fixture.calls[0]?.init?.body ?? '{}')).not.toHaveProperty('reasoning');
  });
});

describe('reading the documented stream', () => {
  it('accumulates text deltas and finishes on response.completed', async () => {
    const fixture = sseFetch(
      sseComment('open') +
        deltaEvent('hello ') +
        sseComment('tick') +
        deltaEvent('world') +
        completedEvent({ text: 'hello world' }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'greet' }],
    });
    expect(result.text).toBe('hello world');
    expect(result.model).toBe('bc-large');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  it('treats keepalive comments as not model output', async () => {
    const fixture = sseFetch(
      ': keepalive\n\n' +
        ': response.output_text.delta {"delta":"not output"}\n\n' +
        completedEvent({ text: '' }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'quiet' }],
    });
    expect(result.text).toBe('');
  });

  it('survives frames split at every byte, including inside a multi-byte character', async () => {
    const fixture = sseFetch(
      'event: response.output_text.delta\r\n' +
        'data: {"type":"response.output_text.delta","delta":"😀"}\r\n\r\n' +
        'event: response.completed\r\n' +
        'data: {"type":"response.completed","response":{"status":"completed","model":"bc-large",' +
        '"output":[{"type":"message","content":[{"type":"output_text","text":"😀"}]}]}}\r\n\r\n',
      { chunkBytes: 1 },
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'emoji' }],
    });
    expect(result.text).toBe('😀');
  });

  it('joins multi-line data fields before parsing them', async () => {
    const fixture = sseFetch(
      'event: response.completed\n' +
        'data: {"type":"response.completed",\n' +
        'data: "response":{"status":"completed","model":"bc-large","output":[]}}\n\n',
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'split' }],
    });
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('stop');
  });

  it('uses the event name when the data object carries no type', async () => {
    const fixture = sseFetch(
      sseEvent('response.output_text.delta', { delta: 'named' }) +
        sseEvent('response.completed', { response: { status: 'completed', output: [] } }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'type-less' }],
    });
    expect(result.text).toBe('named');
  });

  it('falls back to accumulated deltas when a completed response carries no output', async () => {
    const fixture = sseFetch(
      deltaEvent('only ') + deltaEvent('deltas') + completedEvent({ text: undefined }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'fallback' }],
    });
    expect(result.text).toBe('only deltas');
    expect(result.finishReason).toBe('stop');
  });

  it('ignores a [DONE] sentinel that follows response.completed', async () => {
    const fixture = sseFetch(
      deltaEvent('finished') + completedEvent({ text: 'finished answer' }) + 'data: [DONE]\n\n',
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'sentinel' }],
    });
    expect(result.text).toBe('finished answer');
    expect(result.finishReason).toBe('stop');
  });

  it('does not offer delta text as a finished answer when the terminal message speaks', async () => {
    const fixture = sseFetch(
      deltaEvent('streamed ') +
        deltaEvent('answer') +
        sseEvent('response.completed', {
          type: 'response.completed',
          response: {
            status: 'completed',
            model: 'bc-large',
            output: [{ type: 'message', role: 'assistant', content: [] }],
          },
        }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'shadowed' }],
    });
    // The message is the provider's final copy and it contains nothing, so nothing is the
    // answer. Reassembling deltas into a `stop` would let a partial become an instruction.
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('stop');
  });

  it('reports a refusal as the answer, not the text streamed before it', async () => {
    const fixture = sseFetch(
      deltaEvent('streamed ') +
        deltaEvent('answer') +
        sseEvent('response.completed', {
          type: 'response.completed',
          response: {
            status: 'completed',
            model: 'bc-large',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'refusal', refusal: 'I will not help with that' }],
              },
            ],
          },
        }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'refused' }],
    });
    // The decline is the provider's final copy, so it is what the caller gets to read —
    // not the words streamed before it, and not silence.
    expect(result.text).toBe('I will not help with that');
    expect(result.finishReason).toBe('stop');
  });

  it('reports a refusal when nothing was streamed before it', async () => {
    const fixture = sseFetch(
      sseEvent('response.completed', {
        type: 'response.completed',
        response: {
          status: 'completed',
          model: 'bc-large',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: 'I cannot do that' }],
            },
          ],
        },
      }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'refused quietly' }],
    });
    expect(result.text).toBe('I cannot do that');
    expect(result.finishReason).toBe('stop');
  });

  it('reports the answer as empty when the terminal message says it is', async () => {
    const fixture = sseFetch(
      deltaEvent('streamed ') +
        deltaEvent('answer') +
        sseEvent('response.completed', {
          type: 'response.completed',
          response: {
            status: 'completed',
            model: 'bc-large',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '' }],
              },
            ],
          },
        }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'withheld' }],
    });
    // What the provider finally wrote is empty, so the deltas it streamed during the answer
    // are not offered to the application as a whole one.
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('stop');
  });

  it('does not read an empty data field as an event to parse', async () => {
    const fixture = sseFetch('data:\n\n' + deltaEvent('kept') + completedEvent({ text: 'kept' }));
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'heartbeat' }],
    });
    expect(result.text).toBe('kept');
  });
});

describe('a response that stops at the output limit', () => {
  it('returns the partial text with the documented reason, and does not retry', async () => {
    const fixture = sseFetch(
      deltaEvent('partial ') +
        incompleteEvent('max_output_tokens', { text: 'partial answer', usage: true }),
    );
    const { sleep, delays } = recordingSleeper();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 } }),
      fetch: fixture.fetch,
      sleeper: sleep,
    });
    const result = await client.complete({
      messages: [{ role: 'user', content: 'long' }],
      maxTokens: 16,
    });
    expect(result.text).toBe('partial answer');
    expect(result.finishReason).toBe('max_output_tokens');
    expect(fixture.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('reports a structured-output call that hit the limit as a limit, not as bad JSON', async () => {
    const fixture = sseFetch(
      deltaEvent('{"answer":') + incompleteEvent('max_output_tokens', { text: '{"answer":' }),
    );
    const client = clientWith(fixture.fetch);
    const error = await failure(
      client.completeStructured({
        messages: [{ role: 'user', content: 'json' }],
        validate: (value) => value,
      }),
    );
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toMatch(/max_output_tokens|output limit/i);
    expect(error.message).not.toMatch(/not valid JSON/i);
  });
});

describe('a response that fails', () => {
  const UNSHAPED_KEY = 'Qz7Hn2Wp9Tr4Xk8B';

  it('is an error that names the provider code and the request id', async () => {
    const fixture = sseFetch(failedEvent({ code: 'server_error', message: 'model is busy' }), {
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-abc-123' },
    });
    const error = await failure(
      clientWith(fixture.fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('server');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('server_error');
    expect(error.message).toContain('model is busy');
    expect(error.message).toContain('req-abc-123');
    expect(error.details).toMatchObject({ requestId: 'req-abc-123' });
  });

  it('masks a credential the stream quoted in its failure', async () => {
    const fixture = sseFetch(
      failedEvent({ code: 'server_error', message: `busy while using ${UNSHAPED_KEY}` }),
    );
    const error = await failure(
      clientWith(fixture.fetch, { apiKey: UNSHAPED_KEY }).complete({
        messages: [{ role: 'user', content: 'go' }],
      }),
    );
    expect(error.message).not.toContain(UNSHAPED_KEY);
    expect(error.message).toContain('[REDACTED]');
  });

  it('is not retried after output has already begun', async () => {
    const fixture = sseFetch(
      deltaEvent('partial') + failedEvent({ code: 'server_error', message: 'busy' }),
    );
    const { sleep, delays } = recordingSleeper();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 } }),
      fetch: fixture.fetch,
      sleeper: sleep,
    });
    const error = await failure(client.complete({ messages: [{ role: 'user', content: 'go' }] }));
    expect(error.retryable).toBe(false);
    expect(fixture.calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(error.details).toMatchObject({ afterOutput: true });
  });

  it('is retried while no output has arrived, within the configured bound', async () => {
    const fixture = sseFetch(failedEvent({ code: 'server_error', message: 'busy' }));
    const second = sseFetch(deltaEvent('ok') + completedEvent({ text: 'ok' }));
    let calls = 0;
    const fetch: FetchLike = async (url, init) => {
      calls += 1;
      return calls === 1 ? fixture.fetch(url, init) : second.fetch(url, init);
    };
    const { sleep, delays } = recordingSleeper();
    const client = createBharatCodeClient({
      config: baseConfig({ retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } }),
      fetch,
      sleeper: sleep,
    });
    const result = await client.complete({ messages: [{ role: 'user', content: 'go' }] });
    expect(result.text).toBe('ok');
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
  });

  it('is not retried when the provider blames the request or the account', async () => {
    for (const code of [
      'insufficient_quota',
      'context_length_exceeded',
      'data_inspection_failed',
    ]) {
      const fixture = sseFetch(failedEvent({ code, message: 'this request will never answer' }));
      const { sleep, delays } = recordingSleeper();
      const client = createBharatCodeClient({
        config: baseConfig({ retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 } }),
        fetch: fixture.fetch,
        sleeper: sleep,
      });
      const error = await failure(client.complete({ messages: [{ role: 'user', content: 'go' }] }));
      expect(error.kind, code).toBe('server');
      expect(error.retryable, code).toBe(false);
      expect(delays, code).toEqual([]);
      expect(fixture.calls, code).toHaveLength(1);
    }
  });
});

describe('a stream that does not finish cleanly', () => {
  it('refuses truncated JSON instead of letting a SyntaxError escape', async () => {
    const fixture = sseFetch(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel',
    );
    const error = await failure(
      clientWith(fixture.fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('invalid-response');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/event|JSON/i);
    expect(error.message).not.toContain('SyntaxError');
  });

  it('refuses a clean end of stream that never named a terminal event', async () => {
    const fixture = sseFetch(deltaEvent('partial'));
    const error = await failure(
      clientWith(fixture.fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toMatch(/ended|terminal|completed|incomplete/i);
  });

  it('refuses a [DONE] sentinel that never named a terminal response event', async () => {
    const fixture = sseFetch(deltaEvent('partial answer') + 'data: [DONE]\n\n');
    const error = await failure(
      clientWith(fixture.fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('invalid-response');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/DONE|terminal|completed|incomplete/i);
  });

  it('refuses a stream larger than the bounded read, and stops taking bytes', async () => {
    const CAP = 4 * 1024 * 1024;
    const fixture = endlessSseFetch();
    const error = await failure(
      clientWith(fixture.fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toContain(String(CAP));
    expect(fixture.delivered.produced).toBeLessThanOrEqual(CAP + 4 * 64 * 1024);
    expect(fixture.delivered.cancelled).toBe(true);
  });
});

describe('cancellation and the per-request budget, mid-stream', () => {
  it('reports a caller abort as cancelled and stops reading', async () => {
    const fixture = stallingSseFetch(deltaEvent('partial'));
    const controller = new AbortController();
    const client = clientWith(fixture.fetch);
    const promise = client.complete({
      messages: [{ role: 'user', content: 'go' }],
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const error = await failure(promise);
    expect(error.kind).toBe('cancelled');
    expect(error.retryable).toBe(false);
    expect(fixture.delivered.cancelled).toBe(true);
  });

  it('reports the adapter budget firing mid-stream as a retryable timeout', async () => {
    const fixture = stallingSseFetch(deltaEvent('partial'));
    const client = clientWith(fixture.fetch, {
      timeoutMs: 25,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const error = await failure(client.complete({ messages: [{ role: 'user', content: 'go' }] }));
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(fixture.delivered.cancelled).toBe(true);
  });
});

describe('function calls in the output array', () => {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"Delhi"}',
    status: 'completed',
  };

  it('returns complete calls alongside text, without executing them', async () => {
    const fixture = sseFetch(completedEvent({ text: 'I will look that up.', extraOutput: [call] }));
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'weather' }],
    });
    expect(result.text).toBe('I will look that up.');
    expect(result.toolCalls).toEqual([
      { callId: 'call_1', name: 'get_weather', arguments: '{"city":"Delhi"}' },
    ]);
  });

  it('does not expose a call from an incomplete response', async () => {
    const fixture = sseFetch(
      incompleteEvent('max_output_tokens', { text: 'thinking', extraOutput: [call] }),
    );
    const result = await clientWith(fixture.fetch).complete({
      messages: [{ role: 'user', content: 'weather' }],
      maxTokens: 8,
    });
    expect(result.finishReason).toBe('max_output_tokens');
    expect(result.toolCalls).toBeUndefined();
  });

  it('refuses a call that is missing the fields the application would need', async () => {
    const fixture = sseFetch(
      completedEvent({
        text: '',
        extraOutput: [{ type: 'function_call', call_id: 'call_1', arguments: '{}' }],
      }),
    );
    const error = await failure(
      clientWith(fixture.fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toMatch(/function call|name/i);
    expect(error.message).not.toContain('call_1');
  });
});

describe('a gateway that answers /responses with JSON instead of SSE', () => {
  it('parses a completed response object', async () => {
    const { fetch } = fakeFetch([
      {
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          status: 'completed',
          model: 'bc-large',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'buffered' }] }],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      },
    ]);
    const result = await clientWith(fetch).complete({
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.text).toBe('buffered');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  });

  it('parses an incomplete response object as the partial result it is', async () => {
    const { fetch } = fakeFetch([
      {
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          status: 'incomplete',
          model: 'bc-large',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'half' }] }],
        },
      },
    ]);
    const result = await clientWith(fetch).complete({
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.text).toBe('half');
    expect(result.finishReason).toBe('max_output_tokens');
  });

  it('refuses a failed response object as a failure', async () => {
    const { fetch } = fakeFetch([
      {
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          status: 'failed',
          error: { code: 'server_error', message: 'busy' },
        },
      },
    ]);
    const error = await failure(
      clientWith(fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('server');
    expect(error.message).toContain('server_error');
  });
});

describe('the stream is read through the same transport guards', () => {
  it('reports an HTTP failure with the request id and the retry-after it carried', async () => {
    const fixture = sseFetch('', {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-503',
        'retry-after': '2',
      },
    });
    const error = await failure(
      clientWith(fixture.fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('server');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(2000);
    expect(error.details).toMatchObject({ requestId: 'req-503' });
  });

  it('still names a locked body as the body that stopped arriving', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-type' ? 'text/event-stream' : null) },
      text: async () => '',
      body: {
        getReader(): never {
          throw Object.assign(new Error('ReadableStream is locked'), {
            code: 'ERR_STREAM_ALREADY_LOCKED',
          });
        },
      } as unknown as ReadableStream<Uint8Array>,
    });
    const error = await failure(
      clientWith(fetch).complete({ messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(error.kind).toBe('network');
    expect(error.message).toContain('ERR_STREAM_ALREADY_LOCKED');
    expect(error.message).toContain('stopped arriving');
  });
});
