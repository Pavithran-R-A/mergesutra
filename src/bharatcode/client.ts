import { AppError, kindForStatus } from '../core/errors.js';
import { Redactor } from '../security/redaction.js';
import { terminalSafeSingleLine } from '../security/terminal-safety.js';
import { parseCompletion, parseModelList } from './schemas.js';
import { parseRetryAfter, runWithRetry, throwIfCancelled } from './retry.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  type BharatCodeClientConfig,
  type CompletionRequest,
  type CompletionResult,
  type HealthResult,
  type ModelList,
  type Sleeper,
  type StructuredRequest,
} from './types.js';

/**
 * The BharatCode adapter.
 *
 * `BharatCodeClient` is the abstraction the rest of the application depends on.
 * `HttpBharatCodeClient` is the only place that knows BharatCode is an
 * OpenAI-compatible HTTP service. `fetch`, the `sleeper`, and `random` are
 * dependency-injected so the whole adapter is testable with zero live network.
 */

export interface BharatCodeClient {
  listModels(): Promise<ModelList>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  completeStructured<T>(request: StructuredRequest<T>): Promise<T>;
  healthCheck(): Promise<HealthResult>;
}

/** Minimal structural type for the injected fetch (works with undici & mocks). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /**
   * The body as a stream, when the implementation exposes one. Reading it is what makes
   * `MAX_RESPONSE_BYTES` a limit on memory rather than a limit on what gets parsed: an
   * implementation without one still works, and gives up the earlier guarantee.
   */
  body?: ReadableStream<Uint8Array> | null;
}>;

const realFetch: FetchLike = (input, init) =>
  fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>;

export interface ClientDeps {
  config?: Partial<BharatCodeClientConfig>;
  fetch?: FetchLike;
  sleeper?: Sleeper;
  random?: () => number;
  redactor?: Redactor;
  onRetry?: (info: { attempt: number; kind: string; delayMs: number }) => void;
}

/**
 * The three things one body read can end as, kept apart because the caller has to report
 * them differently. See `HttpBharatCodeClient.readBody`.
 */
interface BodyRead {
  readonly text: string;
  /** The endpoint offered past `MAX_RESPONSE_BYTES`, and this side stopped taking. */
  readonly over: boolean;
  /** The read itself failed — an interruption, not a body that arrived empty. */
  readonly failed: unknown;
}

const defaultSleeper: Sleeper = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(cancelled());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function cancelled(): AppError {
  return new AppError({ kind: 'cancelled', message: 'Operation was cancelled.', retryable: false });
}

/** Unique sentinel so an internal timeout abort is never confused with a user cancellation. */
const TIMEOUT_REASON: { readonly mergesutra: 'timeout' } = { mergesutra: 'timeout' };

/**
 * What the transport actually said, including what it said underneath.
 *
 * Node's `fetch` reports a refused, interrupted or never-answered request as one
 * message — `fetch failed` — and puts the error that distinguishes those cases one
 * level down in `cause`. A live run that lost a paid request to the undici headers
 * timeout was reported to the operator as `Could not reach BharatCode: fetch failed`,
 * which is consistent with a dead hostname, a dropped TLS session and a gateway that
 * accepted the connection and never answered. Those need different fixes, and the
 * four words cannot tell them apart.
 *
 * The headline names the error as well as quoting it, because the code that separates
 * those cases is not always one level down: an adapter, or a later transport, can
 * propagate the coded error directly, and a headline built from `message` alone would
 * drop both its name and the code the reader needs.
 *
 * Both halves come off somebody else's connection, so both are put through the encoder
 * the CLI sink uses and held to a length of our choosing: an operator's report should
 * not become a socket's transcript.
 * Each half is bounded on its own, not the string after joining them: a chatty
 * headline must not be able to crowd out the cause code, which is the whole diagnosis.
 */
function transportDetail(error: unknown): string {
  const headline = oneLine(describeForeign(error), 160);
  const cause = error instanceof Error ? error.cause : undefined;
  const detail = cause === undefined ? '' : oneLine(describeForeign(cause), 240);
  return detail === '' ? headline : `${headline} (cause: ${detail})`;
}

/**
 * Collapse a foreign string to one bounded line. Truncation is expected, not an error.
 *
 * Encoding, not filtering: the set of bytes that may not travel a report is the terminal
 * sink's own (`terminalSafeSingleLine`), and a socket that sent a control byte is worth
 * reading about — a filter that deleted it would hand the operator a message that quietly
 * differs from what arrived. The bound is taken after encoding, and by code point, because
 * `slice` counts the UTF-16 units that hold them and can cut a surrogate pair in half.
 *
 * This is the one path that encodes before redacting rather than after, and the measured
 * order is the stricter of the two. `Redactor.text` masks a known secret by exact substring,
 * and the encoder rewrites nothing outside the terminal-control ranges, so a printable
 * credential reaches it unchanged; and the pattern path captures a value with a class that
 * stops at whitespace, over which U+000A, U+000B, U+000C, U+2028 and U+2029 are whitespace
 * and U+0085 is not — a secret split by a raw line break masks one half in the source form
 * and all of it here. The output boundary is untouched: `src/cli/program.ts:519` still runs
 * redaction and then terminal safety, and re-escaping this string cannot change it, because
 * what the encoder emits holds no code point the encoder forges.
 */
function oneLine(value: string, limit: number): string {
  return [...terminalSafeSingleLine(value)].slice(0, limit).join('');
}

/**
 * A short, safe name for something a connection handed back.
 *
 * `String()` of a plain object is `[object Object]`, which names nothing — and printing
 * that object's *values* is how a request payload, headers included, can end up on a
 * screen. So a bare object is described by its key names, which say what it was without
 * saying what was in it, and an `AggregateError` — undici's real multi-address connect
 * failure, whose own message distinguishes nothing — is described by how much it hides,
 * never by what it hides.
 */
function describeForeign(value: unknown): string {
  if (value instanceof Error) {
    const named = [value.name, (value as { code?: string }).code, value.message]
      .filter(Boolean)
      .join(' ');
    const nested = (value as { errors?: unknown }).errors;
    return Array.isArray(nested) ? `${named}; ${nested.length} nested errors` : named;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    try {
      const keys = Object.keys(value).slice(0, 8);
      return keys.length === 0 ? 'object' : `object with keys ${keys.join(', ')}`;
    } catch {
      // `Object.keys` is not a total function: a proxy with a throwing `ownKeys` trap makes
      // the act of describing a failure throw, and the diagnosis would be replaced by the
      // trap's own error. Naming the refusal is the most this helper can say.
      return 'object that could not be described';
    }
  }
  return String(value);
}

/**
 * The transport error code, whether the rejection carries it or wraps it.
 *
 * Node puts undici's code one level down in `cause`, but only because Node wraps; an
 * adapter that propagates the coded error directly has the same code at the top, and
 * reading only the cause would leave `transportWait` silent about the failure it exists
 * to explain.
 */
function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const own = (error as { code?: string }).code;
  if (typeof own === 'string') return own;
  const cause = error.cause;
  return cause instanceof Error ? (cause as { code?: string }).code : undefined;
}

export class HttpBharatCodeClient implements BharatCodeClient {
  private readonly config: BharatCodeClientConfig;
  private readonly fetch: FetchLike;
  private readonly sleeper: Sleeper;
  private readonly random: () => number;
  private readonly redactor: Redactor;
  private readonly onRetry?: ClientDeps['onRetry'];

  constructor(deps: ClientDeps = {}) {
    this.config = {
      apiKey: deps.config?.apiKey,
      baseUrl: deps.config?.baseUrl ?? DEFAULT_BASE_URL,
      model: deps.config?.model,
      timeoutMs: deps.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retry: {
        maxRetries: deps.config?.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
        baseDelayMs: deps.config?.retry?.baseDelayMs ?? 500,
        maxDelayMs: deps.config?.retry?.maxDelayMs ?? 15_000,
      },
    };
    this.fetch = deps.fetch ?? realFetch;
    this.sleeper = deps.sleeper ?? defaultSleeper;
    this.random = deps.random ?? Math.random;
    this.redactor = deps.redactor ?? new Redactor([this.config.apiKey]);
    this.onRetry = deps.onRetry;
  }

  get redaction(): Redactor {
    return this.redactor;
  }

  private requireKey(): string {
    return requireApiKey(this.config.apiKey);
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  /** Build the combined timeout + caller cancellation signal for one request. */
  private buildSignal(callerSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(TIMEOUT_REASON), this.config.timeoutMs);
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timeout);
        controller.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeout);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      },
    };
  }

  /**
   * Take the response body, up to `MAX_RESPONSE_BYTES`, and report what happened.
   *
   * Three outcomes are kept apart because the caller has to treat them differently: a body
   * that arrived within the bound, a body that went past it (so the read was stopped and the
   * connection cancelled), and a read that failed — before it started or part-way (so
   * nothing arrived to judge).
   * Reading the stream rather than calling `text()` is what bounds the *bytes held*: past
   * the limit this function stops asking, so an endpoint that keeps sending cannot decide how
   * much memory this process spends.
   *
   * A fetch implementation with no stream is read with `text()`, which materialises the body
   * first; the bound then applies to what is parsed and stored, not to what is allocated.
   */
  private async readBody(response: Awaited<ReturnType<FetchLike>>): Promise<BodyRead> {
    const stream = response.body;
    if (!stream) return this.readText(response);
    try {
      return await this.readStream(stream);
    } catch (error) {
      // `getReader()` refuses outright on a locked or detached body. That is the transport
      // failing one step later than the fetch, and an error escaping unconverted reaches
      // the retry wrapper as an unknown rejection: a generic message, no cause, and —
      // because the wrapper cannot tell — classified as one that must never be retried.
      return { text: '', over: false, failed: error };
    }
  }

  private async readStream(
    stream: NonNullable<Awaited<ReturnType<FetchLike>>['body']>,
  ): Promise<BodyRead> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let taken = 0;
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        return { text: '', over: false, failed: error };
      }
      if (next.done) {
        parts.push(decoder.decode());
        return { text: parts.join(''), over: false, failed: undefined };
      }
      taken += next.value.byteLength;
      if (taken > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { text: parts.join(''), over: true, failed: undefined };
      }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
  }

  private async readText(response: Awaited<ReturnType<FetchLike>>): Promise<BodyRead> {
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        return { text: '', over: true, failed: undefined };
      }
      return { text, over: false, failed: undefined };
    } catch (error) {
      return { text: '', over: false, failed: error };
    }
  }

  private async rawRequest(
    path: string,
    init: {
      method: string;
      body?: string;
      signal?: AbortSignal;
      callerSignal?: AbortSignal;
    },
  ): Promise<{ status: number; json: unknown; retryAfter: string | null }> {
    const auth = this.requireKey();
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetch(this.url(path), {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${auth}`,
        },
        body: init.body,
        signal: init.signal,
      });
    } catch (error) {
      throw this.toAppError(error, init.signal, init.callerSignal);
    }

    const body = await this.readBody(response);
    if (!response.ok) {
      const { kind, retryable } = kindForStatus(response.status);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw new AppError({
        kind,
        message: this.redactor.text(`BharatCode request failed with HTTP ${response.status}.`),
        status: response.status,
        retryable,
        retryAfterMs,
        details: {
          body: this.redactor.text(bounded(body.text, 500)),
          ...(body.over ? { bodyOverLimit: MAX_RESPONSE_BYTES } : {}),
        },
        remediation: remediationFor(kind),
      });
    }
    // A body that stopped arriving is not a body that arrived empty: the first is the
    // transport failing, and the retry policy has to be told which one it is looking at.
    if (body.failed) throw this.toAppError(body.failed, init.signal, init.callerSignal);
    if (body.over) {
      throw new AppError({
        kind: 'invalid-response',
        message: `BharatCode sent a response body larger than the ${MAX_RESPONSE_BYTES} byte limit, so the read was stopped and the body refused.`,
        retryable: false,
        status: response.status,
        details: { limitBytes: MAX_RESPONSE_BYTES },
        remediation:
          'The service answered, but not with a completion this client will hold. Retry this run once; if it repeats, check the model and endpoint configured.',
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch (cause) {
      throw new AppError({
        kind: 'invalid-response',
        message: 'BharatCode returned a non-JSON response body.',
        retryable: false,
        status: response.status,
        cause,
        details: { body: this.redactor.text(bounded(body.text, 200)) },
      });
    }
    return { status: response.status, json, retryAfter: response.headers.get('retry-after') };
  }

  private toAppError(error: unknown, signal?: AbortSignal, callerSignal?: AbortSignal): AppError {
    // Caller explicitly cancelled → not a timeout, never retried.
    if (callerSignal?.aborted) {
      return new AppError({
        kind: 'cancelled',
        message: 'Operation was cancelled.',
        retryable: false,
        cause: error,
      });
    }
    // Internal timeout sentinel → retryable timeout.
    const isTimeout = signal?.aborted === true && signal.reason === TIMEOUT_REASON;
    if (isTimeout) {
      return new AppError({
        kind: 'timeout',
        message: `BharatCode request timed out after ${this.config.timeoutMs}ms.`,
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new AppError({
        kind: 'cancelled',
        message: 'Operation was cancelled.',
        retryable: false,
        cause: error,
      });
    }
    return new AppError({
      kind: 'network',
      message: `Could not reach BharatCode: ${this.redactor.text(
        `${transportDetail(error)}${this.transportWait(error)}`,
      )}`,
      retryable: true,
      cause: error,
    });
  }

  /**
   * How long this side was prepared to wait, appended only when the transport is the
   * party that stopped waiting for headers.
   *
   * The two waits are different numbers and the reader has to be able to tell them apart.
   * Run 39460563729 was measured on one clock: it configured a 540000ms budget and was
   * answered at 304.5s by `UND_ERR_HEADERS_TIMEOUT`, so the transport stopped waiting
   * 235.5 seconds before this side's budget ran out. A message quoting only the configured
   * budget would have blamed that earlier give-up on us. It was not ours — the bound
   * belongs to the transport, and this repository cannot raise it without a dispatcher of
   * its own, which would be a new runtime dependency.
   *
   * Reaching this branch needs a budget *above* the bound. Below it, the internal timer
   * aborts first and the failure is reported as a timeout of our own, with no transport
   * sentence to add.
   */
  private transportWait(error: unknown): string {
    if (causeCode(error) !== 'UND_ERR_HEADERS_TIMEOUT') return '';
    return `; the configured per-request budget was ${this.config.timeoutMs}ms, which the transport did not reach`;
  }

  async listModels(): Promise<ModelList> {
    const result = await this.withRetry((signal, callerSignal) =>
      this.rawRequest('/models', { method: 'GET', signal, callerSignal }),
    );
    return parseModelList(result.json);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // Checked first because a missing credential is the more actionable of the
    // two configuration errors: without a model, `--connect` names one.
    this.requireKey();
    const model = request.model ?? this.config.model;
    if (!model) {
      throw new AppError({
        kind: 'config',
        message: 'No BharatCode model selected.',
        retryable: false,
        remediation: 'Set BHARATCODE_MODEL or pass an explicit model to complete().',
      });
    }
    const payload = {
      model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      chat_template_kwargs:
        request.enableThinking === undefined
          ? undefined
          : { enable_thinking: request.enableThinking },
    };
    const result = await this.withRetry(
      (signal, callerSignal) =>
        this.rawRequest('/chat/completions', {
          method: 'POST',
          body: JSON.stringify(payload),
          signal,
          callerSignal,
        }),
      request.signal,
    );
    return parseCompletion(result.json, model);
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const messages = withJsonInstruction(request);
    const completion = await this.complete({
      messages,
      model: request.model,
      signal: request.signal,
      temperature: request.temperature ?? 0,
    });
    const parsed = safeJsonParse(completion.text);
    try {
      return request.validate(parsed);
    } catch (cause) {
      throw new AppError({
        kind: 'validation',
        message:
          'BharatCode returned structured output that failed schema validation. Controlled repair is required before this result may be used.',
        retryable: false,
        cause,
        details: { sample: this.redactor.text(bounded(completion.text, 300)) },
      });
    }
  }

  async healthCheck(): Promise<HealthResult> {
    if (!this.config.apiKey) {
      return {
        reachable: false,
        configured: false,
        note: 'BHARATCODE_API_KEY is not set.',
      };
    }
    try {
      const list = await this.listModels();
      return { reachable: true, configured: true, modelCount: list.models.length };
    } catch (error) {
      const appErr = error instanceof AppError ? error : null;
      return {
        reachable: appErr ? isReachableDespiteError(appErr) : false,
        configured: true,
        note: appErr ? this.redactor.text(appErr.message) : 'Unknown error.',
      };
    }
  }

  private async withRetry<T>(
    fn: (signal: AbortSignal | undefined, callerSignal: AbortSignal | undefined) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    return runWithRetry(
      async () => {
        const { signal, cleanup } = this.buildSignal(callerSignal);
        try {
          return await fn(signal, callerSignal);
        } finally {
          cleanup();
        }
      },
      {
        config: this.config.retry,
        signal: callerSignal,
        sleep: this.sleeper,
        random: this.random,
        isRetryable: (error) => {
          if (error instanceof AppError) {
            return { retry: error.retryable, retryAfterMs: error.retryAfterMs };
          }
          return { retry: false };
        },
        onRetry: ({ attempt: a, error }) => {
          if (error instanceof AppError) {
            this.onRetry?.({
              attempt: a,
              kind: error.kind,
              delayMs: 0,
            });
          }
        },
      },
    );
  }
}

function withJsonInstruction<T>(request: StructuredRequest<T>) {
  const hint = request.schemaHint ? `\nRequired JSON shape:\n${request.schemaHint}` : '';
  const system =
    'You are a structured output engine. Reply with ONLY a single valid minified JSON object and no prose, markdown, or code fences.' +
    hint;
  return [{ role: 'system' as const, content: system }, ...request.messages];
}

export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try to recover a fenced or embedded JSON object/array.
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        /* fall through */
      }
    }
    const brace = trimmed.match(/[[{][\s\S]*[\]}]/);
    if (brace) {
      try {
        return JSON.parse(brace[0]);
      } catch {
        /* fall through */
      }
    }
    throw new AppError({
      kind: 'invalid-response',
      message: 'BharatCode structured output was not valid JSON.',
      retryable: false,
    });
  }
}

function isReachableDespiteError(error: AppError): boolean {
  // A 4xx/5xx means we reached the service; network/timeout means we did not.
  return typeof error.status === 'number';
}

function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

function remediationFor(kind: string): string | undefined {
  switch (kind) {
    case 'auth':
      return 'Check that BHARATCODE_API_KEY is valid and has access.';
    case 'rate-limit':
      return 'BharatCode is rate limiting. MergeSutra will back off up to the configured limit.';
    case 'server':
      return 'BharatCode may be temporarily unavailable. Safe, bounded retries will be attempted.';
    default:
      return undefined;
  }
}

/**
 * The credential check, on its own.
 *
 * A stage that is about to create a workspace needs to fail this before it
 * writes anything, rather than discovering it inside a loop that would record a
 * missing configuration as a model that did not answer. One wording, in one
 * place, for both.
 */
export function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    throw new AppError({
      kind: 'config',
      message: 'BharatCode is not configured: no API key was found.',
      retryable: false,
      remediation:
        'Set the BHARATCODE_API_KEY environment variable. Never pass credentials as command arguments.',
    });
  }
  return apiKey;
}

/** Factory used by the CLI and tests. */
export function createBharatCodeClient(deps: ClientDeps = {}): HttpBharatCodeClient {
  return new HttpBharatCodeClient(deps);
}

export { throwIfCancelled };
