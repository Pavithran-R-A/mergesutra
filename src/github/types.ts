import type { InjectionFinding } from '../security/injection-scan.js';

/**
 * Shapes for data that comes from a forge.
 *
 * Everything in here originated outside MergeSutra — GitHub, or a fixture that
 * imitates GitHub — so it is validated on the way in and marked untrusted on
 * the way out. `IssueDocument.untrusted` is not decoration: later stages read
 * `body` only as requirement text, never as authority.
 */

export interface RepositoryContext {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

export interface RepositoryIdentity {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  /**
   * `null` means "not observed", not "false". A local clone can tell us the
   * remote and the base commit; it cannot prove the repository is not archived
   * or private, and MergeSutra does not pretend otherwise.
   */
  readonly isFork: boolean | null;
  readonly isArchived: boolean | null;
  readonly isPrivate: boolean | null;
  readonly htmlUrl: string;
  readonly description: string;
  /** Where this identity came from, for the evidence trail. */
  readonly source: 'github-api' | 'local-git' | 'fixture';
}

export interface IssueDocument {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly body: string;
  readonly bodyLength: number;
  readonly bodySha256: string;
  readonly wasTruncated: boolean;
  readonly labels: readonly string[];
  readonly author: string;
  readonly url: string;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly isPullRequest: boolean;
  readonly untrusted: true;
  readonly injectionFindings: readonly InjectionFinding[];
}

export interface CommitRef {
  readonly sha: string;
  readonly shortSha: string;
  readonly source: 'github-api' | 'local-git';
}

export const MAX_ISSUE_BODY_CHARS = 40_000;
