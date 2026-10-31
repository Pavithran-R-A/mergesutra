import { AppError } from '../../src/core/errors.js';
import type {
  CreatePullRequestInput,
  PublicationRemote,
  PushBranchInput,
} from '../../src/pr/publisher.js';

/**
 * A publication remote that answers in memory, for suites that need a *recorded*
 * remote fact rather than a transport under test.
 *
 * `tests/pr/stage.test.ts` keeps its own copy because every assertion there is about
 * the stage's side of the boundary; this one exists because the snapshot and status
 * suites need to drive a publish that succeeds or fails after the branch, and neither
 * of them should have to re-invent what a remote returns. The two sizes of the same
 * fake are deliberate: what the real transport sends is asserted field by field in
 * `tests/pr/github-publisher.test.ts`, and what the stage files is asserted in its own
 * suite, so a change in either would fail there first.
 */
export const PUBLISHED_URL = 'https://github.com/projectbharat/datekit/pull/7';
export const PUBLISHED_NUMBER = 7;
export const PUSHED_SHA = 'd'.repeat(40);

export function fakeRemote(options: { pullFails?: boolean } = {}): {
  remote: PublicationRemote;
  pushes: PushBranchInput[];
  pulls: CreatePullRequestInput[];
} {
  const pushes: PushBranchInput[] = [];
  const pulls: CreatePullRequestInput[] = [];
  const remote: PublicationRemote = {
    async pushBranch(input) {
      pushes.push(input);
      return { branch: input.branch, commitSha: PUSHED_SHA };
    },
    async createPullRequest(input) {
      pulls.push(input);
      if (options.pullFails === true) {
        // The shape the real transport produces once a branch write has answered.
        throw new AppError({
          kind: 'invalid-response',
          message: 'scripted pull failure',
          details: { branch: input.head, commitSha: PUSHED_SHA },
        });
      }
      return { url: PUBLISHED_URL, number: PUBLISHED_NUMBER, draft: true };
    },
  };
  return { remote, pushes, pulls };
}
