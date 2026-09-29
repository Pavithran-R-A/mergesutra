import { describe, expect, it } from 'vitest';
import { createBharatCodeClient, type FetchLike } from '../../src/bharatcode/client.js';
import type { BharatCodeClientConfig } from '../../src/bharatcode/types.js';
import { fakeFetch, TEST_KEY } from '../helpers/fetch.js';

/**
 * S12-15 — how much of a response body the adapter is willing to hold.
 *
 * `rawRequest` read the body with `await response.text()`, which asks the endpoint for as
 * much as the endpoint wants to send. Everything downstream of it is careful — the error
 * detail is clipped at 500 chars, the schema strips unknown fields, Zod refuses a
 * mis-shaped object — but the read itself had no ceiling, so the one thing a remote could
 * still dictate to this process was how many bytes it materialises before being turned down.
 *
 * The measurements here are therefore not about the error's wording. Each scripted endpoint
 * counts the bytes it has handed over, whichever method the adapter used to take them, so a
 * run that drains the whole body fails on the counter even if it happens to end up with the
 * right error class. The `text()` half of every script reads the same stream the `body` half
 * does, exactly as a real `Response` would: there is no version of this where ignoring the
 * bound is silently cheaper.
 *
 * Five claims, in the order a hostile endpoint would be met:
 *
 * 1. A body that never stops is refused, and the read is *stopped* — bytes stop being
 *    requested and the stream reports a cancellation.
 * 2. The bound is a real boundary: a response of exactly that size is read and parsed, one
 *    byte more is refused for being over the bound rather than for being unparseable.
 * 3. A 5xx whose error page is over the bound is still the 5xx error, still retryable, still
 *    with a short body excerpt — hitting the ceiling must not cost the caller the status.
 * 4. A read interrupted by the request's own timeout is reported as that interruption. The
 *    old `.catch(() => '')` turned "the body never arrived" into "the body was empty", which
 *    the adapter then described as a non-JSON response and refused to retry.
 * 5. Normal traffic is unharmed on both shapes of response: one that exposes a stream and
 *    one that only offers `text()`.
 */

/** The bound this stage fixes as the contract, in bytes. */
const CAP = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const ENCODER = new TextEncoder();

/** Slack for the queue a `ReadableStream` is allowed to fill ahead of the reads. */
const READ_AHEAD = 4 * CHUNK;

function config(over: Partial<BharatCodeClientConfig> = {}): BharatCodeClientConfig {
  return {
    apiKey: TEST_KEY,
    baseUrl: 'https://bharatcode.test/api/model/v1',
    model: 'bc-large',
    timeoutMs: 5_000,
    retry: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 400 },
    ...over,
  };
}

/** What a scripted endpoint handed over, no matter how the adapter asked for it. */
interface Delivered {
  /** Bytes released to the adapter. */
  produced: number;
  /** Whether the adapter cancelled the stream instead of running it to the end. */
  cancelled: boolean;
}

function completionJson(content: string): string {
  return `{"choices":[{"message":{"role":"assistant","content":${JSON.stringify(
    content,
  )}},"finish_reason":"stop"}],"model":"bc-large"}`;
}

/** A well-formed completion whose serialized body is exactly `bytes` long (ASCII padding). */
function completionOfByteLength(bytes: number): string {
  const overhead = completionJson('').length;
  return completionJson('x'.repeat(Math.max(0, bytes - overhead)));
}

interface Script {
  readonly ok: boolean;
  readonly status: number;
  /** Real bytes to serve, or the total size of an endless filler body. */
  readonly body: string | { readonly endless: number };
  readonly headers?: Record<string, string>;
  readonly chunk?: number;
}

/**
 * A response that counts its own output.
 *
 * `text()` drains the same stream `body` exposes, so the counter measures the adapter's
 * appetite rather than which property it happened to reach for.
 */
function scriptedFetch(script: Script): { fetch: FetchLike; delivered: Delivered } {
  const size = script.chunk ?? CHUNK;
  const delivered: Delivered = { produced: 0, cancelled: false };
  const filler = new Uint8Array(size).fill(0x61);
  const bytes = typeof script.body === 'string' ? ENCODER.encode(script.body) : new Uint8Array(0);
  const total = typeof script.body === 'string' ? bytes.byteLength : script.body.endless;

  const makeStream = () => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered.cancelled) return;
        if (offset >= total) {
          controller.close();
          return;
        }
        const wanted = Math.min(size, total - offset);
        const piece =
          bytes.byteLength > 0 ? bytes.slice(offset, offset + wanted) : filler.slice(0, wanted);
        offset += piece.byteLength;
        delivered.produced += piece.byteLength;
        controller.enqueue(piece);
      },
      cancel: () => {
        delivered.cancelled = true;
      },
    });
  };

  const fetch: FetchLike = async () => {
    const stream = makeStream();
    return {
      ok: script.ok,
      status: script.status,
      headers: {
        get: (name: string) =>
          script.headers?.[name] ?? script.headers?.[name.toLowerCase()] ?? null,
      },
      body: stream,
      text: async () => {
        const reader = stream.getReader();
        const parts: Uint8Array[] = [];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          parts.push(next.value);
        }
        const all = new Uint8Array(delivered.produced);
        let at = 0;
        for (const part of parts) {
          all.set(part, at);
          at += part.byteLength;
        }
        return new TextDecoder().decode(all);
      },
    };
  };
  return { fetch, delivered };
}

/**
 * A response whose body stalls until the request's own signal aborts, then fails.
 *
 * This is a server that sends headers, starts a body, and stops talking — the shape that
 * `timeoutMs` exists for. Both read paths stall the same way, because the claim is about
 * what the adapter concludes, not about which method it used.
 */
function stallingFetch(): { fetch: FetchLike; aborts: { count: number } } {
  const aborts = { count: 0 };
  const abortError = () => Object.assign(new Error('body read aborted'), { name: 'AbortError' });
  const fetch: FetchLike = async (_url, init) => {
    const signal = init?.signal;
    const wait = () =>
      new Promise<void>((resolve, reject) => {
        if (!signal) return reject(new Error('no signal was handed to the body'));
        if (signal.aborted) {
          aborts.count += 1;
          return reject(abortError());
        }
        signal.addEventListener(
          'abort',
          () => {
            aborts.count += 1;
            reject(abortError());
          },
          { once: true },
        );
      });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull: () =>
          wait().catch((error: unknown) => {
            throw error;
          }),
      }),
      text: () => wait().then(() => ''),
    };
  };
  return { fetch, aborts };
}

describe('a response body that does not stop', () => {
  it('refuses it and stops asking for more', async () => {
    const { fetch, delivered } = scriptedFetch({
      ok: true,
      status: 200,
      body: { endless: CAP * 8 },
    });
    const client = createBharatCodeClient({ config: config(), fetch });
    const error = await client
      .complete({ messages: [{ role: 'user', content: 'go' }] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid-response', retryable: false });
    // The whole point: the endpoint never stopped offering, and the adapter stopped taking.
    expect(delivered.produced).toBeLessThanOrEqual(CAP + READ_AHEAD);
    expect(delivered.cancelled).toBe(true);
  });

  it('reads a body of exactly the bound, and refuses one byte past it', async () => {
    const exact = scriptedFetch({
      ok: true,
      status: 200,
      body: completionOfByteLength(CAP),
    });
    const client = createBharatCodeClient({ config: config(), fetch: exact.fetch });
    const result = await client.complete({ messages: [{ role: 'user', content: 'go' }] });
    expect(result.text.length).toBe(CAP - completionJson('').length);

    const over = scriptedFetch({
      ok: true,
      status: 200,
      body: completionOfByteLength(CAP + 1),
    });
    const second = createBharatCodeClient({ config: config(), fetch: over.fetch });
    const error = await second
      .complete({ messages: [{ role: 'user', content: 'go' }] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid-response' });
    // Not "could not parse" — the size is the stated reason, and it is the contract's number.
    expect(String((error as { message?: string }).message)).toMatch(
      /larger than|exceeds|too (large|big)/i,
    );
    expect(String((error as { message?: string }).message)).toContain(String(CAP));
    expect(over.delivered.produced).toBeLessThanOrEqual(CAP + READ_AHEAD);
  });

  it('refuses one past the bound on the path that has no stream to stop', async () => {
    // A `fetch` that only offers `text()` has already materialised the body before this
    // client sees it, so the bound here is on what gets parsed and kept, not on what is
    // allocated. The case exists so that weaker guarantee is still a guarantee, and is
    // still checked, rather than a branch nobody exercises.
    const { fetch } = fakeFetch([{ ok: true, status: 200, raw: completionOfByteLength(CAP + 1) }]);
    const client = createBharatCodeClient({ config: config(), fetch });
    const error = await client
      .complete({ messages: [{ role: 'user', content: 'go' }] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid-response', retryable: false });
    expect(String((error as { message?: string }).message)).toContain(String(CAP));
  });

  it('keeps a 5xx whose error page is over the bound a retryable 5xx, with a short excerpt', async () => {
    const { fetch, delivered } = scriptedFetch({
      ok: false,
      status: 500,
      body: { endless: CAP * 8 },
    });
    const client = createBharatCodeClient({ config: config(), fetch });
    const error = await client
      .complete({ messages: [{ role: 'user', content: 'go' }] })
      .catch((caught: unknown) => caught);
    // The ceiling must not cost the caller the status it was about, or the retry it earns.
    expect(error).toMatchObject({ kind: 'server', status: 500, retryable: true });
    expect(delivered.produced).toBeLessThanOrEqual(CAP + READ_AHEAD);
    const details = (error as { details?: Record<string, unknown> }).details ?? {};
    expect(String(details['body'] ?? '').length).toBeLessThanOrEqual(600);
  });

  it('still calls an over-bound HTML page an invalid response, and quotes it briefly', async () => {
    const page = `<html><body>${'<p>proxy</p>'.repeat(400)}</body></html>`.padEnd(CAP + 1024, ' ');
    const { fetch, delivered } = scriptedFetch({ ok: true, status: 200, body: page });
    const client = createBharatCodeClient({ config: config(), fetch });
    const error = await client
      .complete({ messages: [{ role: 'user', content: 'go' }] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid-response', retryable: false });
    expect(delivered.produced).toBeLessThanOrEqual(CAP + READ_AHEAD);
  });
});

describe('a body that stops arriving', () => {
  it('reports the interruption, not an empty response', async () => {
    const { fetch, aborts } = stallingFetch();
    const client = createBharatCodeClient({ config: config({ timeoutMs: 50 }), fetch });
    const error = await client
      .complete({ messages: [{ role: 'user', content: 'go' }] })
      .catch((caught: unknown) => caught);
    // A stalled `pull` can be counted twice — the stream fills its own queue before the
    // body is asked for — so this records that the read was cut short, not how once.
    expect(aborts.count).toBeGreaterThanOrEqual(1);
    // "The body never arrived" is a timeout the retry policy can act on. It is not a
    // non-JSON body, which the adapter treats as the model's fault and refuses to retry.
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
  });
});

describe('ordinary traffic on both shapes of response', () => {
  it('parses a completion that arrives as a stream', async () => {
    const { fetch, delivered } = scriptedFetch({
      ok: true,
      status: 200,
      body: completionJson('hello from the other side'),
      chunk: 16,
    });
    const client = createBharatCodeClient({ config: config(), fetch });
    const result = await client.complete({ messages: [{ role: 'user', content: 'go' }] });
    expect(result.text).toBe('hello from the other side');
    expect(delivered.cancelled).toBe(false);
  });

  it('parses a completion from a response that only offers text()', async () => {
    const { fetch } = fakeFetch([
      {
        ok: true,
        status: 200,
        body: {
          choices: [
            { message: { role: 'assistant', content: 'no stream here' }, finish_reason: 'stop' },
          ],
          model: 'bc-large',
        },
      },
    ]);
    const client = createBharatCodeClient({ config: config(), fetch });
    const result = await client.complete({ messages: [{ role: 'user', content: 'go' }] });
    expect(result.text).toBe('no stream here');
  });

  it('keeps reporting a 4xx that carries no body at all as the status it is', async () => {
    const { fetch } = scriptedFetch({ ok: false, status: 404, body: '' });
    const client = createBharatCodeClient({ config: config(), fetch });
    const error = await client
      .complete({ messages: [{ role: 'user', content: 'go' }] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'not-found', status: 404, retryable: false });
  });
});
