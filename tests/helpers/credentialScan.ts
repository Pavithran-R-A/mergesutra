/**
 * The credential shapes this project already treats as secrets, applied as a
 * *detector* at the release boundary.
 *
 * `src/security/redaction.ts` is a mask. It runs on text the product is about to
 * emit, and for that job over-masking is the safe direction to err in: a line that
 * merely mentions `promptTokens` gets its value blanked and nobody notices. A
 * boundary scan has the opposite economy — it has to be able to say "clean" about
 * 448 real files, so a rule that matches a tenth of them is not a scan but noise,
 * and noise gets an allowlist and then gets ignored. Measured on this build's own
 * artifact, the shipped generic masking pattern fires on roughly eighty positions,
 * and the positions it fires on are type annotations and member accesses.
 *
 * So the families here are the ones whose *shape alone* identifies a credential
 * (the prefix-bearing forms the product already recognises), plus two syntactic
 * families whose right-hand side has to be a literal rather than a reference: an
 * assignment to one of the five environment names this project swears never to
 * print, and a sensitive header carrying a value. A type position
 * (`apiKey: string`), a member access (`apiKey: deps.config?.apiKey`) and a
 * template (`Bearer ${auth}`) carry no bytes of any credential, and treating them
 * as findings is what makes a whole-tree scan unusable.
 *
 * Nothing here is a general entropy detector, deliberately: the register closure
 * for this item is "clean, with the false positives named", and a heuristic that
 * fires on identifiers cannot name them.
 */

/** The eight things this scanner can report. */
export type CredentialFamily =
  | 'bearer-key'
  | 'github-token'
  | 'slack-token'
  | 'aws-access-key-id'
  | 'private-key-material'
  | 'secret-assignment'
  | 'authorization-header'
  | 'known-secret-value';

export const CREDENTIAL_FAMILIES: readonly CredentialFamily[] = [
  'bearer-key',
  'github-token',
  'slack-token',
  'aws-access-key-id',
  'private-key-material',
  'secret-assignment',
  'authorization-header',
  'known-secret-value',
];

export interface CredentialFinding {
  readonly family: CredentialFamily;
  /** The path the caller passed in, echoed for reporting. */
  readonly file: string;
  readonly line: number;
  /**
   * A preview with the secret removed. The prefix-bearing families keep their
   * public format marker (`sk-`, `ghp_`, `xoxb`, `AKIA`, `----`), which names the
   * kind of credential without carrying any of it; the syntactic families keep
   * only the name that made them fire.
   */
  readonly excerpt: string;
}

/**
 * Environment names whose values must never appear anywhere.
 *
 * `tests/security/credential-boundary.test.ts` ties this list to the shipped
 * `dist/security/redaction.js`, so the scan cannot quietly stop covering a name the
 * product still promises to mask.
 */
export const NAMED_SECRET_ENV_NAMES: readonly string[] = [
  'BHARATCODE_API_KEY',
  'BHARATCODE_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_PAT',
];

/** Header names whose value is a credential by definition. Longest first. */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
  'proxy-authorization',
  'set-cookie',
  'authorization',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'apikey',
  'cookie',
];

const MASK = '[REDACTED]';

/** Authentication schemes that sit in front of a header's real value. */
const HEADER_SCHEMES = /^(?:bearer|basic|digest|token|aws4-hmac-sha256)\s+/i;

/** A secret value that exists on the machine running the tests. Never printed. */
export interface SecretValue {
  readonly name: string;
  readonly value: string;
}

/**
 * The real credentials configured on this host, if any.
 *
 * Values are returned so a scan can look for them; no reporting path in this
 * helper or its tests ever writes one out, because findings carry only a preview
 * built by `preview()`.
 */
export function runtimeSecretValues(env: NodeJS.ProcessEnv = process.env): SecretValue[] {
  const found: SecretValue[] = [];
  for (const name of NAMED_SECRET_ENV_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      found.push({ name, value: value.trim() });
    }
  }
  return found;
}

/**
 * True when a right-hand side carries no credential bytes.
 *
 * Every arm is a claim about *position*, not about content: a reference, a
 * placeholder, an already-masked value, a scalar, or a bare identifier is syntax,
 * and syntax cannot hold a secret. What survives — an opaque run of at least eight
 * characters — is treated as a literal and reported.
 *
 * The accepted limit is stated plainly: an unquoted bare word after a colon
 * (`password: hunter2`) reads as a type or reference position and is not reported.
 * Credentials of that kind are covered by the shape families and by
 * `known-secret-value`, not by this predicate.
 */
export function isInertCredentialValue(value: string): boolean {
  const text = stripQuotes(value);
  if (text === '') return true;
  if (text.includes(MASK)) return true;
  if (/^[`{$[%<>]/.test(text)) return true;
  if (/\s/.test(text)) return true;
  if (/^\{\{.*\}\}$/.test(text) || /^\.\.\.+$/.test(text)) return true;
  if (/^<?x{3,}>?$/i.test(text)) return true;
  if (text.includes('…')) return true;
  if (/[.()[\]{}|&?:;"']/u.test(text)) return true;
  if (/^-?[\d.]+$/u.test(text)) return true;
  if (/^(?:true|false|null|undefined|NaN|Infinity|void|readonly)$/iu.test(text)) return true;
  if (/^[A-Za-z_][A-Za-z_]*$/u.test(text)) return true;
  return text.length < 8;
}

/**
 * The same judgement for a shell-style `NAME=value`, where a bare word really is
 * the value: only an expansion, a command substitution or a member access is
 * inert here, because a shell has no type positions to hide behind.
 */
function isReferenceExpression(value: string): boolean {
  const text = stripQuotes(value);
  if (text === '') return true;
  if (text.includes(MASK)) return true;
  if (/^[`{$[%<>]/.test(text)) return true;
  return /[.()[\]]/.test(text);
}

function stripQuotes(value: string): string {
  return value
    .trim()
    .replace(/^["'`]/, '')
    .replace(/["'`;,\s]+$/, '')
    .trim();
}

/** A preview that removes the secret and keeps enough context to find the line. */
function preview(line: string, start: number, length: number, publicPrefix = ''): string {
  const head = line.slice(Math.max(0, start - 40), start);
  const tail = line.slice(start + length, start + length + 8);
  return `${head}${publicPrefix}${MASK}${tail}`.slice(0, 100);
}

/** Offset in `text` of the start of each line, so a match index becomes a line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Prefix-bearing shapes that a single line can carry, from the product's own list. */
const LINE_SHAPES: readonly (readonly [CredentialFamily, RegExp])[] = [
  ['bearer-key', /\bsk-[A-Za-z0-9_-]{8,}/g],
  ['github-token', /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{8,}/g],
  ['aws-access-key-id', /\bAKIA[0-9A-Z]{16}\b/g],
];

/** Key material spans lines, so it is matched over the whole text. */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const NAMED = NAMED_SECRET_ENV_NAMES.join('|');
const HEADERS = [...SENSITIVE_HEADER_NAMES].sort((a, b) => b.length - a.length).join('|');

/** `NAME: "literal"` / `NAME = 'literal'`, for the five names this project swears by. */
const NAMED_QUOTED = new RegExp(
  String.raw`\b(${NAMED})["']?\s*[:=]\s*(["'])((?:(?!\2)[^\n]){8,})\2`,
  'g',
);

/** `NAME=literal` in shell form, where a bare word is the value and not a type. */
const NAMED_SHELL = new RegExp(String.raw`\b(${NAMED})=(["']?)([^\n]{8,})`, 'g');

/** A sensitive header followed by a value, wherever it sits on the line. */
const HEADER_LINE = new RegExp(String.raw`(?:^|[^\w-])(${HEADERS})["']?\s*[:=]\s*([^\n]*)`, 'gi');

/** Shape and syntax findings for one file, every one of them masked. */
export function scanForCredentials(
  file: string,
  text: string,
  secretValues: Iterable<string> = [],
): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  const starts = lineStarts(text);
  const lines = text.split('\n');

  for (const [family, pattern] of LINE_SHAPES) {
    const re = new RegExp(pattern.source, pattern.flags);
    lines.forEach((line, index) => {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        findings.push({
          family,
          file,
          line: index + 1,
          excerpt: preview(line, match.index, match[0].length, match[0].slice(0, 4)),
        });
        if (match.index === re.lastIndex) re.lastIndex += 1;
      }
    });
  }

  const keyMaterial = new RegExp(PRIVATE_KEY.source, PRIVATE_KEY.flags);
  let match: RegExpExecArray | null;
  while ((match = keyMaterial.exec(text)) !== null) {
    findings.push({
      family: 'private-key-material',
      file,
      line: lineOf(starts, match.index),
      excerpt: `----${MASK}----`,
    });
    if (match.index === keyMaterial.lastIndex) keyMaterial.lastIndex += 1;
  }

  const quoted = new RegExp(NAMED_QUOTED.source, NAMED_QUOTED.flags);
  while ((match = quoted.exec(text)) !== null) {
    const name = match[1] ?? '';
    const value = match[3] ?? '';
    if (!isInertCredentialValue(value)) {
      findings.push({
        family: 'secret-assignment',
        file,
        line: lineOf(starts, match.index),
        excerpt: `${name}: ${MASK}`,
      });
    }
    if (match.index === quoted.lastIndex) quoted.lastIndex += 1;
  }

  const shell = new RegExp(NAMED_SHELL.source, NAMED_SHELL.flags);
  while ((match = shell.exec(text)) !== null) {
    const name = match[1] ?? '';
    const value = match[3] ?? '';
    if (!isReferenceExpression(value)) {
      findings.push({
        family: 'secret-assignment',
        file,
        line: lineOf(starts, match.index),
        excerpt: `${name}=${MASK}`,
      });
    }
    if (match.index === shell.lastIndex) shell.lastIndex += 1;
  }

  const header = new RegExp(HEADER_LINE.source, HEADER_LINE.flags);
  while ((match = header.exec(text)) !== null) {
    const name = match[1] ?? '';
    const value = (match[2] ?? '').replace(HEADER_SCHEMES, '').replace(/[,;]\s*$/, '');
    if (!isInertCredentialValue(value)) {
      findings.push({
        family: 'authorization-header',
        file,
        line: lineOf(starts, match.index),
        excerpt: `${name}: ${MASK}`,
      });
    }
    if (match.index === header.lastIndex) header.lastIndex += 1;
  }

  for (const secret of secretValues) {
    if (secret.length < 8) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(secret, from);
      if (at < 0) break;
      const start = starts[lineOf(starts, at) - 1] ?? 0;
      const lineEnd = text.indexOf('\n', at);
      const line = text.slice(start, lineEnd < 0 ? undefined : lineEnd);
      findings.push({
        family: 'known-secret-value',
        file,
        line: lineOf(starts, at),
        excerpt: preview(line, at - start, secret.length),
      });
      from = at + secret.length;
    }
  }

  return findings;
}

/** One hit of the product's *masking* vocabulary, kept structured on purpose. */
export interface BroadMaskHit {
  readonly file: string;
  readonly line: number;
  /** The identifier that made the mask fire. */
  readonly name: string;
  /** The text after the `:` or `=`, quotes included. */
  readonly rightHandSide: string;
  /** Whether that text is a quoted literal or code. */
  readonly form: 'literal' | 'code';
}

const GENERIC_NAME = String.raw`[A-Za-z0-9_]*(?:secret|token|password|passwd|apikey|api_key)[A-Za-z0-9_]*`;

/**
 * The shipped redactor's generic `name: value` pattern, run as if it were a
 * detector. Used to measure what this boundary scan deliberately does not do.
 */
export function broadMaskHits(file: string, text: string): BroadMaskHit[] {
  const re = new RegExp(String.raw`\b(${NAMED}|${GENERIC_NAME})\b\s*[:=]\s*([^\n]{0,80})`, 'gi');
  const starts = lineStarts(text);
  const hits: BroadMaskHit[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const rhs = (match[2] ?? '').trim();
    hits.push({
      file,
      line: lineOf(starts, match.index),
      name: match[1] ?? '',
      rightHandSide: rhs,
      form: /^["']/.test(rhs) ? 'literal' : 'code',
    });
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return hits;
}
