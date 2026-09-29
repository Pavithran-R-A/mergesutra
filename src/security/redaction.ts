/**
 * Central secret redaction.
 *
 * MergeSutra must never leak credentials into logs, reports, error text, model
 * requests, or terminal output. This module is the single place that knows how
 * to recognise and mask secrets. Everything that writes potentially
 * user-visible or persisted text routes through here: a stage masks what it
 * produces, and a sink that only ever reads what a stage produced routes through
 * `redactDocument` at the end of the line, because the first mask describes the
 * bytes as they were written and not the file as it is now.
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
    if (!init) return {};
    const entries: Iterable<[string, string]> = Array.isArray(init) ? init : Object.entries(init);
    // `Object.fromEntries`, not `out[name] = value`: a header name is somebody else's
    // string, and assigning to a key named `__proto__` is the setter, not a write.
    return Object.fromEntries(
      Array.from(entries, ([name, value]) => [
        name,
        SENSITIVE_HEADERS.has(name.toLowerCase()) ? MASK : this.text(value),
      ]),
    );
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
      const copy = this.copy(value, (k, v) =>
        isSensitiveKey(k) ? this.everyString(v) : this.deep(v),
      );
      return copy as unknown as T;
    }
    // A number, a boolean and null carry no secret and must survive intact:
    // masking a counter is how a redactor turns a valid record into an invalid one.
    return value;
  }

  /** Mask every string beneath a sensitive key, whatever depth it is hidden at. */
  private everyString(value: unknown): unknown {
    if (typeof value === 'string') return MASK;
    if (Array.isArray(value)) return value.map((v) => this.everyString(v));
    if (value && typeof value === 'object') return this.copy(value, (_k, v) => this.everyString(v));
    return value;
  }

  /**
   * A copy that keeps every key of `value` as an *own* property of the result.
   *
   * `Object.fromEntries` defines properties (CreateDataProperty), so a key named
   * `__proto__` stays a key. Assigning `out[k] = v` instead would run `Object.prototype`'s
   * setter for that one name: the key would disappear from the copy and its value would
   * become the copy's prototype — handing a document the choice of what every later
   * property lookup reads, and taking that key out of any schema's list of what it did not
   * recognise.
   */
  private copy(
    value: object,
    mask: (key: string, entry: unknown) => unknown,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        mask(key, entry),
      ]),
    );
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_HEADERS.has(key.toLowerCase()) || /secret|token|password|key/i.test(key);
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

/**
 * A copy of a whole document, with every string leaf masked.
 *
 * This is the boundary a *sink* calls — the evidence pack, the status screen, the
 * resume preview, an error's details — and it exists because those paths never parse
 * their input. They hand on a document an earlier stage wrote, and the promise a
 * stage made when it filed that document says nothing about what a human has done to
 * the file since, or about a stage that was once looser than this one. A sink that
 * renders a stored string has no more right to trust it than a parser has, so the
 * trust check happens here, at the last place that still controls the bytes.
 *
 * It is a copy, never an edit: the record on disk is the evidence, and a display
 * decision that rewrote it would quietly void a reviewer's receipts. Numbers,
 * booleans, nulls, ids, state words and digests pass through untouched — only text
 * is redactable, and masking a counter is how a redactor turns a valid report into
 * an unusable one.
 */
export function redactDocument<T>(value: T): T {
  return defaultRedactor.deep(value);
}

export const REDACTED_MASK = MASK;
