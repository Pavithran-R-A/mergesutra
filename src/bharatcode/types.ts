/**
 * BharatCode adapter — typed request/response boundaries.
 *
 * The rest of MergeSutra depends only on the `BharatCodeClient` interface and
 * these types, never on HTTP/JSON details. Model output is UNTRUSTED input and
 * is validated with Zod at the adapter edge.
 */

export const DEFAULT_BASE_URL = 'https://bharatcode.ai/api/model/v1';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 3;

/**
 * The largest response body the adapter will take, in bytes.
 *
 * Far above a completion this service can produce under its own `max_tokens`, and small
 * enough that an endpoint cannot decide how many bytes this process holds in memory.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface RetryConfig {
  /** Maximum number of *additional* attempts after the first (0 = no retry). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface BharatCodeClientConfig {
  apiKey: string | undefined;
  baseUrl: string;
  model: string | undefined;
  timeoutMs: number;
  retry: RetryConfig;
}

export interface ModelInfo {
  readonly id: string;
  readonly created?: number;
  readonly ownedBy?: string;
}

export interface ModelList {
  readonly models: readonly ModelInfo[];
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly finishReason: string | null;
  readonly usage?: Usage;
}

/** A JSON-schema-like descriptor handed to `completeStructured`. */
export interface StructuredRequest<T> {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** Runtime validator applied to the parsed JSON the model returns. */
  readonly validate: (value: unknown) => T;
  /** Optional human hint of the required shape, included in the prompt. */
  readonly schemaHint?: string;
  readonly temperature?: number;
}

export interface HealthResult {
  readonly reachable: boolean;
  readonly configured: boolean;
  readonly modelCount?: number;
  readonly note?: string;
}

/** Injectable clock/random/sleep so retry timing is deterministic in tests. */
export interface Sleeper {
  (ms: number, signal?: AbortSignal): Promise<void>;
}
