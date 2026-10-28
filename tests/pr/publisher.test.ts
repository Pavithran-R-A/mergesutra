import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '../../src/core/errors.js';
import type { RunResult } from '../../src/core/runner.js';
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
import { createGitHubPublicationRemote } from '../../src/pr/github-publisher.js';
import { candidateInput, OTHER_PATCH_IDENTITY } from '../helpers/publication.js';

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
        return { branch: input.branch, commitSha: 'd'.repeat(40) };
      },
      async createPullRequest(input) {
        calls.push('createPullRequest');
        requests.push(input);
        return { url: 'https://github.com/projectbharat/datekit/pull/1', number: 1, draft: true };
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

  it('hands the pusher the approved bytes and a directory, and nothing that could overwrite history', async () => {
    const candidate = candidateFor();
    const fake = fakeRemote();

    await publish({
      candidate,
      approval: approvePublication({ candidate, approvedAt: '2026-09-25T10:15:00.000Z' }),
      directory: WORKSPACE,
      remote: fake.remote,
    });

    // The transport gets the identity of the patch the human approved, not merely a
    // directory it is trusted to interpret. It re-measures before it sends anything.
    expect(fake.pushes).toEqual([
      {
        directory: WORKSPACE,
        repository: candidate.repository,
        branch: candidate.proposedBranch,
        baseSha: candidate.baseSha,
        patchIdentity: candidate.patchIdentity,
        runId: candidate.runId,
      },
    ]);
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

/**
 * What a refusal says once the repository has already been changed.
 *
 * `publish()` asks for the draft only after `pushBranch` returned, and that return is
 * the read-back agreeing with the request — so by the time the second call can fail,
 * the branch exists. The transport classifies its failures for the case where nothing
 * was written, and its advice is then correct: `gh auth login`, then run the same
 * command. After the branch that advice asks the repository for a second one, so the
 * words are qualified here, at the only place that knows the branch was made. The
 * classification — which kind, which status — is what is known about the refusal and
 * is carried through unchanged.
 */
describe('what a refusal says once the branch exists', () => {
  /**
   * The production transport, answering only the draft request.
   *
   * `pushBranch` is stubbed because the fixture has no Git workspace; it returns what
   * the real one returns after its read-back, which is the whole fact the qualification
   * depends on. Everything from the draft request onward is production code: the
   * scripted `gh` reply goes through the transport's own classifier, so the words
   * asserted below are the words a real refusal carries.
   */
  function draftRefusing(reply: RunResult): PublicationRemote {
    const github = createGitHubPublicationRemote({
      run: async (_file, args) => {
        const endpoint = args.at(-1) ?? '';
        if (!endpoint.endsWith('/pulls')) throw new Error(`unexpected gh call to ${endpoint}`);
        return reply;
      },
    });
    return {
      async pushBranch(input) {
        return { branch: input.branch, commitSha: 'd'.repeat(40) };
      },
      createPullRequest: (input) => github.createPullRequest(input),
    };
  }

  async function refusedAfterBranch(remote: PublicationRemote): Promise<AppError> {
    const candidate = candidateFor();
    const failure = await publish({
      candidate,
      approval: approvePublication({ candidate, approvedAt: '2026-09-25T10:15:00.000Z' }),
      directory: WORKSPACE,
      remote,
    }).catch((error: unknown) => error);
    expect(isAppError(failure)).toBe(true);
    const refusal = failure as AppError;
    // The branch the request named is the branch the run created, not some other name.
    expect(refusal.message).toContain(candidate.proposedBranch);
    expect(refusal.message).toMatch(/created and read back/i);
    expect(refusal.retryable).toBe(false);
    expect(refusal.remediation).toMatch(/do not retry this command/i);
    expect(refusal.remediation).not.toMatch(
      /before retrying|retry only|retry once|try again|then retry|retry the same|retry if/i,
    );
    return refusal;
  }

  function ghFailure(stderr: string): RunResult {
    return { code: 1, stdout: '', stderr, timedOut: false, truncated: false };
  }

  it('keeps an authentication refusal as one, and points at the branch instead of a second send', async () => {
    const refusal = await refusedAfterBranch(
      draftRefusing(
        ghFailure('gh: HTTP 401 Bad credentials — run `gh auth login` to authenticate'),
      ),
    );

    expect(refusal.kind).toBe('auth');
    expect(refusal.status).toBe(401);
  });

  it('keeps a rate limit as one, and does not promise a command will work once it resets', async () => {
    const refusal = await refusedAfterBranch(
      draftRefusing(ghFailure('gh: HTTP 403 API rate limit exceeded for user ID 1')),
    );

    expect(refusal.kind).toBe('rate-limit');
    expect(refusal.status).toBe(403);
  });

  it('refuses to call a server error on the draft request something a retry can settle', async () => {
    const refusal = await refusedAfterBranch(
      draftRefusing(ghFailure('gh: HTTP 502 upstream returned an error page')),
    );

    expect(refusal.kind).toBe('invalid-response');
    expect(refusal.status).toBe(502);
  });

  it('qualifies a draft reply GitHub answered with something that is not a pull request', async () => {
    const refusal = await refusedAfterBranch(
      draftRefusing({
        code: 0,
        stdout: '{"number":7,"draft":true}',
        stderr: '',
        timedOut: false,
        truncated: false,
      }),
    );

    expect(refusal.kind).toBe('invalid-response');
  });

  it('names the request GitHub refused when it already holds a pull request', async () => {
    const shown = candidateFor();
    const refusal = await refusedAfterBranch(
      draftRefusing(
        ghFailure(`gh: HTTP 422 A pull request already exists for ${shown.proposedBranch}:main.`),
      ),
    );

    expect(refusal.kind).toBe('validation');
    expect(refusal.message).toMatch(/pull request already exists/i);
    // The branch write is the step this run succeeded at, so a refusal that blames a
    // branch that could not be created describes a request that was never refused.
    expect(refusal.message).not.toMatch(/refused to create the branch/i);
  });

  it('leaves a refusal of the branch write with the advice the transport gave for it', async () => {
    // Before the branch exists, "run the same command again" is the truest advice
    // available, and this composition must not silence it. The pass-through is what is
    // tested here, so the refusal is the transport's own shape rather than a scripted
    // reply: identity is the assertion.
    const beforeBranch = new AppError({
      kind: 'auth',
      message: 'GitHub refused the request because gh is not authenticated.',
      retryable: false,
      remediation: 'Run `gh auth login`, then retry the same approved command.',
    });
    const candidate = candidateFor();
    const remote: PublicationRemote = {
      async pushBranch() {
        throw beforeBranch;
      },
      createPullRequest: () => {
        throw new Error('a branch refusal must not reach the draft request');
      },
    };

    const failure = await publish({
      candidate,
      approval: approvePublication({ candidate, approvedAt: '2026-09-25T10:15:00.000Z' }),
      directory: WORKSPACE,
      remote,
    }).catch((error: unknown) => error);

    expect(failure).toBe(beforeBranch);
    expect((failure as AppError).remediation).toMatch(/then retry the same approved command/i);
  });
});

describe('what a request cannot carry', () => {
  const push = {
    directory: WORKSPACE,
    repository: 'projectbharat/datekit',
    branch: 'mergesutra/x',
    baseSha: 'a'.repeat(40),
    patchIdentity: 'b'.repeat(64),
    runId: 'run-20260925T000000Z-pack001',
  };

  it('refuses a push that asks to force anything', () => {
    expect(() => parsePushBranchInput({ ...push, force: true })).toThrow(/force/i);
  });

  it('refuses a push that names a refspec rather than a branch', () => {
    expect(() =>
      parsePushBranchInput({
        ...push,
        branch: 'mergesutra/x:refs/heads/main',
      }),
    ).toThrow(/branch/i);
  });

  it('refuses a push with no measured patch identity to send', () => {
    expect(() => parsePushBranchInput({ ...push, patchIdentity: 'the latest changes' })).toThrow(
      /patch identity/i,
    );
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
      .pushBranch({
        directory: WORKSPACE,
        repository: 'projectbharat/datekit',
        branch: 'mergesutra/x',
        baseSha: 'a'.repeat(40),
        patchIdentity: 'b'.repeat(64),
        runId: 'run-20260925T120000Z-abcdef',
      })
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
