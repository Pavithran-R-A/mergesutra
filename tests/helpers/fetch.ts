import type { FetchLike } from '../../src/bharatcode/client.js';

export interface FakeResponse {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: string;
}

/** Build a minimal FetchLike that returns a queued sequence of responses. */
export function fakeFetch(responses: Array<FakeResponse | Error>): {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }>;
} {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    const entry = responses[Math.min(index, responses.length - 1)] as
      FakeResponse | Error | undefined;
    calls.push({ url, init });
    index += 1;
    if (entry instanceof Error) throw entry;
    const res = entry ?? { ok: true, status: 200, body: {} };
    const headers = new Map(Object.entries(res.headers ?? {}));
    return {
      ok: res.ok,
      status: res.status,
      headers: {
        get: (name: string) => headers.get(name) ?? headers.get(name.toLowerCase()) ?? null,
      },
      text: async () => (res.raw !== undefined ? res.raw : JSON.stringify(res.body ?? {})),
    };
  };
  return { fetch, calls };
}

/** A FetchLike that hangs until the request signal aborts, then rejects AbortError. */
export function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    });
}

/** Deterministic sleeper that records requested delays instead of waiting. */
export function recordingSleeper(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

export const TEST_KEY = 'sk-bharatcode-SECRETVALUE-123';
