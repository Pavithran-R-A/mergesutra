import { realpathSync } from 'node:fs';
import { AppError, isAppError } from '../core/errors.js';
import { defaultRunner, githubReadRunner, type Runner } from '../core/runner.js';
import { GhCliGitHubSource, type GitHubSource } from '../github/gh-client.js';
import type { CommitRef, IssueDocument, RepositoryIdentity } from '../github/types.js';
import { describeFindings } from '../security/injection-scan.js';
import { defaultRedactor } from '../security/redaction.js';
import { createRunRecord, newRunId, type RunCheck, type RunRecord } from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import {
  identityFromLocalSnapshot,
  inspectLocalRepository,
  originMatches,
  type LocalRepositorySnapshot,
} from './local-repo.js';
import type { IssueRef } from './issue-url.js';
import { ISSUE_URL_EXAMPLE, parseIssueUrl } from './issue-url.js';

/**
 * Intake: turn "here is an issue" into a recorded, provenanced starting point.
 *
 * Two inputs are supported, and they answer different questions. The issue URL
 * says *what should change*; a local clone says *what is actually on this
 * machine right now*. When both are supplied MergeSutra checks that they agree
 * before anything downstream touches either one — because the most expensive
 * failure available to us is generating a confident patch against the wrong
 * repository.
 *
 * Every value in the resulting record carries the command or response it came
 * from. Absent values stay absent: intake reports NOT_AVAILABLE rather than
 * filling a gap with a plausible default.
 */

export interface IntakeOptions {
  readonly issueUrl?: string;
  readonly repoPath?: string;
}

export interface IntakeDeps {
  readonly github?: GitHubSource;
  /** Runner for local repository reads. GitHub-owned reads use githubRun. */
  readonly run?: Runner;
  /** Dedicated runner for MergeSutra-owned `gh api` reads. */
  readonly githubRun?: Runner;
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly random?: () => number;
}

export interface IntakeResult {
  readonly record: RunRecord;
  readonly recordFile: string | null;
  /** Set when the record could not be written; the run still reports truthfully. */
  readonly saveError: string | null;
  readonly checks: readonly RunCheck[];
}

const NEXT_STAGE =
  'INSPECT — `mergesutra inspect <repo>` compiles the repository contract (Stage 2)';

export async function runIntake(
  options: IntakeOptions,
  deps: IntakeDeps = {},
): Promise<IntakeResult> {
  const urlInput = options.issueUrl?.trim() ?? '';
  const repoInput = options.repoPath?.trim() ?? '';
  if (urlInput.length === 0 && repoInput.length === 0) {
    throw new AppError({
      kind: 'validation',
      message: 'Nothing to intake: supply a GitHub issue URL, or --repo pointing at a local clone.',
      remediation: `For example: mergesutra issue ${ISSUE_URL_EXAMPLE}`,
    });
  }

  const run = deps.run ?? defaultRunner;
  // Preserve the old injected-run behavior for tests/embedders that supplied one
  // runner for every subprocess, but production GitHub reads must use the
  // credential-preserving read boundary introduced by S14-9.
  const githubRun = deps.githubRun ?? deps.run ?? githubReadRunner;
  const github = deps.github ?? new GhCliGitHubSource({ run: githubRun });
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(deps.cwd));
  const checks: RunCheck[] = [];
  const limitations: string[] = [];

  let issueRef: IssueRef | undefined;
  let issue: IssueDocument | null = null;
  let repository: RepositoryIdentity | null = null;
  let base: CommitRef | null = null;
  let local: LocalRepositorySnapshot | null = null;

  // 1. Issue URL — pure parsing, never a network call.
  if (urlInput.length > 0) {
    issueRef = parseIssueUrl(urlInput);
    checks.push({ name: 'Issue URL', status: 'PASS', detail: issueRef.canonical });
  } else {
    checks.push({ name: 'Issue URL', status: 'SKIP', detail: 'not supplied' });
    limitations.push(
      'No issue text: an issue URL is required before an Acceptance Contract can be derived.',
    );
  }

  // 2. Local clone, if the user pointed us at one.
  if (repoInput.length > 0) {
    try {
      local = await inspectLocalRepository(repoInput, { run });
      checks.push({
        name: 'Local repository',
        status: 'PASS',
        detail: `${abbreviateHomePath(local.toplevel)} @ ${local.head.shortSha} on ${local.branch}`,
      });
    } catch (error) {
      checks.push({ name: 'Local repository', status: 'FAIL', detail: errorMessage(error) });
      limitations.push('The supplied --repo path could not be read as a Git working tree.');
    }
  } else {
    checks.push({
      name: 'Local repository',
      status: 'SKIP',
      detail: 'no --repo supplied; repository facts will come from GitHub',
    });
  }

  // 3. Issue document from GitHub.
  if (issueRef) {
    try {
      issue = await github.issue({ ...issueRef });
      checks.push({
        name: 'GitHub issue',
        status: 'PASS',
        detail: `#${issue.number} [${issue.state}] ${issue.title}`,
      });
    } catch (error) {
      checks.push({
        name: 'GitHub issue',
        status: failureStatus(error),
        detail: errorMessage(error),
      });
      limitations.push(`Issue text unavailable: ${remediationOf(error) ?? 'see check detail'}`);
    }
  }

  // 4. Repository identity — the hosted answer wins, the clone is the fallback.
  if (issueRef) {
    try {
      repository = await github.repository(issueRef);
      checks.push({
        name: 'Repository',
        status: 'PASS',
        detail: `${repository.fullName} (default branch ${repository.defaultBranch}, via GitHub)`,
      });
      if (repository.isArchived === true) {
        limitations.push('Repository is archived on GitHub; a PR is unlikely to be accepted.');
      }
    } catch (error) {
      repository = local ? identityFromLocalSnapshot(local) : null;
      checks.push(
        repository
          ? {
              name: 'Repository',
              status: 'WARN',
              detail: errorMessage(error) + ' — used local clone',
            }
          : { name: 'Repository', status: 'NOT_AVAILABLE', detail: errorMessage(error) },
      );
      if (repository) {
        limitations.push(
          'Fork/archived/private state was not observed (the GitHub query for it failed).',
        );
      }
    }
  } else if (local) {
    repository = identityFromLocalSnapshot(local);
    checks.push(
      repository
        ? {
            name: 'Repository',
            status: 'PASS',
            detail: `${repository.fullName} (default branch ${repository.defaultBranch}, via local clone)`,
          }
        : {
            name: 'Repository',
            status: 'NOT_AVAILABLE',
            detail: 'local clone has no usable origin remote or resolved default branch',
          },
    );
    limitations.push('Fork/archived/private state was not observed (no GitHub query for it).');
  }

  // 5. Do the two inputs describe the same repository?
  if (issueRef && local) {
    if (originMatches(local, issueRef)) {
      checks.push({
        name: 'Repository match',
        status: 'PASS',
        detail: `clone origin is ${issueRef.owner}/${issueRef.repo}`,
      });
    } else {
      const found = local.origin
        ? `${local.origin.owner}/${local.origin.repo}`
        : '(no origin remote)';
      checks.push({
        name: 'Repository match',
        status: 'FAIL',
        detail: `issue is for ${issueRef.owner}/${issueRef.repo} but ${abbreviateHomePath(local.toplevel)} is ${found}`,
      });
      limitations.push(
        'The supplied --repo is not the issue repository. MergeSutra will not use it as the base.',
      );
      base = null;
    }
  }

  // 6. Exact base commit.
  const localUsable = local !== null && (issueRef === undefined || originMatches(local, issueRef));
  const localOnDefault =
    localUsable &&
    local !== null &&
    repository !== null &&
    !local.isDetachedHead &&
    local.branch === repository.defaultBranch;

  if (localOnDefault && local) {
    base = local.head;
    checks.push({
      name: 'Base commit',
      status: 'PASS',
      detail: `${base.sha} (local HEAD of ${local.branch})`,
    });
  } else if (repository) {
    try {
      base = await github.branchHead({ ...repository, branch: repository.defaultBranch });
      checks.push({
        name: 'Base commit',
        status: 'PASS',
        detail: `${base.sha} (GitHub head of ${repository.defaultBranch})`,
      });
      if (local && !localOnDefault) {
        limitations.push(
          `Local checkout is on '${local.branch}', not '${repository.defaultBranch}'; the remote default-branch commit was used.`,
        );
      }
    } catch (error) {
      checks.push({ name: 'Base commit', status: 'NOT_AVAILABLE', detail: errorMessage(error) });
    }
  } else {
    checks.push({
      name: 'Base commit',
      status: 'NOT_AVAILABLE',
      detail: 'no repository identity established',
    });
  }

  // 7. Working tree state — recorded, never modified.
  if (local) {
    checks.push(
      local.isDirty
        ? {
            name: 'Working tree',
            status: 'WARN',
            detail: `${local.dirtyCount} uncommitted change(s); MergeSutra will not read or overwrite them`,
          }
        : { name: 'Working tree', status: 'PASS', detail: 'clean' },
    );
    if (local.isLinkedWorktree) {
      limitations.push('The supplied --repo is itself a linked worktree.');
    }
  }

  // 8. Trust posture on the text we just imported.
  if (issue) {
    checks.push({
      name: 'Issue content trust',
      status: issue.injectionFindings.length > 0 ? 'WARN' : 'PASS',
      detail:
        describeFindings(issue.injectionFindings) +
        ` (body ${issue.bodyLength} chars, sha256 ${issue.bodySha256.slice(0, 12)})`,
    });
    if (issue.wasTruncated) {
      limitations.push(
        `Issue body truncated to ${issue.body.length} characters; full-text hash recorded.`,
      );
    }
    limitations.push(
      'Issue text is data for the Acceptance Contract, not instructions to MergeSutra.',
    );
  }

  const outcome = decideOutcome({
    hasIssueRef: !!issueRef,
    hasIssue: !!issue,
    hasRepository: !!repository,
    hasBase: !!base,
  });
  const now = deps.now?.() ?? new Date();

  const record = createRunRecord({
    runId: newRunId(now, deps.random),
    createdAt: now.toISOString(),
    stage: 'intake',
    outcome,
    issueRef: issueRef
      ? {
          host: issueRef.host,
          owner: issueRef.owner,
          repo: issueRef.repo,
          number: issueRef.number,
          canonical: issueRef.canonical,
          url: issueRef.url,
        }
      : null,
    issue,
    repository,
    base,
    local,
    contract: null,
    checks,
    nextStage: NEXT_STAGE,
    limitations,
  });

  // The persisted record and the reported record are the same object: a
  // check added after saving would make the file and the terminal disagree.
  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = errorMessage(error);
  }

  return { record, recordFile, saveError, checks };
}

function decideOutcome(state: {
  hasIssueRef: boolean;
  hasIssue: boolean;
  hasRepository: boolean;
  hasBase: boolean;
}): RunRecord['outcome'] {
  if (state.hasIssueRef && !state.hasIssue) return 'BLOCKED';
  if (state.hasRepository && state.hasBase && (!state.hasIssueRef || state.hasIssue)) {
    return state.hasIssue ? 'INTAKE_COMPLETE' : 'INCONCLUSIVE';
  }
  return 'INCONCLUSIVE';
}

/** Transient transport trouble is a WARN; a definite refusal is a FAIL. */
function failureStatus(error: unknown): RunCheck['status'] {
  if (isAppError(error)) {
    if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'rate-limit')
      return 'WARN';
    return 'FAIL';
  }
  return 'FAIL';
}

function errorMessage(error: unknown): string {
  const message = isAppError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
  // Error text often quotes a command's own output, which is where a credential
  // would surface; it goes through the central redactor before the record.
  const safe = defaultRedactor.text(message);
  return safe.length > 220 ? safe.slice(0, 220) + '…' : safe;
}

function remediationOf(error: unknown): string | undefined {
  return isAppError(error) && error.remediation
    ? defaultRedactor.text(error.remediation)
    : undefined;
}

export function abbreviateHomePath(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const canonical = (input: string): string => {
    if (platform !== 'win32' && platform !== 'darwin') return input;
    try {
      // Windows may use 8.3 short names; macOS exposes /var through /private/var.
      // Git and HOME can name the same existing directory differently. Compare
      // their real paths rather than their visible aliases before abbreviating.
      return realpathSync.native(input);
    } catch {
      return input;
    }
  };
  const normalize = (input: string): string => {
    const separators =
      platform === 'win32' ? canonical(input).replaceAll('\\', '/') : canonical(input);
    return separators.length > 1 ? separators.replace(/\/+$/, '') : separators;
  };
  const candidate = normalize(value);
  const comparable = (input: string): string =>
    platform === 'win32' ? input.toLowerCase() : input;

  for (const rawHome of [env['HOME'], env['USERPROFILE']]) {
    if (!rawHome) continue;
    const home = normalize(rawHome);
    if (home.length === 0) continue;

    const candidateKey = comparable(candidate);
    const homeKey = comparable(home);
    if (candidateKey === homeKey) return '~';
    if (candidateKey.startsWith(homeKey + '/')) {
      return '~' + candidate.slice(home.length);
    }
  }

  return value;
}
