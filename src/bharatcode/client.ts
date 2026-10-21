import { AppError, isAppError, isErrorLike, kindForStatus, retryFacts } from '../core/errors.js';
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
 * Each half is masked before it is encoded, and the joined result is masked again by the
 * caller, because the two orders catch different secrets and neither contains the other.
 * `Redactor.text` masks a known secret by exact substring and its generic rule needs the
 * whitespace between a name and its `:` or `=`, so a value the encoder has already rewritten
 * reaches neither: `api_key\r\n= <secret>` becomes `api_key\u000d\u000a= <secret>`, the
 * separator matches no more, and the credential travels whole. Masking the raw string first
 * closes that. The pass afterwards is not redundant: the generic rule's value class stops at
 * whitespace, so a secret that continues past a raw line break masks only its first half in
 * source form — and the encoder turns that break into six ASCII characters the class does not
 * stop at, so the second pass sees one long value and masks all of it.
 *
 * The `cause` is reached through the same guarded reader as the fields below it. It is the
 * one name here that is looked up on somebody else's object rather than passed in, and a
 * proxy that throws when asked for it would otherwise have its own message printed as the
 * reason the connection failed.
 */
function transportDetail(error: unknown, redactor: Redactor): string {
  const headline = oneLine(redactor.text(describeForeign(error)), 160);
  const cause = readForeignField(error, 'cause');
  if (cause === UNREADABLE) return `${headline} (cause: ${refusedField('cause')})`;
  const detail = cause === undefined ? '' : oneLine(redactor.text(describeForeign(cause)), 240);
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
 * Whatever reaches this is already masked: the encoder rewrites code points the redactor's
 * rules read as structure, so a value encoded first can no longer be found.
 */
function oneLine(value: string, limit: number): string {
  return [...terminalSafeSingleLine(value)].slice(0, limit).join('');
}

/** Returned in place of a value when the act of reading the value is what threw. */
const UNREADABLE = Symbol('unreadable');

/**
 * Read one property off somebody else's failure, without being able to fail.
 *
 * A getter is allowed to throw and a proxy handler makes that ordinary, so *describing* a
 * transport error can itself become the error — and the trap's own message then replaces
 * the socket's, which is the silence this whole group of helpers exists to end.
 */
function readForeignField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/**
 * The same read, kept to a non-empty string.
 *
 * A field that refuses is reported as refusing, because a name that exists and will not be
 * read is not the same fact as a name that was never there. The refusal is this helper's
 * own words, never the thrower's: the trap's message is somebody else's value.
 */
function readForeignString(value: unknown, key: string): string | undefined {
  const field = readForeignField(value, key);
  if (field === UNREADABLE) return refusedField(key);
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/** How a refusal is named, so no two callers can report the same withheld field differently. */
function refusedField(key: string): string {
  return `${key} could not be read`;
}

/**
 * A short, safe name for something a connection handed back.
 *
 * `String()` of a plain object is `[object Object]`, which names nothing — and printing
 * that object's *values* is how a request payload, headers included, can end up on a
 * screen. So a bare object is described by its key names, which say what it was without
 * saying what was in it, and an `AggregateError` — undici's real multi-address connect
 * failure, whose own message distinguishes nothing — is described by how much it hides
 * and by the kind of each hidden failure, never by what it hides.
 */
function describeForeign(value: unknown): string {
  if (isErrorLike(value)) {
    const named = ['name', 'code', 'message']
      .map((key) => readForeignString(value, key))
      .filter((part): part is string => part !== undefined)
      .join(' ');
    const nested = readForeignField(value, 'errors');
    // A withheld list and no list are different facts. `Array.isArray` answers "no" to the
    // refusal sentinel, so the refusal is taken out of the array test's way first —
    // otherwise the screen shows a plain connect error for a failure that hid a list this
    // side could not look at. The array test itself is a read: on a revoked proxy the
    // language requires it to throw, which is the same withheld list wearing a different
    // form.
    if (nested === UNREADABLE) return `${named}; ${refusedField('errors')}`;
    let listed: readonly unknown[] | undefined;
    try {
      if (Array.isArray(nested)) listed = nested;
    } catch {
      return `${named}; ${refusedField('errors')}`;
    }
    if (listed === undefined) return named;
    return `${named}; ${nestedSummary(listed)}`;
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
  // `String()` is a read of its own: for a function it looks up `toString`, and a revoked
  // proxy makes that lookup throw. The fallback names the refusal instead of letting it
  // become the failure being described.
  try {
    return String(value);
  } catch {
    return 'value that could not be described';
  }
}

/**
 * The kinds inside an `AggregateError`, named without quoting them.
 *
 * Each entry's `message` is a connect line — `connect ECONNREFUSED 127.0.0.1:1` — so it
 * carries a host and a port, which is exactly what the keys-only rule above keeps out of a
 * report. `code` comes from a fixed table and `name` from a class list, so either says
 * which failure this was without repeating an address. Past four the list is noise.
 *
 * Four positions are read by index and the tally is read separately, because `length`,
 * `slice` and `map` all ask a proxy over the list for the count it may refuse to give — and
 * a withheld tally is not a tally of one, so the refusal is reported as the fact it is
 * rather than guessed at from however many entries this window happened to reach. A hole
 * at one position is not the end of the list either: stopping there would drop every kind
 * behind it and print a count with nothing to say what the counted failures were.
 */
function nestedSummary(nested: readonly unknown[]): string {
  const kinds: string[] = [];
  for (let position = 0; position < 4; position += 1) {
    const item = readForeignField(nested, String(position));
    if (item === undefined) continue;
    const kind =
      item === UNREADABLE
        ? refusedField(`entry ${position}`)
        : (readForeignString(item, 'code') ?? readForeignString(item, 'name'));
    if (kind !== undefined) kinds.push(kind);
  }
  const listed = kinds.length === 0 ? '' : ` (${kinds.join(', ')})`;
  const count = readForeignField(nested, 'length');
  const tally =
    typeof count === 'number' && Number.isFinite(count)
      ? `${count} nested errors`
      : count === UNREADABLE
        ? 'nested errors whose count could not be read'
        : 'nested errors';
  return `${tally}${listed}`;
}

/**
 * Whether this rejection carries the transport's own give-up-on-headers code, at either of
 * the two depths it is seen at.
 *
 * Node puts undici's code one level down in `cause`, but only because Node wraps. An
 * adapter that propagates the coded error directly has it at the top; a socket reset
 * through a proxy can carry a generic `ECONNRESET` at the top with the headers timeout
 * underneath it; a transport that serializes its failure leaves the code on a `cause` that
 * is not an `Error`. Any one of those positions, read alone, leaves `transportWait` silent
 * about the failure it exists to name — so both are asked.
 */
function isHeaderTimeout(error: unknown): boolean {
  if (readForeignString(error, 'code') === 'UND_ERR_HEADERS_TIMEOUT') return true;
  return readForeignString(readForeignField(error, 'cause'), 'code') === 'UND_ERR_HEADERS_TIMEOUT';
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
    if (body.failed)
      throw this.toAppError(body.failed, init.signal, init.callerSignal, 'response-body');
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

  /**
   * Convert a transport rejection into the error this client reports.
   *
   * `phase` says how far the connection got, because the same death means two different
   * things depending on whether a response ever arrived. Before one does, "could not reach
   * this host" is where the operator has to look; after one does, the host answered and the
   * read is what failed — the same retry class, a different place to point.
   */
  private toAppError(
    error: unknown,
    signal?: AbortSignal,
    callerSignal?: AbortSignal,
    phase: 'request' | 'response-body' = 'request',
  ): AppError {
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
    // Same reason the field readers exist: `name` is a string a foreign error is allowed
    // to withhold behind a getter that throws, and a cancelled run is decided by a word.
    if (readForeignString(error, 'name') === 'AbortError') {
      return new AppError({
        kind: 'cancelled',
        message: 'Operation was cancelled.',
        retryable: false,
        cause: error,
      });
    }
    const reach =
      phase === 'request'
        ? 'Could not reach BharatCode'
        : 'BharatCode answered, but the response body stopped arriving';
    return new AppError({
      kind: 'network',
      message: `${reach}: ${this.redactor.text(
        `${transportDetail(error, this.redactor)}${this.transportWait(error, phase)}`,
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
   *
   * It is a sentence about a request that was never answered, so the phase decides whether
   * it may be said at all. Once the response has begun the headers already arrived, and a
   * header-timeout code on whatever broke the stream is a different failure wearing a
   * familiar code — quoting the per-request budget beside "the body stopped arriving" would
   * send the operator to raise a number that was never the problem.
   */
  private transportWait(error: unknown, phase: 'request' | 'response-body'): string {
    if (phase !== 'request') return '';
    if (!isHeaderTimeout(error)) return '';
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
      const appErr = isAppError(error) ? error : null;
      // Identity was answered, not readability: both fields are still somebody else's and
      // are read through the same guards as everywhere else on this path.
      const status = appErr ? readForeignField(appErr, 'status') : undefined;
      const message = appErr ? readForeignString(appErr, 'message') : undefined;
      return {
        reachable: typeof status === 'number',
        configured: true,
        note: this.redactor.text(message ?? 'Unknown error.'),
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
          if (!isAppError(error)) return { retry: false };
          // Identity was answered without a throw; the flag can still refuse, and a retry
          // read through a refusal would be a spend this side cannot explain.
          const facts = retryFacts(error);
          return { retry: facts.retryable, retryAfterMs: facts.retryAfterMs };
        },
        onRetry: ({ attempt: a, error }) => {
          if (!isAppError(error)) return;
          let kind: AppError['kind'];
          try {
            kind = error.kind;
          } catch {
            // The callback is progress, not evidence: a kind this side cannot read is not
            // one it may report, and the failure itself is already on its way out.
            return;
          }
          if (typeof kind !== 'string' || kind.length === 0) return;
          this.onRetry?.({ attempt: a, kind, delayMs: 0 });
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

/**
 * Quote at most `max` characters of somebody else's text, and say how much was cut.
 *
 * The text is an endpoint's bytes, so the limit has to fall between whole characters:
 * `slice` counts the UTF-16 units that hold them, and a cut inside a surrogate pair leaves
 * one half behind. A lone surrogate is not a character, and the loss is not in the string
 * but in the travel: `JSON.stringify` escapes it faithfully and re-parses to the same value,
 * while any step that encodes the report as UTF-8 — a write, a pipe, a `Buffer.from` —
 * replaces it with U+FFFD and cannot be undone. So this iterates by code point instead.
 */
function bounded(text: string, max: number): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  return `${characters.slice(0, max).join('')}…(+${characters.length - max} chars)`;
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
