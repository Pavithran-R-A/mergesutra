import { AppError } from '../core/errors.js';

/**
 * GitHub issue URL parsing.
 *
 * A URL is untrusted input, so this refuses rather than guesses: anything that
 * is not exactly `https://<host>/<owner>/<repo>/issues/<number>` fails with a
 * specific reason. Look-alike hosts, embedded credentials, ports, pull-request
 * links and traversal-style owner/repo segments are all rejected here, before
 * any process is spawned or any path is built from them.
 */

export interface IssueRef {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** `owner/repo#123` — safe to log, safe to use as a label. */
  readonly canonical: string;
  /** Rebuilt canonical URL: no query, no credentials, no port. */
  readonly url: string;
}

export interface ParseIssueUrlOptions {
  /** Extra exact hostnames to accept (GitHub Enterprise Server). */
  readonly allowHosts?: readonly string[];
}

const GITHUB_HOST = 'github.com';
const MAX_INPUT_LENGTH = 2_048;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;

function badUrl(
  reason: string,
  remediation = 'Expected https://github.com/owner/repo/issues/123',
): AppError {
  return new AppError({
    kind: 'validation',
    message: `Not a usable GitHub issue URL: ${reason}.`,
    remediation,
    details: { reason },
  });
}

export function parseIssueUrl(input: string, options: ParseIssueUrlOptions = {}): IssueRef {
  const raw = input?.trim() ?? '';
  if (raw.length === 0) throw badUrl('input was empty');
  if (raw.length > MAX_INPUT_LENGTH) throw badUrl(`input exceeds ${MAX_INPUT_LENGTH} characters`);
  if (/[\s\0]/.test(raw)) throw badUrl('input contains whitespace or control characters');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badUrl('it is not an absolute URL');
  }

  if (url.protocol !== 'https:') {
    throw badUrl(
      `protocol must be https, got ${url.protocol.replace(':', '')}`,
      'Use the https:// form of the issue URL. SSH and local paths are not URLs.',
    );
  }
  if (url.username || url.password) {
    throw badUrl(
      'credentials embedded in a URL are never accepted',
      'Authenticate with `gh auth login`. MergeSutra never reads tokens from URLs or arguments.',
    );
  }
  if (url.port) throw badUrl(`port ${url.port} is not allowed`);

  const rawHost = url.hostname.toLowerCase().replace(/\.$/, '');
  // `www.` is a GitHub alias, not a different forge; an Enterprise host keeps
  // whatever name it was given.
  const host = rawHost === `www.${GITHUB_HOST}` ? GITHUB_HOST : rawHost;
  const allowed = new Set(
    [GITHUB_HOST, `www.${GITHUB_HOST}`, ...(options.allowHosts ?? [])].map((h) => h.toLowerCase()),
  );
  if (!allowed.has(host)) {
    throw badUrl(
      `host '${host}' is not an accepted GitHub host`,
      `Only ${[...allowed].join(', ')} are accepted. Other forges are not supported yet.`,
    );
  }

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 4) {
    throw badUrl(`expected /owner/repo/issues/<number>, got '/${segments.join('/')}'`);
  }
  const [owner, repo, kind, numberRaw, ...extra] = segments;
  if (segments.length > 4 && !(extra.length === 1 && extra[0] === '')) {
    throw badUrl(`unexpected path segments after the issue number: '/${extra.join('/')}'`);
  }
  if (owner === 'pull' || kind === 'pull') {
    throw badUrl(
      'this is a pull request link, not an issue link',
      'MergeSutra turns an issue into a PR draft; give it the issue URL.',
    );
  }
  if (kind !== 'issues') {
    throw badUrl(`expected the segment 'issues', got '${kind ?? ''}'`);
  }

  if (!owner || !OWNER_PATTERN.test(owner) || owner === '.' || owner === '..') {
    throw badUrl(`owner '${owner ?? ''}' is not a valid GitHub owner`);
  }
  if (!repo || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw badUrl(`repository '${repo ?? ''}' is not a valid GitHub repository name`);
  }
  if (!numberRaw || !NUMBER_PATTERN.test(numberRaw)) {
    throw badUrl(`issue number '${numberRaw ?? ''}' is not a positive integer`);
  }
  const number = Number.parseInt(numberRaw, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw badUrl(`issue number '${numberRaw}' is out of range`);
  }

  return {
    host,
    owner,
    repo,
    number,
    canonical: `${owner}/${repo}#${number}`,
    url: `https://${host}/${owner}/${repo}/issues/${number}`,
  };
}

/** Human-facing example used in error remediation and help text. */
export const ISSUE_URL_EXAMPLE = 'https://github.com/owner/repo/issues/123';
