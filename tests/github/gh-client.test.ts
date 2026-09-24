import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { GhCliGitHubSource } from '../../src/github/gh-client.js';
import {
  commitPayload,
  issuePayload,
  malformedRepositoryPayload,
  pullRequestDisguisedAsIssuePayload,
  repositoryPayload,
} from '../fixtures/github-payloads.js';
import { TEST_REPO, ok, scriptedRunner } from '../helpers/github.js';

function sourceWith(stdout: string, code = 0, stderr = '') {
  const scripted = scriptedRunner({ gh: { code, stdout, stderr } });
  return { source: new GhCliGitHubSource({ run: scripted.run }), scripted };
}

function sourceReturning(payload: unknown) {
  return sourceWith(JSON.stringify(payload));
}

async function errorFrom(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw new Error(`expected an AppError, got ${String(error)}`);
    }
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('GhCliGitHubSource', () => {
  it('calls gh api with an argv array and never a shell string', async () => {
    const { source, scripted } = sourceReturning(repositoryPayload);
    await source.repository(TEST_REPO);
    expect(scripted.calls).toEqual([
      {
        file: 'gh',
        args: ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/projectbharat/datekit'],
      },
    ]);
  });

  it('targets an Enterprise host through a value, not a command line', async () => {
    const { source, scripted } = sourceReturning(repositoryPayload);
    await source.repository({ host: 'git.corp.example', owner: 'projectbharat', repo: 'datekit' });
    expect(scripted.calls[0]?.args).toEqual([
      'api',
      '--hostname',
      'git.corp.example',
      '--method',
      'GET',
      'repos/projectbharat/datekit',
    ]);
  });

  it('maps a repository payload into a validated identity', async () => {
    const { source } = sourceReturning(repositoryPayload);
    const identity = await source.repository(TEST_REPO);
    expect(identity).toMatchObject({
      fullName: 'projectbharat/datekit',
      defaultBranch: 'main',
      isFork: false,
      isPrivate: false,
      source: 'github-api',
    });
  });

  it('reads an issue and records body provenance', async () => {
    const { source, scripted } = sourceReturning(issuePayload);
    const issue = await source.issue({ ...TEST_REPO, number: 123 });
    expect(scripted.calls[0]?.args.at(-1)).toBe('repos/projectbharat/datekit/issues/123');
    expect(issue.number).toBe(123);
    expect(issue.labels).toEqual(['bug', 'good first issue']);
    expect(issue.state).toBe('open');
    expect(issue.untrusted).toBe(true);
    expect(issue.bodyLength).toBe(issuePayload.body.length);
    expect(issue.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(issue.wasTruncated).toBe(false);
  });

  it('truncates an oversized body but keeps the hash of the whole thing', async () => {
    const { MAX_ISSUE_BODY_CHARS } = await import('../../src/github/types.js');
    const full = 'a'.repeat(MAX_ISSUE_BODY_CHARS + 1);
    const { source } = sourceReturning({ ...issuePayload, body: full });
    const issue = await source.issue({ ...TEST_REPO, number: 123 });
    expect(issue.body).toHaveLength(MAX_ISSUE_BODY_CHARS);
    expect(issue.wasTruncated).toBe(true);
    expect(issue.bodyLength).toBe(full.length);
    expect(issue.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a pull request served from the issues endpoint', async () => {
    const { source } = sourceReturning(pullRequestDisguisedAsIssuePayload);
    const error = await errorFrom(source.issue({ ...TEST_REPO, number: 123 }));
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toContain('pull request');
  });

  it('collapses control characters so a title cannot forge terminal lines', async () => {
    const { source } = sourceReturning({
      ...issuePayload,
      title: 'Reset\u001b[31m colours\nsecond line\u0000tail',
    });
    const issue = await source.issue({ ...TEST_REPO, number: 123 });
    expect(issue.title).toBe('Reset [31m colours second line tail');
    expect(issue.title).not.toContain('\n');
  });

  it('rejects a payload that is missing required fields', async () => {
    const { source } = sourceReturning(malformedRepositoryPayload);
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toMatch(/full_name|default_branch/);
  });

  it('rejects a repository payload that describes a different repo', async () => {
    const { source } = sourceReturning({ ...repositoryPayload, full_name: 'someone/else' });
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.message).toContain('does not match the requested');
  });

  it('reports gh not being installed as a configuration problem', async () => {
    const { source } = sourceWith('', 1, 'gh: command not found');
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.kind).toBe('config');
    expect(error.remediation).toContain('gh auth login');
  });

  it('maps 404 to not-found and says it may be a permissions problem', async () => {
    const { source } = sourceWith('', 1, 'gh: Not Found (HTTP 404)');
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.kind).toBe('not-found');
    expect(error.retryable).toBe(false);
    expect(error.remediation).toMatch(/private|permission/i);
  });

  it('maps an authentication failure to auth and tells the user to log in', async () => {
    const { source } = sourceWith(
      '',
      1,
      'gh: Requires authentication (HTTP 401). Please run gh auth login',
    );
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.kind).toBe('auth');
    expect(error.remediation).toContain('gh auth login');
  });

  it('treats a rate limit as retryable', async () => {
    const { source } = sourceWith('', 1, 'gh: API rate limit exceeded (HTTP 403)');
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.kind).toBe('rate-limit');
    expect(error.retryable).toBe(true);
  });

  it('treats a server error as retryable', async () => {
    const { source } = sourceWith('', 1, 'gh: Server Error (HTTP 502)');
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.kind).toBe('server');
    expect(error.retryable).toBe(true);
  });

  it('treats an unparseable body as invalid rather than retrying forever', async () => {
    const { source } = sourceWith('<html>login required</html>');
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.kind).toBe('invalid-response');
    expect(error.retryable).toBe(false);
  });

  it('reports an empty body distinctly from a bad one', async () => {
    const { source } = sourceWith('');
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(error.message).toContain('empty response body');
  });

  it('never echoes a token that gh happens to print in an error', async () => {
    const token = 'ghp_SECRETTOKENNOTTOBE_SHOWN1';
    const { source } = sourceWith('', 1, `gh: bad token ${token} (HTTP 401)`);
    const error = await errorFrom(source.repository(TEST_REPO));
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(token);
    expect(JSON.stringify(error.details)).toContain('[REDACTED]');
  });

  it('validates the commit sha for a branch head', async () => {
    const { source, scripted } = sourceReturning(commitPayload);
    const head = await source.branchHead({ ...TEST_REPO, branch: 'main' });
    expect(head.sha).toBe(commitPayload.sha);
    expect(head.source).toBe('github-api');
    expect(scripted.calls[0]?.args.at(-1)).toBe('repos/projectbharat/datekit/commits/main');
  });

  it('rejects a commit object without a full sha', async () => {
    const { source } = sourceReturning({ sha: 'not-a-sha' });
    const error = await errorFrom(source.branchHead({ ...TEST_REPO, branch: 'main' }));
    expect(error.kind).toBe('invalid-response');
  });

  it('refuses to interpolate unsafe segments into an API path, without invoking gh', async () => {
    const scripted = scriptedRunner({ gh: ok('{}') });
    const source = new GhCliGitHubSource({ run: scripted.run });
    const error = await errorFrom(
      source.repository({ host: 'github.com', owner: '../etc', repo: 'datekit' }),
    );
    expect(error.kind).toBe('validation');
    expect(scripted.calls).toHaveLength(0);
  });

  it('refuses a branch name that would break out of the path', async () => {
    const scripted = scriptedRunner({ gh: ok('{}') });
    const source = new GhCliGitHubSource({ run: scripted.run });
    const error = await errorFrom(source.branchHead({ ...TEST_REPO, branch: '../../x' }));
    expect(error.kind).toBe('validation');
    expect(scripted.calls).toHaveLength(0);
  });

  it('refuses a non-integer issue number', async () => {
    const scripted = scriptedRunner({ gh: ok('{}') });
    const source = new GhCliGitHubSource({ run: scripted.run });
    const error = await errorFrom(source.issue({ ...TEST_REPO, number: Number.POSITIVE_INFINITY }));
    expect(error.kind).toBe('validation');
    expect(scripted.calls).toHaveLength(0);
  });
});
