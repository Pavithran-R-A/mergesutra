import { describe, expect, it } from 'vitest';
import {
  parseCreatePullRequestInput,
  parsePushBranchInput,
  publish,
  unavailableRemote,
  type CreatePullRequestInput,
  type PublicationRemote,
  type PushBranchInput,
} from '../../src/pr/publisher.js';
import { approvePublication } from '../../src/pr/approval.js';
import { candidateOf, type PublicationCandidate } from '../../src/pr/candidate.js';
import { candidateInput, OTHER_PATCH_IDENTITY } from '../helpers/publication.js';
import { isAppError } from '../../src/core/errors.js';

/**
 * The boundary itself — Stage 10's last line of defence.
 *
 * Everything above this module is words: a page, a digest, a yes. This is where a
 * product would normally start building hands, and the whole claim of the stage is
 * that it does not. So the tests here are of two kinds — what the fake transport
 * proves the seam *can* do, and what the production transport proves it *cannot*.
 */

const WORKSPACE = 'worktrees/run-20260925T000000Z-pack001';

function candidateFor(overrides = {}): PublicationCandidate {
  return candidateOf(candidateInput(overrides));
}

/** The seam, exercised: it records what it was handed and returns canned facts. */
function fakeRemote(): {
  remote: PublicationRemote;
  calls: string[];
  pushes: PushBranchInput[];
  requests: CreatePullRequestInput[];
} {
  const calls: string[] = [];
  const pushes: PushBranchInput[] = [];
  const requests: CreatePullRequestInput[] = [];
  return {
    calls,
    pushes,
    requests,
    remote: {
      async pushBranch(input) {
        calls.push('pushBranch');
        pushes.push(input);
        return { branch: input.branch };
      },
      async createPullRequest(input) {
        calls.push('createPullRequest');
        requests.push(input);
        return { url: 'https://github.com/projectbharat/datekit/pull/1' };
      },
    },
  };
}

describe('the seam a publication would go through', () => {
  it('pushes the branch and opens the pull request, in that order and no further', async () => {
    const candidate = candidateFor();
    const fake = fakeRemote();

    await publish({
      candidate,
      approval: approvePublication({ candidate, approvedAt: '2026-09-25T10:15:00.000Z' }),
      directory: WORKSPACE,
      remote: fake.remote,
    });

    expect(fake.calls).toEqual(['pushBranch', 'createPullRequest']);
  });

  it('opens the pull request from the approved page, field for field', async () => {
    const candidate = candidateFor();
    const fake = fakeRemote();

    await publish({
      candidate,
      approval: approvePublication({ candidate, approvedAt: '2026-09-25T10:15:00.000Z' }),
      directory: WORKSPACE,
      remote: fake.remote,
    });

    expect(fake.requests).toEqual([
      {
        repository: candidate.repository,
        title: candidate.prTitle,
        body: candidate.prBody,
        head: candidate.proposedBranch,
        base: candidate.targetBranch,
      },
    ]);
  });

  it('hands the pusher a branch and a directory, and nothing that could overwrite history', async () => {
    const candidate = candidateFor();
    const fake = fakeRemote();

    await publish({
      candidate,
      approval: approvePublication({ candidate, approvedAt: '2026-09-25T10:15:00.000Z' }),
      directory: WORKSPACE,
      remote: fake.remote,
    });

    expect(fake.pushes).toEqual([{ directory: WORKSPACE, branch: candidate.proposedBranch }]);
  });

  it('touches nothing when no human has approved', async () => {
    const candidate = candidateFor();
    const fake = fakeRemote();

    await expect(
      publish({ candidate, approval: null, directory: WORKSPACE, remote: fake.remote }),
    ).rejects.toThrow(/approv/i);
    expect(fake.calls).toEqual([]);
  });

  it('touches nothing when the approval is for a page that has since changed', async () => {
    const shown = candidateFor();
    const approval = approvePublication({
      candidate: shown,
      approvedAt: '2026-09-25T10:15:00.000Z',
    });
    const moved = candidateFor({ patchIdentity: OTHER_PATCH_IDENTITY });
    const fake = fakeRemote();

    await expect(
      publish({ candidate: moved, approval, directory: WORKSPACE, remote: fake.remote }),
    ).rejects.toThrow(/digest|different/i);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an approval written for another run before it reaches the transport', async () => {
    const shown = candidateFor();
    const approval = approvePublication({
      candidate: shown,
      approvedAt: '2026-09-25T10:15:00.000Z',
    });
    const elsewhere = candidateFor({ runId: 'run-20261001T000000Z-pack002' });
    const fake = fakeRemote();

    await expect(
      publish({ candidate: elsewhere, approval, directory: WORKSPACE, remote: fake.remote }),
    ).rejects.toThrow(/other run/i);
    expect(fake.calls).toEqual([]);
  });
});

describe('what a request cannot carry', () => {
  it('refuses a push that asks to force anything', () => {
    expect(() =>
      parsePushBranchInput({ directory: WORKSPACE, branch: 'mergesutra/x', force: true }),
    ).toThrow(/force/i);
  });

  it('refuses a push that names a refspec rather than a branch', () => {
    expect(() =>
      parsePushBranchInput({
        directory: WORKSPACE,
        branch: 'mergesutra/x:refs/heads/main',
      }),
    ).toThrow(/branch/i);
  });

  it('refuses a pull request that also asks to merge, to review or to assign', () => {
    const base = {
      repository: 'projectbharat/datekit',
      title: 'Parser accepts invalid empty dates',
      body: '## Summary',
      head: 'mergesutra/x',
      base: 'main',
    };

    for (const extra of [
      { merge: true },
      { autoMerge: true },
      { reviewers: ['someone'] },
      { assignees: ['someone'] },
      { draft: false },
      { deleteBranch: true },
      { endpoint: '/repos/x/y/pulls' },
    ]) {
      expect(() => parseCreatePullRequestInput({ ...base, ...extra })).toThrow(
        /merge|reviewer|assignee|draft|delete|endpoint|repository|shape|strict/i,
      );
    }
  });
});

describe('the remote production actually has', () => {
  it('is exactly the two narrow methods, with no generic door beside them', () => {
    const remote = unavailableRemote();

    expect(Object.keys(remote).sort()).toEqual(['createPullRequest', 'pushBranch']);
    const loose = remote as unknown as Record<string, unknown>;
    for (const door of ['request', 'endpoint', 'command', 'execute', 'run', 'graphql']) {
      expect(loose[door]).toBeUndefined();
    }
  });

  it('refuses to push, and says no remote is configured rather than pretending it did', async () => {
    const failure = await unavailableRemote()
      .pushBranch({ directory: WORKSPACE, branch: 'mergesutra/x' })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(isAppError(failure)).toBe(true);
    expect(failure).toMatchObject({ kind: 'not-implemented' });
    expect((failure as Error).message).toMatch(/no remote|not configured|disabled/i);
  });

  it('refuses to open a pull request, and reports no page rather than a plausible one', async () => {
    const failure = await unavailableRemote()
      .createPullRequest({
        repository: 'projectbharat/datekit',
        title: 'Parser accepts invalid empty dates',
        body: '## Summary',
        head: 'mergesutra/x',
        base: 'main',
      })
      .then((result) => result)
      .catch((error: unknown) => error);

    expect(isAppError(failure)).toBe(true);
    expect((failure as Error).message).toMatch(/no remote|not configured|disabled/i);
  });

  it('publishing over the production remote fails before the human is told anything happened', async () => {
    const candidate = candidateFor();
    const approval = approvePublication({
      candidate,
      approvedAt: '2026-09-25T10:15:00.000Z',
    });

    await expect(
      publish({
        candidate,
        approval,
        directory: WORKSPACE,
        remote: unavailableRemote(),
      }),
    ).rejects.toThrow(/no remote|not configured|disabled/i);
  });
});
