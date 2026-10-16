import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunResult, Runner } from '../../src/core/runner.js';
import { prepareWorkspace } from '../../src/git/workspace.js';
import {
  describePatch,
  isWorkspaceCheck,
  runWorkspaceCheck,
  WORKSPACE_CHECK,
} from '../../src/verify/patch.js';
import { runVerification, type VerificationRun } from '../../src/verify/engine.js';
import { scopeDigest } from '../../src/verify/consent.js';
import type { PlannedGate } from '../../src/verify/plan.js';
import { hasGit, initRepository } from '../helpers/git.js';
import { builtinGate, planOf, plannedGate } from '../helpers/verification.js';

/**
 * Where MergeSutra's own check of a workspace's patch runs.
 *
 * Stage 7 declares one check of its own — `git diff --check`, for a patch left
 * with conflict markers or trailing whitespace — and until now it dispatched it
 * exactly like a repository's command: into the sandbox, with the workspace as
 * the only thing mounted. `docs/SECURITY_GAP_REGISTER.md` S16-4 measured what
 * that does to a real customer worktree: the pinned image has no `git` at all, so
 * the gate exits 127, and in an image that does have it the worktree's `.git`
 * pointer leads to metadata no mount carries, so it exits 128. Either way the
 * round is judged on a check that never examined anything.
 *
 * The resolution is not to hand the container the repository. A read-only mount
 * of a primary `.git` would expose `remote.<name>.url` — which can carry a token —
 * and a writable one would let the run rewrite the hooks MergeSutra itself obeys.
 * It is to run the check where the patch identity is already measured: on the
 * host, through the Git directory `resolveTrustedGitDir` proves the run could not
 * have authored. Three properties hold that back, and each is tested below:
 *
 * - the command is a constant in this file's module, so no plan document,
 *   repository file or model output can widen it to something else;
 * - it is the *same* `git diff --check` MergeSutra would have asked the container
 *   for, on the same work tree, so the verdict means what the receipt says;
 * - a workspace whose metadata a run could have written is still refused, because
 *   the refusal is what makes the host read safe.
 *
 * A repository's own `git` gate keeps going to the sandbox: `CI_WORKFLOW`
 * provenance is what says "the repository asked for this", and that is a command
 * under review, not a measurement.
 */

const made: string[] = [];
let worktreeCount = 0;
const AVAILABLE = await hasGit();

async function put(dir: string, relative: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, relative), contents, 'utf8');
}

/** The workspace Stage 5 hands a run: a linked worktree of a repository beside it. */
async function makeWorktree(
  files: Record<string, string>,
): Promise<{ workspace: string; repo: string; base: string }> {
  const repo = await initRepository(files);
  made.push(repo.dir);
  worktreeCount += 1;
  const prepared = await prepareWorkspace({
    primaryRoot: repo.dir,
    runId: `run-ws-check-${worktreeCount}`,
    baseSha: repo.base,
  });
  return { workspace: prepared.path, repo: repo.dir, base: repo.base };
}

afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('MergeSutra-owned workspace check', () => {
  it('names one command, spelled once', () => {
    // Everything the host read may ever be: a constant, not a field of a document.
    expect(WORKSPACE_CHECK).toEqual(['git', 'diff', '--check']);
  });

  it('measures the patch of a linked worktree, the way Git does', async () => {
    const { workspace } = await makeWorktree({ 'src/a.ts': 'a\n' });
    await put(workspace, 'src/a.ts', 'a\nexport const b = 1;\n');

    const clean = await runWorkspaceCheck(workspace, { timeoutMs: 30_000 });

    expect(clean.code).toBe(0);
    expect(clean.stdout).toBe('');
  });

  it('reports the conflict marker a customer left behind', async () => {
    const { workspace } = await makeWorktree({ 'src/a.ts': 'a\n' });
    await put(workspace, 'src/a.ts', 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature\n');

    const checked = await runWorkspaceCheck(workspace, { timeoutMs: 30_000 });

    expect(checked.code).not.toBe(0);
    expect(checked.stdout).toMatch(/leftover conflict marker/);
  });

  it('refuses a workspace whose Git metadata the run could have authored', async () => {
    // The S16-2 refusal, for the read this stage adds: a plain checkout keeps its
    // repository inside the directory a run may write in, so the trusted pair does
    // not exist and nothing may be measured — with no fallback to discovery.
    const repo = await initRepository({ 'src/a.ts': 'a\n' });
    made.push(repo.dir);
    await put(repo.dir, 'src/a.ts', 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature\n');

    await expect(runWorkspaceCheck(repo.dir, { timeoutMs: 30_000 })).rejects.toThrow(
      /metadata|trust|measure/i,
    );
  });
});

describe('which gate the host read answers', () => {
  const builtIn = builtinGate({ id: 'VG-001' });

  it('accepts the check MergeSutra declared for itself', () => {
    expect(isWorkspaceCheck(builtIn)).toBe(true);
  });

  it('rejects the same command when the repository asked for it', () => {
    // Provenance is the whole difference: `git diff --check` out of a CI file is a
    // command under review, and a command under review does not get a host read.
    expect(isWorkspaceCheck(plannedGate({ id: 'VG-001', argv: [...WORKSPACE_CHECK] }))).toBe(false);
  });

  it('rejects anything the constant does not name exactly', () => {
    const notThis = [
      [...WORKSPACE_CHECK, '--no-renames'],
      ['git', 'diff'],
      ['git', 'commit', '-m', 'done'],
      ['git', '-c', 'core.fsmonitor=/tmp/hook.sh', 'diff', '--check'],
      ['node', '-e', 'process.exit(0)'],
    ];
    for (const argv of notThis) {
      expect(isWorkspaceCheck(builtinGate({ id: 'VG-001', argv }))).toBe(false);
    }
  });

  it('rejects a document that claims to be MergeSutra without its requirement level', () => {
    expect(
      isWorkspaceCheck(
        builtinGate({ id: 'VG-001', requirementLevel: 'REPOSITORY_REQUIRED' as const }),
      ),
    ).toBe(false);
  });
});

describe.skipIf(!AVAILABLE)(
  'a round over a customer worktree, with a sandbox that cannot run git',
  () => {
    const OK: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false };

    /**
     * The container a real round gets: `S16-4` measured this host's pinned image and
     * it has no `git` in it, so a Git command comes back 127. Everything else runs.
     */
    function containerWithoutGit(started: string[]): Runner {
      return async (file, args) => {
        started.push([file, ...args].join(' '));
        if (file === 'git') {
          return {
            code: 127,
            stdout: '',
            stderr: `exec: "git": executable file not found in $PATH`,
            timedOut: false,
            truncated: false,
          };
        }
        return { ...OK };
      };
    }

    async function round(
      workspace: string,
      baseSha: string,
      started: string[],
      gates: PlannedGate[] = [builtinGate({ id: 'VG-001' }), plannedGate({ id: 'VG-002' })],
    ): Promise<VerificationRun> {
      const patch = await describePatch({ workspace, baseSha });
      const plan = planOf(gates, {
        patchIdentity: patch.identity,
        baseSha: patch.baseSha,
      });
      // The operator named every command in this plan that is not MergeSutra's own
      // check, which is the case where a round is allowed to run anything at all.
      const named = gates
        .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
        .map((gate) => gate.id);
      return runVerification(
        {
          plan,
          workspace,
          consent: {
            planDigest: scopeDigest(plan),
            gateIds: named,
            grantedAt: '2026-10-15T00:00:00.000Z',
          },
        },
        {
          now: () => new Date('2026-10-15T00:00:00.000Z'),
          // Everything except the workspace check goes through here, and what
          // reaches it is a container with no Git in it.
          runFor: () => containerWithoutGit(started),
          currentPatchIdentity: async () => patch.identity,
        },
      );
    }

    it('still measures its own check, and runs nothing of Git inside the sandbox', async () => {
      const { workspace, base } = await makeWorktree({ 'src/a.ts': 'a\n' });
      await put(workspace, 'src/a.ts', 'a\nexport const b = 1;\n');
      const started: string[] = [];

      const run = await round(workspace, base, started);

      expect(started).toEqual(['npm test']);
      const hygiene = run.gates.find((gate) => gate.gateId === 'VG-001');
      expect(hygiene?.receipt.result).toBe('PASS');
      expect(hygiene?.receipt.exitCode).toBe(0);
      expect(hygiene?.receipt.termination).toBe('EXITED');
      expect(run.result).toBe('PASS');
    });

    it('fails the round on a patch the customer left with conflict markers', async () => {
      const { workspace, base } = await makeWorktree({ 'src/a.ts': 'a\n' });
      await put(workspace, 'src/a.ts', 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature\n');

      const run = await round(workspace, base, []);

      expect(run.gates.find((gate) => gate.gateId === 'VG-001')?.receipt.result).toBe('FAIL');
      expect(run.result).toBe('FAIL');
    });

    it('will not lend the host read to a Git step a repository wrote', async () => {
      // The same command text, from the other side of the boundary. On the host this
      // patch is clean and the check passes — so the only reading in which the
      // repository's own step comes back 127 is the true one: it went into the
      // container, where no Git is, exactly as code under review should.
      const { workspace, base } = await makeWorktree({ 'src/a.ts': 'a\n' });
      await put(workspace, 'src/a.ts', 'a\nexport const b = 1;\n');
      const started: string[] = [];

      const run = await round(workspace, base, started, [
        builtinGate({ id: 'VG-001' }),
        plannedGate({ id: 'VG-002', argv: [...WORKSPACE_CHECK] }),
      ]);

      expect(started).toEqual(['git diff --check']);
      expect(run.gates.find((gate) => gate.gateId === 'VG-002')?.receipt).toMatchObject({
        result: 'FAIL',
        exitCode: 127,
        termination: 'EXITED',
      });
      expect(run.gates.find((gate) => gate.gateId === 'VG-001')?.receipt.result).toBe('PASS');
      expect(run.result).toBe('FAIL');
    });
  },
);
