import { z } from 'zod';
import { AppError } from '../core/errors.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type BharatCodeClientConfig,
} from '../bharatcode/types.js';

/**
 * Configuration loading.
 *
 * Authentication material comes ONLY from the environment (or, later, a secure
 * local config file) — never from a command argument, fixture, or report.
 * Loading a config must never require a real key; a missing key is a valid,
 * reportable state (used by `doctor`), and only becomes a hard error when an
 * operation actually needs credentials.
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
