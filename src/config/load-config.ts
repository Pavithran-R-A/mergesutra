import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { defaultRedactor } from '../security/redaction.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type BharatCodeClientConfig,
  type RequestBudget,
} from '../bharatcode/types.js';

/**
 * Configuration loading.
 *
 * Authentication material comes ONLY from the environment (or, later, a secure
 * local config file) — never from a command argument, fixture, or report.
 * Loading a config must never require a real key; a missing key is a valid,
 * reportable state (used by `doctor`), and only becomes a hard error when an
 * operation actually needs credentials.
 *
 * Reading a key also tells the central redactor what it is, so a credential that
 * comes back inside a model's answer is masked rather than filed. See the note on
 * `apiKey` below.
 */

export type Env = Readonly<Record<string, string | undefined>>;

const positiveInt = (fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
    });

function resolveBaseUrl(env: Env): string {
  const raw = env.BHARATCODE_API_BASE?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError({
      kind: 'config',
      message: 'BHARATCODE_API_BASE is not a valid URL.',
      remediation:
        'Set BHARATCODE_API_BASE to an https:// origin, e.g. https://bharatcode.ai/api/model/v1',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError({
      kind: 'config',
      message: 'BHARATCODE_API_BASE must use the https: (or http: for local testing) scheme.',
      remediation: 'Use an https:// URL for real use.',
    });
  }
  // Strip a trailing slash so path joins are predictable.
  return raw.replace(/\/+$/, '');
}

/**
 * The optional pre-request completion budget, or nothing at all.
 *
 * Both halves have to be present, and the reason is what this function is for. A ceiling
 * with nowhere to count into is a number nobody enforces: it reads like a budget, prints
 * like a budget, and lets every request through — the exact defect this repository has
 * already had to correct once in its documentation. So a half-configured pair is a
 * configuration error at load time, before any request is possible, rather than a silent
 * no-op or a request-time surprise.
 *
 * The ledger has to be an absolute path because the reservation is made by several
 * processes that do not share a working directory: `plan`, `implement` and `review` each
 * resolve a relative path against wherever they happened to be started, and three ledgers
 * of one slot each is three times the ceiling.
 */
function resolveRequestBudget(env: Env): RequestBudget | undefined {
  const rawLimit = env.BHARATCODE_MAX_COMPLETION_REQUESTS?.trim();
  const rawLedger = env.BHARATCODE_REQUEST_LEDGER?.trim();
  if (!rawLimit && !rawLedger) return undefined;
  if (!rawLedger) {
    throw new AppError({
      kind: 'config',
      message:
        'BHARATCODE_MAX_COMPLETION_REQUESTS is set with no BHARATCODE_REQUEST_LEDGER, so there is ' +
        'nowhere to record which requests have already been counted.',
      remediation:
        'Point BHARATCODE_REQUEST_LEDGER at an absolute directory this run owns, or unset ' +
        'BHARATCODE_MAX_COMPLETION_REQUESTS to run without a ceiling.',
    });
  }
  if (!rawLimit) {
    throw new AppError({
      kind: 'config',
      message:
        'BHARATCODE_REQUEST_LEDGER is set with no BHARATCODE_MAX_COMPLETION_REQUESTS, so the ' +
        'ledger would fill up and never refuse anything.',
      remediation: 'Set BHARATCODE_MAX_COMPLETION_REQUESTS to the number of requests authorised.',
    });
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AppError({
      kind: 'config',
      message: 'BHARATCODE_MAX_COMPLETION_REQUESTS must be a whole number of requests, at least 1.',
      remediation: `It was set to ${JSON.stringify(rawLimit)}.`,
    });
  }
  if (!path.isAbsolute(rawLedger)) {
    throw new AppError({
      kind: 'config',
      message: 'BHARATCODE_REQUEST_LEDGER must be an absolute directory path.',
      remediation:
        'The stages of one run start in different directories, so a relative ledger path becomes ' +
        'several ledgers and the ceiling stops meaning one run.',
    });
  }
  return { limit, ledgerDirectory: rawLedger };
}

/** Load a BharatCode client config from an environment record. */
export function loadBharatCodeConfig(env: Env = process.env): BharatCodeClientConfig {
  const parsedEnv = z
    .object({
      timeoutMs: positiveInt(DEFAULT_TIMEOUT_MS),
      maxRetries: positiveInt(DEFAULT_MAX_RETRIES),
    })
    .parse({
      timeoutMs: env.BHARATCODE_TIMEOUT_MS,
      maxRetries: env.BHARATCODE_MAX_RETRIES,
    });

  const apiKey = env.BHARATCODE_API_KEY?.trim() || undefined;
  // Registering the value, because a pattern cannot know it in advance.
  //
  // Two masks guard what a run keeps and what it prints, and both are the same
  // process-wide `defaultRedactor`: the one a stage calls as it files its document,
  // and the one a sink calls over the stored bytes. Each knows the credential formats
  // this build has seen. Neither knows what a gateway answers with — a debug proxy or a
  // model quoting its own headers can put the key inside the completion, which then
  // arrives as the stage's own text and gets filed, and packed, and sent to a reviewer.
  // This function is the only place in `src` that turns an environment into a config, so
  // it is the one place that can hand the masks the actual value. It prints nothing:
  // `summarizeConfig` reports that a key was read, never what it says.
  if (apiKey) defaultRedactor.add(apiKey);

  return {
    apiKey,
    baseUrl: resolveBaseUrl(env),
    model: env.BHARATCODE_MODEL?.trim() || undefined,
    timeoutMs: parsedEnv.timeoutMs,
    retry: {
      maxRetries: parsedEnv.maxRetries,
      baseDelayMs: env.BHARATCODE_RETRY_BASE_MS?.trim()
        ? Number(env.BHARATCODE_RETRY_BASE_MS)
        : 500,
      maxDelayMs: env.BHARATCODE_RETRY_MAX_MS?.trim()
        ? Number(env.BHARATCODE_RETRY_MAX_MS)
        : 15_000,
    },
    requestBudget: resolveRequestBudget(env),
  };
}

/**
 * A description of the resolved configuration that carries no API key: the key
 * is not a field of this shape, only whether one was read. `doctor` renders it,
 * and the base URL it prints is whatever `BHARATCODE_API_BASE` said.
 */
export interface SafeConfigSummary {
  readonly configured: boolean;
  readonly baseUrl: string;
  readonly model: string | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly apiKeySource: 'environment' | 'none';
}

export function summarizeConfig(config: BharatCodeClientConfig): SafeConfigSummary {
  return {
    configured: Boolean(config.apiKey),
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.retry.maxRetries,
    apiKeySource: config.apiKey ? 'environment' : 'none',
  };
}
