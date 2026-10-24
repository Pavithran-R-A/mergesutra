import type { FetchLike } from '../../src/bharatcode/client.js';

/**
 * Local fixtures for the BharatCode Responses stream.
 *
 * The provider documents the wire, not a schema page: text arrives in
 * `response.output_text.delta`, a response finishes on `response.completed` or
 * `response.incomplete`, a started stream that fails ends with `response.failed`, and
 * queue keepalive comments are not model output. These builders write those frames so
 * the adapter can be exercised with no socket and no spend.
 */

export const SSE_HEADERS: Record<string, string> = { 'content-type': 'text/event-stream' };

export function sseEvent(name: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${name}\ndata: ${payload}\n\n`;
}

/** A queue keepalive: a comment line, which the provider says is not model output. */
export function sseComment(text = 'keepalive'): string {
  return `: ${text}\n\n`;
}

export function deltaEvent(delta: string): string {
  return sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta });
}

export interface CompletedOptions {
  readonly text?: string;
  readonly model?: string;
  readonly usage?: boolean;
  readonly extraOutput?: readonly unknown[];
}

export function completedObject(options: CompletedOptions = {}): Record<string, unknown> {
  return {
    id: 'resp_fixture',
    object: 'response',
    status: 'completed',
    model: options.model ?? 'bc-large',
    output: [
      ...(options.text === undefined
        ? []
        : [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: options.text }],
            },
          ]),
      ...(options.extraOutput ?? []),
    ],
    ...(options.usage === false
      ? {}
      : { usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } }),
  };
}

export function completedEvent(options: CompletedOptions = {}): string {
  return sseEvent('response.completed', {
    type: 'response.completed',
    response: completedObject(options),
  });
}

export function incompleteEvent(reason: string, options: CompletedOptions = {}): string {
  return sseEvent('response.incomplete', {
    type: 'response.incomplete',
    response: {
      ...completedObject(options),
      status: 'incomplete',
      incomplete_details: { reason },
    },
  });
}

export function failedEvent(error: { code?: string; message?: string }): string {
  return sseEvent('response.failed', {
    type: 'response.failed',
    response: {
      id: 'resp_fixture',
      object: 'response',
      status: 'failed',
      error,
    },
  });
}

export interface SseScript {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** Bytes per delivered chunk; 1 splits every multi-byte character. */
  readonly chunkBytes?: number;
}

export interface ScriptedSse {
  readonly fetch: FetchLike;
  readonly calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }>;
  readonly delivered: { readonly cancelled: boolean; readonly produced: number };
}

/** A response whose body is `body`, delivered in chunks and stoppable. */
export function sseFetch(body: string, script: SseScript = {}): ScriptedSse {
  const bytes = new TextEncoder().encode(body);
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  let cancelled = false;
  let produced = 0;

  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) return;
        if (produced >= bytes.byteLength) {
          controller.close();
          return;
        }
        const size = script.chunkBytes ?? bytes.byteLength;
        const piece = bytes.slice(produced, produced + size);
        produced += piece.byteLength;
        controller.enqueue(piece);
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = script.headers ?? SSE_HEADERS;
    return {
      ok: (script.status ?? 200) < 400,
      status: script.status ?? 200,
      headers: {
        get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
      },
      text: async () => body,
      body: stream,
    };
  };

  return {
    fetch,
    calls,
    delivered: {
      get cancelled() {
        return cancelled;
      },
      get produced() {
        return produced;
      },
    },
  };
}

/** A body that delivers `first`, waits `delayMs`, then delivers `rest` and closes. */
export function delayedSseFetch(
  first: string,
  rest: string,
  delayMs: number,
): { fetch: FetchLike; delivered: { readonly cancelled: boolean } } {
  const encoder = new TextEncoder();
  let cancelled = false;
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
    },
    text: async () => first + rest,
    body: new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(first));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (cancelled) return;
        controller.enqueue(encoder.encode(rest));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  return {
    fetch,
    delivered: {
      get cancelled() {
        return cancelled;
      },
    },
  };
}

/** A body that delivers `first`, then stalls until the request signal aborts. */
export function stallingSseFetch(first: string): {
  fetch: FetchLike;
  delivered: { readonly cancelled: boolean };
} {
  const bytes = new TextEncoder().encode(first);
  let sent = false;
  let cancelled = false;
  const fetch: FetchLike = async (_url, init) => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
    },
    text: async () => first,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        const signal = init?.signal;
        return new Promise<void>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener('abort', abort, { once: true });
        });
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  return {
    fetch,
    delivered: {
      get cancelled() {
        return cancelled;
      },
    },
  };
}

/** A stream that never ends and never sends a complete line. */
export function endlessSseFetch(chunkBytes = 64 * 1024): {
  fetch: FetchLike;
  delivered: { readonly cancelled: boolean; readonly produced: number };
} {
  const filler = new Uint8Array(chunkBytes).fill(0x61);
  let cancelled = false;
  let produced = 0;
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
    },
    text: async () => '',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) return;
        produced += filler.byteLength;
        controller.enqueue(filler.slice());
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  return {
    fetch,
    delivered: {
      get cancelled() {
        return cancelled;
      },
      get produced() {
        return produced;
      },
    },
  };
}
