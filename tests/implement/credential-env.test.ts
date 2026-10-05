import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunner } from '../../src/core/runner.js';
import type { Runner } from '../../src/core/runner.js';
import { runImplementStage } from '../../src/implement/implement.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import {
  answerWorkspaceGit,
  checkAction,
  finishAction,
  plantWorkspace,
  plannedRun,
} from '../helpers/implement.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { scriptedClient } from '../helpers/bharatcode.js';

/**
 * A model-authored check that prints its own environment, run for real.
 *
 * This is the shape of the leak the live harness has to be proof against: the
 * credential is a legitimate part of the parent's environment (the BharatCode
 * adapter needs it), a command that prints the environment is a legitimate part
 * of any repository's build, and the output of a check is written into the run
 * record and rendered into the evidence pack that leaves the machine. Refusing
 * `printenv` is the wrong answer, because a repository's own suite may print what
 * it likes; the right answer is that the value is simply not in the environment a
 * run starts.
 *
 * So the fixture is a real Stage 1-to-4 run, a real Stage 6 loop, a real child
 * process, and the real pack renderer — with a sentinel in place of a live key,
 * which is what makes the assertion mean something without costing anybody a
 * request.
 */

const SENTINEL = 'MERGESUTRA-TEST-CREDENTIAL-4f9c1a7b';
const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

async function withLiveCredentials<T>(body: () => Promise<T>): Promise<T> {
  const previousModel = process.env.BHARATCODE_API_KEY;
  const previousGitHub = process.env.GH_TOKEN;
  process.env.BHARATCODE_API_KEY = SENTINEL;
  process.env.GH_TOKEN = SENTINEL;
  try {
    return await body();
  } finally {
    if (previousModel === undefined) delete process.env.BHARATCODE_API_KEY;
    else process.env.BHARATCODE_API_KEY = previousModel;
    if (previousGitHub === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHub;
  }
}

/** Git is simulated (there is no repository here to mutate); a check is a real process. */
function realChecksSimulatedGit(state: {
  root: string;
  workspacePath: string;
  check: Runner;
}): Runner {
  return async (program, args) => {
    if (program !== 'git') return state.check(program, args);
    const answer = answerWorkspaceGit(args, state);
    if (answer.code === 0 && args.slice(2).join(' ').startsWith('worktree add')) {
      await plantWorkspace(state.workspacePath, {
        'dump-env.js':
          "console.log(JSON.stringify({ model: process.env.BHARATCODE_API_KEY ?? 'ABSENT', github: process.env.GH_TOKEN ?? 'ABSENT' }));\n",
      });
    }
    return answer;
  };
}

async function implementWithARealCheck(): Promise<{
  readonly record: Awaited<ReturnType<typeof runImplementStage>>['record'];
  readonly implementation: Awaited<ReturnType<typeof runImplementStage>>['implementation'];
}> {
  const run = await plannedRun(tempDirs);
  const workspacePath = path.join(run.prepared.root, '.mergesutra', 'worktrees', run.record.runId);
  // The same shape the loop builds for itself when nothing is injected: a bounded
  // runner whose working directory is the workspace, so `dump-env.js` resolves the
  // way a repository's own check would.
  const check = createRunner({ cwd: workspacePath, timeoutMs: 20_000 });
  const result = await runImplementStage(
    { runId: run.record.runId, model: 'test-model' },
    {
      store: run.prepared.store,
      now: () => NOW,
      cwd: run.prepared.root,
      client: scriptedClient([
        checkAction(['node', 'dump-env.js'], 'print what this process was given'),
        finishAction('Ran the environment check.', []),
      ]),
      run: realChecksSimulatedGit({ root: run.prepared.root, workspacePath, check }),
    },
  );
  return { record: result.record, implementation: result.implementation };
}

describe('a check that reads its own environment', () => {
  it('runs, and what it saw is the absence of the credential', async () => {
    const { implementation } = await withLiveCredentials(implementWithARealCheck);
    const kept = JSON.stringify(implementation);

    // Non-vacuity: the command really started, really succeeded, and its output
    // really reached the document the run keeps. Without this line the next
    // assertion would be a scan of a pack that never carried anything.
    expect(kept).toContain('"model":"ABSENT"');
    expect(kept).toContain('"github":"ABSENT"');
    expect(kept).not.toContain(SENTINEL);
  });

  it('leaves no credential in the run record or in any file of the evidence pack', async () => {
    const { record, implementation } = await withLiveCredentials(implementWithARealCheck);
    const pack = buildEvidencePack(record);

    expect(JSON.stringify(record)).not.toContain(SENTINEL);
    expect(JSON.stringify(implementation)).not.toContain(SENTINEL);
    // Every byte a reviewer would open, not just the summary row.
    const files = Object.entries(pack.files);
    expect(files.length).toBeGreaterThan(0);
    for (const [name, contents] of files) {
      expect(contents, name).not.toContain(SENTINEL);
    }
    expect(files.map(([name]) => name).sort()).toEqual([
      'commands.jsonl',
      'report.json',
      'report.md',
    ]);
  });
});
