import { describe, expect, it } from 'vitest';
import { isolatedGitEnvironment, releaseIdentityProblems } from '../../scripts/lib/release-identity.mjs';

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
    const result = releaseIdentityProblems({ ...approved, repository: 'untrusted/mergesutra' });
    expect(result).toContain('the event repository is not the package repository');
  });

  it('rejects a tag, workflow SHA or main branch pointing elsewhere', () => {
    expect(releaseIdentityProblems({ ...approved, tagCommit: OTHER })).not.toEqual([]);
    expect(releaseIdentityProblems({ ...approved, workflowSha: OTHER })).not.toEqual([]);
    const result = releaseIdentityProblems({
      ...approved,
      remoteMainLine: OTHER + '\trefs/heads/main',
    });
    expect(result).toContain('the release commit is not the current remote main tip');
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

describe('release Git lookup isolates hostile runtime configuration', () => {
  it('does not inherit global Git config, Git URL rewrites or network proxies', () => {
    const bad = {
      PATH: '/trusted/git',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://attacker.example/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_PARAMETERS: 'attacker-controlled',
      GIT_CONFIG_GLOBAL: '/home/user/.gitconfig',
      GIT_CONFIG_SYSTEM: '/etc/gitconfig',
      GIT_DIR: '/other/repository',
      GIT_WORK_TREE: '/other/worktree',
      GIT_SSL_NO_VERIFY: '1',
      GIT_SSH_COMMAND: 'hostile-helper',
      GIT_ASKPASS: '/home/user/secret-helper',
      HTTPS_PROXY: 'http://attacker.example:8080',
      HTTP_PROXY: 'http://attacker.example:8080',
      HOME: '/home/user',
      XDG_CONFIG_HOME: '/home/user/.config',
      NODE_OPTIONS: '--require /tmp/hijack.cjs',
    };
    const env = isolatedGitEnvironment(bad, '/trusted/empty');
    expect(env.PATH).toBe('/trusted/git');
    expect(env.GIT_CONFIG_COUNT).toBe('0');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/trusted/empty/config');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/trusted/empty/config');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.HOME).toBe('/trusted/empty');
    expect(env.TMP).toBe('/trusted/empty');
    for (const name of [
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_PARAMETERS',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_SSL_NO_VERIFY',
      'GIT_SSH_COMMAND',
      'GIT_ASKPASS',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_OPTIONS',
    ]) {
      expect(env[name]).toBeUndefined();
    }
  });
});
