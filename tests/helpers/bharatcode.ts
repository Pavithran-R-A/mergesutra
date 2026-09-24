import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
} from '../../src/bharatcode/types.js';

/**
 * A stand-in for the model.
 *
 * Every answer is scripted, so a test can say exactly what the model claimed and
 * check what MergeSutra did with the claim. `calls` keeps the messages it was
 * sent, which is how the prompt-shaping tests avoid guessing.
 */

export interface ScriptedClient extends BharatCodeClient {
  readonly calls: readonly CompletionRequest[];
  readonly messages: readonly ChatMessage[];
}

export const TEST_MODEL = 'bharatcode-test-model';

export function scriptedClient(
  answers: readonly (string | unknown)[],
  options: { model?: string; usage?: CompletionResult['usage'] } = {},
): ScriptedClient {
  const calls: CompletionRequest[] = [];
  const queue = [...answers];

  return {
    calls,
    get messages() {
      return calls[0]?.messages ?? [];
    },
    async complete(request) {
      calls.push(request);
      const answer = queue.shift();
      if (answer === undefined) {
        throw new Error(`scripted client ran out of answers after ${calls.length - 1} call(s)`);
      }
      return {
        text: typeof answer === 'string' ? answer : JSON.stringify(answer),
        model: options.model ?? TEST_MODEL,
        finishReason: 'stop',
        usage: options.usage ?? { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
      };
    },
    // The planner must not need any of these; if it does, a test finds out here.
    async listModels() {
      throw new Error('listModels() must not be called by the planner');
    },
    async completeStructured() {
      throw new Error('completeStructured() must not be called by the planner');
    },
    async healthCheck() {
      throw new Error('healthCheck() must not be called by the planner');
    },
  };
}

/** A plan body that satisfies the schema for a contract with these criterion ids. */
export function planBodyFor(criteria: readonly string[]): Record<string, unknown> {
  return {
    summary: 'Reject empty date input at the parser boundary.',
    rootCause: '`parseDate` falls through to `new Date("")` and yields the epoch.',
    changes: [
      {
        file: 'src/parse.ts',
        action: 'modify',
        reason: 'throw before constructing a Date',
        criterionIds: [criteria[0] ?? 'AC-1'],
      },
      {
        file: 'test/parse.test.ts',
        action: 'modify',
        reason: 'cover the empty-input case',
        criterionIds: [criteria[0] ?? 'AC-1'],
      },
    ],
    validationCommands: [
      { argv: ['npm', 'test'], purpose: 'run the suite', criterionIds: [...criteria] },
    ],
    criteriaCovered: [...criteria],
    criteriaUnaddressed: [],
    proposedCriteria: [],
    risks: ['Callers that relied on the epoch behaviour will now see an error.'],
    assumptions: ['`parseDate` has no other callers outside src/.'],
    questionsForHuman: ['Should the rejection be a TypeError or a RangeError?'],
  };
}
