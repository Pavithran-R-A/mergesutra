/**
 * Central secret redaction.
 *
 * MergeSutra must never leak credentials into logs, reports, error text, model
 * requests, or terminal output. This module is the single place that knows how
 * to recognise and mask secrets. Everything that writes potentially
 * user-visible or persisted text routes through here.
 */

const MASK = '[REDACTED]';

/** Header names (case-insensitive) whose values are always secret. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'apikey',
  'cookie',
  'set-cookie',
]);

/**
 * Environment variables whose *values* must never appear in any output.
 * The value itself is captured at runtime (see `Redactor`); these names are
 * also masked when they appear inline as `NAME=value`.
 */
const SECRET_ENV_NAMES = [
  'BHARATCODE_API_KEY',
  'BHARATCODE_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_PAT',
] as const;

/** Token-shaped patterns for well-known credential formats. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // BharatCode / OpenAI-style keys: sk-..., sk-proj-...
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // GitHub tokens: ghp_, gho_, ghs_, github_pat_
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g,
  // Slack
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  // AWS access key ids
  /\bAKIA[0-9A-Z]{16}\b/g,
  // PEM private key material
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Generic "key/token/secret/password": "value" in JSON or env form
  new RegExp(
    `\\b(?:${SECRET_ENV_NAMES.join('|')}|[A-Za-z0-9_]*(?:secret|token|password|passwd|apikey|api_key)[A-Za-z0-9_]*)\\b(\\s*[:=]\\s*)("?)([^"\\s,}]+)\\2`,
    'gi',
  ),
];

/**
 * A `Redactor` holds the concrete secret values observed at runtime (e.g. the
 * configured API key) so exact matches are masked in addition to pattern
 * matches. Values are stored, never returned.
 */
export class Redactor {
  private readonly known: string[] = [];

  constructor(secretValues: Iterable<string | undefined> = []) {
    for (const value of secretValues) this.add(value);
  }

  /** Register a raw secret value to be masked wherever it appears. */
  add(value: string | undefined | null): void {
    if (typeof value === 'string' && value.length >= 4) {
      if (!this.known.includes(value)) this.known.push(value);
    }
  }

  /** Mask a single header value if its name is sensitive. */
  header(name: string, value: string): string {
    return SENSITIVE_HEADERS.has(name.toLowerCase()) ? MASK : this.text(value);
  }

  /** Redact a headers record, returning a new safe record. */
  headers(init: Record<string, string> | [string, string][] | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!init) return out;
    const entries: Iterable<[string, string]> = Array.isArray(init) ? init : Object.entries(init);
    for (const [name, value] of entries) {
      out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? MASK : this.text(value);
    }
    return out;
  }

  /** Redact arbitrary text. */
  text(input: string): string {
    let result = input;
    for (const secret of this.known) {
      result = splitJoin(result, secret, MASK);
    }
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, (match, ...groups: unknown[]) => maskGeneric(match, groups));
    }
    return result;
  }

  /** Redact all string leaves of a JSON-ish value (defensive, for details). */
  deep<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.deep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] =
          SENSITIVE_HEADERS.has(k.toLowerCase()) || /secret|token|password|key/i.test(k)
            ? v == null
              ? v
              : MASK
            : this.deep(v);
      }
      return out as unknown as T;
    }
    return value;
  }
}

function maskGeneric(match: string, groups: unknown[]): string {
  // For the generic key=value pattern we want to keep the `NAME=` prefix and
  // mask only the value. Other patterns have no useful capture groups.
  const sep = groups[0];
  if (typeof sep === 'string' && /[:=]/.test(sep)) {
    const quote = typeof groups[1] === 'string' ? (groups[1] as string) : '';
    return `${match.slice(0, match.length - (groups[2] as string).length - quote.length)}${quote}${MASK}${quote}`;
  }
  return MASK;
}

/** Case-sensitive literal split/join (avoids RegExp escaping pitfalls). */
function splitJoin(input: string, needle: string, replacement: string): string {
  if (!needle) return input;
  return input.split(needle).join(replacement);
}

/** Shared default redactor for module-level convenience helpers. */
export const defaultRedactor = new Redactor();

/** Convenience: mask a single sensitive header value by name. */
export function redactHeader(name: string, value: string): string {
  return defaultRedactor.header(name, value);
}

/** Convenience: redact text against a one-off list of known secrets. */
export function redactText(text: string, secretValues: Iterable<string> = []): string {
  return new Redactor(secretValues).text(text);
}

export const REDACTED_MASK = MASK;
