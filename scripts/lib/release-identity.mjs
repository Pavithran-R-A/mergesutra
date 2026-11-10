/**
 * A GitHub Release tag is not itself an authorization to publish arbitrary
 * source. A real release must be the matching tag at the current verified
 * main tip. Unreadable Git facts are never treated as success.
 */
const SHA = /^[0-9a-f]{40}$/;

/**
 * Build a closed environment for read-only release Git lookups.
 * Git supports URL rewrites via global/system configuration and GIT_CONFIG_COUNT;
 * none of those values may redirect our trusted GitHub main reference query.
 * The caller provides a newly created empty directory, not the source checkout.
 */
export function isolatedGitEnvironment(sourceEnv, emptyDirectory) {
  const env = {
    HOME: emptyDirectory,
    USERPROFILE: emptyDirectory,
    XDG_CONFIG_HOME: emptyDirectory,
    TMP: emptyDirectory,
    TEMP: emptyDirectory,
    TMPDIR: emptyDirectory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyDirectory + '/config',
    GIT_CONFIG_SYSTEM: emptyDirectory + '/config',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
  const pathValue = sourceEnv.PATH ?? sourceEnv.Path;
  if (pathValue !== undefined) env.PATH = pathValue;
  for (const name of ['PATHEXT', 'SystemRoot', 'WINDIR']) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
  }
  return env;
}

export function releaseIdentityProblems(input) {
  const problems = [];
  const expectedTag = 'v' + input.version;
  if (input.releaseTag !== expectedTag) {
    problems.push('the GitHub Release tag does not match the package version');
  }
  if (input.eventName !== 'release' || input.ref !== 'refs/tags/' + expectedTag) {
    problems.push('the workflow was not invoked on the matching GitHub Release tag ref');
  }
  if (input.repository !== input.expectedRepository) {
    problems.push('the event repository is not the package repository');
  }
  if (typeof input.head !== 'string' || !SHA.test(input.head)) {
    problems.push('the checkout does not name a complete Git commit');
  }
  if (input.workflowSha !== input.head) {
    problems.push('the checkout commit differs from the release event commit');
  }
  if (input.tagCommit !== input.head) {
    problems.push('the release tag does not resolve to the checked-out commit');
  }
  const remote = typeof input.remoteMainLine === 'string' ? input.remoteMainLine.trim() : '';
  const match = /^([0-9a-f]{40})\trefs\/heads\/main$/.exec(remote);
  if (!match) {
    problems.push('the trusted remote did not return exactly one valid main ref');
  } else if (match[1] !== input.head) {
    problems.push('the release commit is not the current remote main tip');
  }
  return problems;
}
