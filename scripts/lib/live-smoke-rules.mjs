/**
 * The one-request live smoke: its budget, its verdicts, and its artifact rules.
 *
 * This module owns the numbers a reader has to trust *before* a credential is spent, so the
 * hosted job, the offline suite and the operator's proposal all read the same figures instead
 * of paraphrasing them. It is deliberately dependency-free and side-effect-free: the redaction
 * and terminal-safety machinery is injected by the script, because a rule that cannot be run
 * against a planted answer in a test is not a rule.
 */

/** What one smoke is allowed to ask for, and nothing more. */
export const SMOKE_BUDGET = Object.freeze({
  /**
   * How many completions this smoke is written to send. It is a statement about the code, printed
   * as a bound — not a counter of what happened. What makes it true is that the script holds
   * exactly one completion call site — any `client.complete…(`, including the adapter's
   * `completeStructured()`, which POSTs too — which the workflow-policy suite pins and fires
   * planted second call sites against.
   */
  completionsAsked: 1,
  /** The only model this smoke may ask for. A dispatch cannot choose another one. */
  model: 'qwen-3.8-27b',
  maxOutputTokens: 512,
  temperature: 0,
  /** Sent to the adapter as `enableThinking: false`, which is `reasoning: { effort: "none" }`. */
  enableThinking: false,
  stream: true,
  store: false,
  /** Hard elapsed ceiling for the whole credentialed phase, in milliseconds. */
  deadlineMs: 90_000,
  maxRetries: 0,
});

/**
 * The same one request, given a clock long enough to test whether a slow route answers at all.
 *
 * The previous smoke ended at 89 s on its own clock with no terminal event, no answer text and no
 * token usage. Its abort carried no HTTP status, so the artifact cannot say whether response
 * headers arrived, only that the clock expired. That is consistent with a request still waiting
 * behind other work, but equally with a stalled transport or a gateway that accepted the connection
 * and never answered; the script observes the expiry, not the reason, so queueing stays a hypothesis
 * until a run reaches a provider-side fact. 270 s is still below the roughly 300 s point at which
 * Node's own fetch stops waiting for headers, so the client's timer is expected to end this run.
 * Declared as a spread of the standard budget with only the deadline replaced, so a field added to
 * the standard budget is in this variant too; the policy suite pins that only the clock differs.
 */
export const SMOKE_BUDGET_AVAILABILITY = Object.freeze({
  ...SMOKE_BUDGET,
  deadlineMs: 270_000,
});

/**
 * The only budgets a smoke may name. A dispatch or an environment variable chooses a key from
 * this frozen map; there is no path from an outside value to a number.
 */
export const SMOKE_VARIANTS = Object.freeze({
  standard: SMOKE_BUDGET,
  availability: SMOKE_BUDGET_AVAILABILITY,
});

/** A fixed prompt: a smoke that varies its own input cannot explain its own result. */
export const SMOKE_SENTINEL = 'MERGESUTRA-LIVE-SMOKE';

export const SMOKE_MESSAGES = Object.freeze([
  Object.freeze({
    role: 'system',
    content:
      'You are answering a one-line connectivity check. Reply with exactly the requested text and nothing else.',
  }),
  Object.freeze({
    role: 'user',
    content: `Reply with exactly this text and nothing else: ${SMOKE_SENTINEL}`,
  }),
]);

function finishWord(answer) {
  const reason = answer?.finishReason ?? null;
  return reason === null ? 'unknown' : String(reason);
}

function textOf(answer) {
  return typeof answer?.text === 'string' ? answer.text : '';
}

/**
 * Whether this answer proves the route works.
 *
 * `finishReason === 'stop'` is the whole question, because the adapter sets it from the
 * provider's own terminal event: anything else means the response was incomplete, failed, or
 * never carried a terminal at all. Text is never read here — a truncated answer that happens to
 * look finished is exactly the case a smoke must refuse, and a completed response that carried
 * nothing is not evidence of a working stream either.
 *
 * A PASS is therefore a connectivity verdict and nothing more: it says a terminal event arrived
 * with text behind it, not that the text was the sentinel. Whether the sentinel came back is a
 * separate field in `smokeEvidence` (`answer.matchedSentinel`) and a separate summary line, so a
 * connected route that answers with other words still passes and is never described as matching.
 */
export function smokeVerdict(answer, { elapsedMs, budget = SMOKE_BUDGET } = {}) {
  // A number check, not `Number.isFinite(Number(elapsedMs))`: `Number(null)` is 0, so a run that
  // lost its clock would otherwise be reported as the fastest answer ever recorded.
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) {
    return { status: 'FAILED', reason: 'the smoke cannot say how long its own request took.' };
  }
  if (elapsedMs > budget.deadlineMs) {
    return {
      status: 'FAILED',
      reason:
        `the request phase took ${String(elapsedMs)} ms against a ${String(budget.deadlineMs)} ms ` +
        'ceiling, so this run did not stay inside the budget it was given.',
    };
  }
  const finish = answer?.finishReason ?? null;
  if (finish !== 'stop') {
    return {
      status: 'INCOMPLETE',
      reason:
        `the provider never marked the response complete: its own finish reason was ` +
        `'${finishWord(answer)}'. ${String(textOf(answer).length)} characters of partial text were ` +
        'refused without being read, because a stream cut at a limit and a stream that answered ' +
        'cannot be told apart by their text.',
    };
  }
  if (textOf(answer).trim().length === 0) {
    return {
      status: 'FAILED',
      reason:
        'a response.completed arrived and carried no text at all, which is a terminal event ' +
        'without an answer rather than a working route.',
    };
  }
  return { status: 'PASS', reason: null };
}

const CREDENTIAL_PATTERNS = [
  /\bbc_live_[A-Za-z0-9_-]{8,}\b/,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}\b/,
];

/**
 * Reasons this text must not become a downloadable artifact.
 *
 * The configured key is looked for as raw bytes, not as a pattern: a provider whose key format
 * changes would leave a pattern scan blind while the artifact still carried the secret.
 */
export function credentialLeakFindings(entries, secret) {
  const findings = [];
  const raw = typeof secret === 'string' && secret.length >= 4 ? secret : null;
  for (const entry of entries ?? []) {
    const text = typeof entry?.text === 'string' ? entry.text : '';
    const name = typeof entry?.name === 'string' ? entry.name : '(unnamed)';
    if (raw !== null && text.includes(raw)) {
      findings.push(`${name}: the configured key appears in it as raw bytes`);
      continue;
    }
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
      findings.push(`${name}: a credential-shaped string appears in it`);
    }
  }
  return findings;
}

/**
 * The sanitized summary, shaped for the artifact and the log line.
 *
 * `redact` and `singleLine` are injected so this stays pure and testable; the script passes the
 * product's `Redactor` and `terminalSafeSingleLine`. Every string the provider chooses — its finish
 * reason, its model name, its answer text, and the wording of a transport failure — travels as a
 * redacted one-line value, never as bytes that could open a second line in the job log a reader
 * trusts to hold this smoke's own verdicts.
 */
export function smokeEvidence({
  answer,
  elapsedMs,
  verdict,
  requestedModel,
  catalog,
  redact = (value) => value,
  singleLine = (value) => value,
  budget = SMOKE_BUDGET,
} = {}) {
  const text = textOf(answer);
  const usage = answer?.usage;
  // Every string the provider or the transport can choose its own wording for goes through this:
  // a finish reason, a failure message or a model name is untrusted text, and it is written both
  // into the artifact and onto the job log a reader trusts to be this smoke's own verdict lines.
  const safeString = (value) => singleLine(redact(value));
  return {
    schemaVersion: 1,
    kind: 'bharatcode-live-smoke',
    status: verdict?.status ?? null,
    reason: verdict?.reason === null ? null : safeString(String(verdict?.reason ?? '')),
    budget: {
      completionsAsked: budget.completionsAsked,
      maxOutputTokens: budget.maxOutputTokens,
      temperature: budget.temperature,
      reasoning: budget.enableThinking === false ? 'none' : 'provider default',
      stream: budget.stream,
      store: budget.store,
      deadlineMs: budget.deadlineMs,
      maxRetries: budget.maxRetries,
    },
    model: {
      requested: safeString(String(requestedModel ?? '')),
      reported: safeString(String(answer?.model ?? '')),
      catalogModels: Number.isInteger(catalog?.models) ? catalog.models : null,
      catalogContainsRequested: catalog?.contains === true,
    },
    answer: {
      finishReason:
        answer?.finishReason === undefined || answer?.finishReason === null
          ? null
          : safeString(String(answer.finishReason)),
      characters: text.length,
      matchedSentinel: text.trim() === SMOKE_SENTINEL,
      preview: safeString(text).slice(0, 200),
    },
    usage:
      usage === undefined || usage === null
        ? null
        : {
            promptTokens: usage.promptTokens ?? null,
            completionTokens: usage.completionTokens ?? null,
            totalTokens: usage.totalTokens ?? null,
          },
    elapsedMs: typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? elapsedMs : null,
  };
}

/**
 * The verdict block for the job log: one labelled line per fact, so a reader sees the outcome
 * without opening the artifact and no line needs a sentence parsed out of it.
 */
export function smokeSummaryLine(evidence) {
  const answer = evidence?.answer ?? {};
  const usage = evidence?.usage ?? {};
  return [
    `LIVE_SMOKE: ${evidence?.status ?? 'FAILED'}`,
    `LIVE_SMOKE_MODEL: ${evidence?.model?.requested ?? 'unknown'}`,
    `LIVE_SMOKE_FINISH_REASON: ${answer.finishReason ?? 'unknown'}`,
    `LIVE_SMOKE_CHARS: ${String(answer.characters ?? 0)}`,
    `LIVE_SMOKE_SENTINEL_MATCHED: ${answer.matchedSentinel === true ? 'yes' : 'no'}`,
    `LIVE_SMOKE_LATENCY_MS: ${String(evidence?.elapsedMs ?? 'unknown')}`,
    `LIVE_SMOKE_TOKENS: prompt=${String(usage.promptTokens ?? 'none')} completion=${String(
      usage.completionTokens ?? 'none',
    )} total=${String(usage.totalTokens ?? 'none')}`,
    ...(typeof evidence?.reason === 'string' && evidence.reason.length > 0
      ? [`LIVE_SMOKE_REASON: ${evidence.reason}`]
      : []),
  ].join('\n');
}
