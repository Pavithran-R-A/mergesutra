import { z } from 'zod';
import { AppError } from '../core/errors.js';
import type { CompletionResult, ModelList, Usage } from './types.js';

/**
 * Zod schemas for every shape that arrives from BharatCode (or any provider
 * behind the adapter). Provider responses are treated as untrusted and are
 * fully validated before use.
 */

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  object: z.string().optional(),
  created: z.number().optional(),
  owned_by: z.string().optional(),
});

export const modelListResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(modelInfoSchema).optional(),
  // Some gateways return { models: [...] } instead of OpenAI's { data: [...] }.
  models: z.array(modelInfoSchema).optional(),
});

export const chatCompletionResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  object: z.string().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().optional(),
        message: z
          .object({
            role: z.string().optional(),
            content: z.string().nullable().optional(),
          })
          .passthrough(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1, 'choices must contain at least one entry'),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

function invalid(detail: string, cause?: unknown): AppError {
  return new AppError({
    kind: 'invalid-response',
    message: `BharatCode returned a response that does not match the expected schema: ${detail}`,
    retryable: false,
    cause,
    details: { reason: detail },
  });
}

export function parseModelList(unknown: unknown): ModelList {
  const parsed = modelListResponseSchema.safeParse(unknown);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((i) => i.message).join('; ') || 'malformed model list');
  }
  const raw = parsed.data.data ?? parsed.data.models ?? [];
  return {
    models: raw.map((m) => ({
      id: m.id,
      created: m.created,
      ownedBy: m.owned_by,
    })),
  };
}

export function parseCompletion(unknown: unknown, requestedModel: string): CompletionResult {
  const parsed = chatCompletionResponseSchema.safeParse(unknown);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') ||
        'malformed completion',
    );
  }
  const data = parsed.data;
  const first = data.choices[0];
  if (!first) throw invalid('no choices returned');
  const content = first.message.content;
  if (typeof content !== 'string') {
    const reasoning = first.message.reasoning_content;
    const reasoningType = typeof reasoning;
    const reasoningChars = reasoningType === 'string' ? reasoning.length : 0;
    throw invalid(
      `assistant message content was not a string (content=${String(content)}, finish=${first.finish_reason ?? 'null'}, reasoningType=${reasoningType}, reasoningChars=${reasoningChars})`,
    );
  }
  let usage: Usage | undefined;
  if (data.usage) {
    const prompt = data.usage.prompt_tokens ?? 0;
    const completion = data.usage.completion_tokens ?? 0;
    usage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: data.usage.total_tokens ?? prompt + completion,
    };
  }
  return {
    text: content,
    model: data.model ?? requestedModel,
    finishReason: first.finish_reason ?? null,
    usage,
  };
}
