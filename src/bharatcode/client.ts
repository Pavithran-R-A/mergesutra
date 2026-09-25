import { AppError, kindForStatus } from '../core/errors.js';
import { Redactor } from '../security/redaction.js';
import { parseCompletion, parseModelList } from './schemas.js';
import { parseRetryAfter, runWithRetry, throwIfCancelled } from './retry.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
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

    const bodyText = await response.text().catch(() => '');
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
          body: this.redactor.text(bounded(bodyText, 500)),
        },
        remediation: remediationFor(kind),
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch (cause) {
      throw new AppError({
        kind: 'invalid-response',
        message: 'BharatCode returned a non-JSON response body.',
        retryable: false,
        status: response.status,
        cause,
        details: { body: this.redactor.text(bounded(bodyText, 200)) },
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
        error instanceof Error ? error.message : String(error),
      )}`,
      retryable: true,
      cause: error,
    });
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
