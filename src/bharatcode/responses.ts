import { AppError } from '../core/errors.js';
import type { SseFrame } from './sse.js';
import type { CompletionResult, ToolCall, Usage } from './types.js';

/**
 * The BharatCode Responses stream, turned into one result or one refusal.
 *
 * The provider documents four facts this file is built around. Text arrives as
 * `response.output_text.delta`; a response finishes on `response.completed`, or on
 * `response.incomplete` when it stopped at the output limit and the partial text is
 * still an answer; a started stream that fails ends with `response.failed`; and queue
 * keepalive comments are not model output.
 *
 * The terminal response object is authoritative for the text it carries — it is the
 * provider's own final copy, not a reassembly of the deltas this side happened to
 * receive. When it carries no text — no message at all, or a message whose parts are
 * empty — the accumulated deltas are used instead, because a gateway that sent them and
 * then summarized nothing has still answered.
 */

interface ParsedResponse {
  readonly status: 'completed' | 'incomplete';
  /** The text of a message in the terminal output; undefined when no message was sent. */
  readonly text: string | undefined;
  readonly model: string | undefined;
  readonly finishReason: string;
  readonly usage: Usage | undefined;
  readonly toolCalls: readonly ToolCall[] | undefined;
}

interface FailedResponse {
  readonly code: string | undefined;
  readonly message: string | undefined;
}

type Outcome =
  | { readonly kind: 'final'; readonly response: ParsedResponse }
  | { readonly kind: 'failed'; readonly failure: FailedResponse };

function malformed(detail: string): AppError {
  return new AppError({
    kind: 'invalid-response',
    message: `BharatCode returned a response that does not match the documented Responses shape: ${detail}`,
    retryable: false,
    details: { reason: detail },
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): Usage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const total = count(usage.total_tokens);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  const promptTokens = input ?? 0;
  const completionTokens = output ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: total ?? promptTokens + completionTokens,
  };
}

/**
 * Read one terminal response object.
 *
 * A `failed` object is not a schema error: the provider answered and said the answer
 * failed, which the caller has to report as that failure. A function call is only read
 * from a completed response — an incomplete one is a partial by definition, and exposing
 * a call the model was still building would invite the application to execute half of one.
 */
export function parseResponseObject(value: unknown): Outcome {
  const response = record(value);
  if (!response) throw malformed('the response was not a JSON object');
  const status = response.status;
  if (typeof status !== 'string') throw malformed('the response carried no status');

  if (status === 'failed') {
    const failure = record(response.error);
    return {
      kind: 'failed',
      failure: { code: text(failure?.code), message: text(failure?.message) },
    };
  }
  if (status !== 'completed' && status !== 'incomplete') {
    throw malformed('the response status was not a terminal one');
  }

  const pieces: string[] = [];
  const calls: ToolCall[] = [];
  const output = response.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const entry = record(item);
      if (!entry) continue;
      if (entry.type === 'message') {
        const content = entry.content;
        if (typeof content === 'string') {
          pieces.push(content);
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          const piece = record(part);
          if (piece?.type === 'output_text' && typeof piece.text === 'string') {
            pieces.push(piece.text);
          }
        }
        continue;
      }
      if (entry.type === 'function_call') {
        const name = text(entry.name);
        const callId = text(entry.call_id);
        const args = typeof entry.arguments === 'string' ? entry.arguments : undefined;
        if (name === undefined || callId === undefined || args === undefined) {
          // No provider value is quoted here: the call's identifier is untrusted text and
          // naming it adds nothing the reader can act on.
          throw malformed(
            'a function call in the output was missing its name, call_id or arguments',
          );
        }
        calls.push({ callId, name, arguments: args });
      }
    }
  }

  const incomplete = record(response.incomplete_details);
  const finishReason = status === 'completed' ? 'stop' : (text(incomplete?.reason) ?? 'incomplete');

  return {
    kind: 'final',
    response: {
      status,
      text: text(pieces.join('')),
      model: text(response.model),
      finishReason,
      usage: parseUsage(response.usage),
      toolCalls: status === 'completed' && calls.length > 0 ? calls : undefined,
    },
  };
}

/**
 * Client-side codes that describe the request or the account rather than the service's
 * condition, so a retry would send the same request again rather than meet a different
 * server. Quota, context-length and content-inspection refusals belong here: the next
 * attempt carries the same tokens against the same limit.
 */
function retryableFailure(code: string | undefined): boolean {
  if (code === undefined) return true;
  return !/^(invalid|authentication|permission|not_found|content|unsupported|bad_|insufficient|quota|billing|context_|data_inspection)/i.test(
    code,
  );
}

export class ResponseStream {
  private readonly deltas: string[] = [];
  private terminal: Outcome | undefined;

  constructor(
    private readonly requestedModel: string,
    private readonly redact: (value: string) => string,
    private readonly requestId: string | undefined,
  ) {}

  get finished(): boolean {
    return this.terminal !== undefined;
  }

  private get outputStarted(): boolean {
    return this.deltas.some((delta) => delta.length > 0);
  }

  /** Apply one SSE frame. Unknown event names are ignored, as the format requires. */
  apply(frame: SseFrame): void {
    if (this.terminal) return;
    if (frame.data === '[DONE]') {
      // `[DONE]` is the chat-completions sentinel. On this route the provider names
      // completion itself, so a bare sentinel means the terminal event never arrived;
      // accepting it would stamp `stop` on partial delta text and let a truncated
      // answer be executed as if it were whole.
      throw malformed(
        'the stream sent [DONE] without a response.completed or response.incomplete event',
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch (cause) {
      throw new AppError({
        kind: 'invalid-response',
        message:
          'BharatCode sent a stream event whose data was not valid JSON, so the response was refused.',
        retryable: false,
        cause,
        details: { event: frame.event },
      });
    }

    const event = record(payload);
    const type = typeof event?.type === 'string' ? event.type : frame.event;
    switch (type) {
      case 'response.output_text.delta': {
        const delta = event?.delta;
        if (typeof delta !== 'string') {
          throw malformed('an output_text delta did not carry a string delta');
        }
        this.deltas.push(delta);
        return;
      }
      case 'response.completed':
      case 'response.incomplete':
        this.terminal = parseResponseObject(event?.response ?? event);
        return;
      case 'response.failed': {
        const inner = record(event?.response);
        const failure = record(inner?.error) ?? record(event?.error) ?? inner ?? event;
        this.terminal = {
          kind: 'failed',
          failure: { code: text(failure?.code), message: text(failure?.message) },
        };
        return;
      }
      case 'error': {
        const failure = record(event?.error) ?? event;
        this.terminal = {
          kind: 'failed',
          failure: { code: text(failure?.code), message: text(failure?.message) },
        };
        return;
      }
      default:
        // `response.created`, `response.in_progress`, `response.output_text.done`,
        // `response.output_item.done` and future event names carry no state this adapter
        // needs; the terminal object already contains their outcome.
        return;
    }
  }

  /** Apply a whole response object, for a gateway that answers /responses with JSON. */
  applyBuffered(value: unknown): void {
    if (this.terminal) return;
    this.terminal = parseResponseObject(value);
  }

  result(): CompletionResult {
    const outcome = this.terminal;
    if (!outcome) {
      throw new AppError({
        kind: 'invalid-response',
        message:
          'BharatCode event stream ended without a terminal response.completed or response.incomplete event, so the partial answer was refused.',
        retryable: false,
        details: this.requestId === undefined ? {} : { requestId: this.requestId },
      });
    }
    if (outcome.kind === 'failed') throw this.failure(outcome.failure);

    const response = outcome.response;
    return {
      text: response.text !== undefined ? response.text : this.deltas.join(''),
      model: response.model ?? this.requestedModel,
      finishReason: response.finishReason,
      usage: response.usage,
      ...(response.toolCalls === undefined ? {} : { toolCalls: response.toolCalls }),
    };
  }

  private failure(failure: FailedResponse): AppError {
    const afterOutput = this.outputStarted;
    const code = failure.code ?? 'unknown_error';
    const detail = failure.message === undefined ? '' : `: ${failure.message}`;
    const request = this.requestId === undefined ? '' : ` (request id ${this.requestId})`;
    const canRetry = !afterOutput && retryableFailure(failure.code);
    return new AppError({
      kind: 'server',
      retryable: canRetry,
      // The provider's own words are masked before they become this build's sentence,
      // because a gateway that echoes a header must not turn a failure report into a leak.
      message: this.redact(
        `BharatCode reported the response failed with ${code}${detail}${request}.`,
      ),
      details: {
        ...(failure.code === undefined ? {} : { code: failure.code }),
        ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
        ...(afterOutput ? { afterOutput: true } : {}),
      },
      remediation: canRetry
        ? 'BharatCode may be temporarily unavailable. Safe, bounded retries will be attempted.'
        : undefined,
    });
  }
}
