import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '../../src/core/errors.js';
import { ISSUE_URL_EXAMPLE, parseIssueUrl } from '../../src/intake/issue-url.js';

const VALID = 'https://github.com/projectbharat/datekit/issues/123';

function expectRejected(input: string, fragment: string): void {
  let thrown: unknown;
  try {
    parseIssueUrl(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected '${input}' to be rejected`).toBeInstanceOf(AppError);
  const error = thrown as AppError;
  expect(error.kind).toBe('validation');
  expect(error.message.toLowerCase()).toContain(fragment.toLowerCase());
}

describe('parseIssueUrl', () => {
  it('accepts the canonical form', () => {
    expect(parseIssueUrl(VALID)).toEqual({
      host: 'github.com',
      owner: 'projectbharat',
      repo: 'datekit',
      number: 123,
      canonical: 'projectbharat/datekit#123',
      url: VALID,
    });
  });

  it('normalises trailing slash, query and deep-link fragment', () => {
    const a = parseIssueUrl(VALID + '/');
    const b = parseIssueUrl(VALID + '?platform=desktop');
    const c = parseIssueUrl(VALID + '#issuecomment-9988776655');
    expect(a.url).toBe(VALID);
    expect(b.url).toBe(VALID);
    expect(c.url).toBe(VALID);
    expect(c.number).toBe(123);
  });

  it('accepts www and surrounding whitespace', () => {
    expect(parseIssueUrl('  https://www.GitHub.com/a/b/issues/7  ').url).toBe(
      'https://github.com/a/b/issues/7',
    );
  });

  it('accepts a dotless trailing host dot', () => {
    expect(parseIssueUrl('https://github.com./a/b/issues/7').host).toBe('github.com');
  });

  it('accepts an explicitly allowed Enterprise host', () => {
    const ref = parseIssueUrl('https://git.corp.example/o/r/issues/9', {
      allowHosts: ['git.corp.example'],
    });
    expect(ref.host).toBe('git.corp.example');
    expect(ref.url).toBe('https://git.corp.example/o/r/issues/9');
  });

  it('rejects an Enterprise host that was not allowed', () => {
    expectRejected('https://git.corp.example/o/r/issues/9', 'not an accepted GitHub host');
  });

  it('rejects look-alike and suffix hosts', () => {
    expectRejected('https://github.com.evil.test/a/b/issues/1', 'host');
    expectRejected('https://evil.github.com/a/b/issues/1', 'host');
    expectRejected('https://githubusercontent.com/a/b/issues/1', 'host');
    expectRejected('https://gitlab.com/a/b/-/issues/1', 'host');
  });

  it('never accepts credentials carried in the URL', () => {
    expectRejected('https://user:pass@github.com/a/b/issues/1', 'credentials embedded in a URL');
  });

  it('rejects non-https protocols', () => {
    expectRejected('http://github.com/a/b/issues/1', 'protocol must be https');
    expectRejected('ssh://git@github.com/a/b/issues/1', 'protocol must be https');
    expectRejected('git@github.com:a/b/issues/1', 'not an absolute URL');
  });

  it('rejects a non-default port', () => {
    expectRejected('https://github.com:8443/a/b/issues/1', 'port');
  });

  it('rejects pull requests and discussions', () => {
    expectRejected('https://github.com/a/b/pull/123', 'pull request');
    expectRejected('https://github.com/a/b/discussions/123', "'issues'");
  });

  it('rejects malformed or missing issue numbers', () => {
    for (const input of [
      'https://github.com/a/b/issues/0',
      'https://github.com/a/b/issues/-5',
      'https://github.com/a/b/issues/abc',
      'https://github.com/a/b/issues/12.5',
      'https://github.com/a/b/issues/1e3',
      'https://github.com/a/b/issues/01',
      'https://github.com/a/b/issues/99999999999999999999',
    ]) {
      expectRejected(input, 'positive integer');
    }
  });

  it('rejects traversal-style and illegal owner/repo segments', () => {
    expectRejected('https://github.com/../etc/issues/1', 'expected /owner/repo/issues');
    expectRejected('https://github.com/a/%2e%2e/issues/1', 'expected /owner/repo/issues');
    expectRejected('https://github.com/a/b%2Fc/issues/1', 'repository');
    expectRejected('https://github.com/a/b c/issues/1', 'whitespace');
  });

  it('rejects truncated paths', () => {
    expectRejected('https://github.com/a/b', '/owner/repo/issues/<number>');
    expectRejected('https://github.com/a', '/owner/repo/issues/<number>');
    expectRejected('https://github.com/a/b/issues', '/owner/repo/issues/<number>');
    expectRejected('https://github.com/a/b/issues/1/comments', 'unexpected path segments');
  });

  it('rejects empty, non-URL and oversized input', () => {
    expectRejected('', 'empty');
    expectRejected('   ', 'empty');
    expectRejected('github.com/a/b/issues/1', 'absolute URL');
    expectRejected('https://github.com/a/b/issues/1?x=' + 'y'.repeat(3000), 'exceeds');
  });

  it('publishes the same example the help text uses', () => {
    expect(parseIssueUrl(ISSUE_URL_EXAMPLE).canonical).toBe('owner/repo#123');
  });

  it('reports a validation kind so the CLI exits non-zero', () => {
    try {
      parseIssueUrl('https://example.com/a/b/issues/1');
      throw new Error('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as AppError).remediation).toBeTruthy();
    }
  });
});
