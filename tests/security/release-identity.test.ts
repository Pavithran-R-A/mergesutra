import { describe, expect, it } from 'vitest';
import { releaseIdentityProblems } from '../../scripts/lib/release-identity.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const approved = {
  version: '0.1.0',
  releaseTag: 'v0.1.0',
  eventName: 'release',
  ref: 'refs/tags/v0.1.0',
  repository: 'Pavithran-R-A/mergesutra',
  expectedRepository: 'Pavithran-R-A/mergesutra',
  head: SHA,
  workflowSha: SHA,
  tagCommit: SHA,
  remoteMainLine: SHA + '\trefs/heads/main',
};

describe('npm release requires the matching tag on protected main', () => {
  it('accepts the exact published release tag and remote main commit', () => {
    expect(releaseIdentityProblems(approved)).toEqual([]);
  });

  it('rejects the wrong package version or trigger', () => {
    expect(releaseIdentityProblems({ ...approved, releaseTag: 'v0.2.0' })).not.toEqual([]);
    for (const changed of [
      { eventName: 'workflow_dispatch' },
      { ref: 'refs/heads/main' },
      { ref: 'refs/tags/v0.2.0' },
    ]) {
      expect(releaseIdentityProblems({ ...approved, ...changed })).toContain(
        'the workflow was not invoked on the matching GitHub Release tag ref',
      );
    }
  });

  it('rejects a release from a different repository', () => {
    expect(
      releaseIdentityProblems({ ...approved, repository: 'untrusted/mergesutra' }),
    ).toContain('the event repository is not the package repository');
  });

  it('rejects a tag, workflow SHA or main branch pointing elsewhere', () => {
    expect(releaseIdentityProblems({ ...approved, tagCommit: OTHER })).not.toEqual([]);
    expect(releaseIdentityProblems({ ...approved, workflowSha: OTHER })).not.toEqual([]);
    expect(
      releaseIdentityProblems({ ...approved, remoteMainLine: OTHER + '\trefs/heads/main' }),
    ).toContain('the release commit is not the current protected main tip');
  });

  it('refuses malformed, duplicated and missing remote Git answers', () => {
    for (const remoteMainLine of [
      '',
      'fatal: remote unavailable',
      SHA + ' refs/heads/main',
      SHA + '\trefs/heads/feature',
      SHA + '\trefs/heads/main\n' + SHA + '\trefs/heads/main',
      SHA + '\trefs/heads/main\n' + OTHER + '\trefs/heads/other',
    ]) {
      expect(releaseIdentityProblems({ ...approved, remoteMainLine })).toContain(
        'the trusted remote did not return exactly one valid main ref',
      );
    }
  });

  it('rejects a malformed checkout SHA', () => {
    for (const head of ['', 'a'.repeat(39), 'not-a-commit']) {
      expect(releaseIdentityProblems({ ...approved, head })).toContain(
        'the checkout does not name a complete Git commit',
      );
    }
  });
});
