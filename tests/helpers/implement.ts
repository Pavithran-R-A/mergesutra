import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPlanStage } from '../../src/plan/plan.js';
import { parseImplementationPlan } from '../../src/plan/schema.js';
import {
  runImplementStage,
  type ImplementStageDeps,
  type ImplementStageInput,
  type ImplementStageResult,
} from '../../src/implement/implement.js';
import type { Runner, RunResult } from '../../src/core/runner.js';
import { sha256Hex } from '../../src/security/digest.js';
import type { WritePrecondition } from '../../src/security/writer.js';
import type { AcceptanceContract } from '../../src/contract/schema.js';
import type { ImplementationLoopInput } from '../../src/implement/loop.js';
import { runImplementationLoop, type ImplementationLoopDeps } from '../../src/implement/loop.js';
import type { LoopLimits } from '../../src/implement/limits.js';
import type { ImplementationRecord } from '../../src/implement/state.js';
import type { ImplementationPlan } from '../../src/plan/schema.js';
import type { RunRecord } from '../../src/state/run-record.js';
import { GIT_MAIN_SHA, type MemoryRunStore } from './github.js';
import { planBodyFor, scriptedClient, TEST_MODEL, type ScriptedClient } from './bharatcode.js';
import { cleanUp, contractBackedRun, NOW, type Prepared } from './plan.js';

/**
 * A run that has genuinely reached Stage 6, plus a workspace it can be pointed at.
 *
 * The loop is the first stage that changes anything, so its fixtures cannot be
 * hand-written objects that merely look like earlier stages' output — a typo in
 * one would make a refusal pass for the wrong reason. These runs are built by
 * running Stages 1 to 4 for real, then handing the result to the loop.
 */

export const WORKSPACE_RUN_ID = 'run-20260925t090000z-loop1';

/** A repository tree with the things a loop must not be able to reach for. */
export const WORKSPACE_FILES: Record<string, string> = {
  'src/parse.ts': [
    'export function parseDate(input: string): Date {',
    '  return new Date(input);',
    '}',
    '',
  ].join('\n'),
  'test/parse.test.ts': [
    'import { expect, it } from "vitest";',
    '',
    'it("parses", () => expect(1).toBe(1));',
    '',
  ].join('\n'),
  'README.md': '# datekit\n\n`parseDate("")` returns the epoch.\n',
  '.env': 'BHARATCODE_API_KEY=sk-ws-SECRETVALUE-0000111122223333\n',
  'assets/logo.png': 'PNG\x00\x01\x02\x00\x00binary-bytes\x00\x01',
};

export interface PlannedRun {
  readonly prepared: Prepared;
  readonly record: RunRecord;
  readonly contract: AcceptanceContract;
  readonly plan: ImplementationPlan;
  readonly criteria: readonly string[];
}

/** Stage 1 → 4 with a scripted planner, so the loop has a real plan to follow. */
export async function plannedRun(tempDirs: string[]): Promise<PlannedRun> {
  const prepared = await contractBackedRun(tempDirs);
  const result = await runPlanStage(
    { runId: prepared.record.runId },
    {
      store: prepared.store,
      now: () => NOW,
      random: () => 0.7,
      client: scriptedClient([planBodyFor(prepared.criteria)]),
    },
  );
  const contract = result.record.acceptanceContract;
  if (!result.plan || !contract) {
    throw new Error('fixture run produced no plan');
  }
  return {
    prepared,
    record: result.record,
    contract,
    plan: result.plan,
    criteria: contract.criteria.map((criterion) => criterion.id),
  };
}

export function workspaceTree(overrides: Record<string, string> = {}): Promise<string> {
  const files = { ...WORKSPACE_FILES, ...overrides };
  return writeTree(files);
}

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-workspace-'));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

export interface LoopHarness {
  readonly implementation: ImplementationRecord;
  readonly client: ScriptedClient;
  readonly root: string;
  /** The ids this run's Acceptance Contract actually issued, in order. */
  readonly criteria: readonly string[];
  readonly runner: Runner & { readonly calls: readonly string[][] };
}

/**
 * Run the real loop over a real directory with a scripted model.
 *
 * `answers` are the model's turns, in order; anything that is not a string is
 * JSON-encoded, so a test can hand over an action object. The runner is a spy:
 * an executed command is recorded as argv, and a test can assert both that a
 * program was started and that no shell string ever reached it.
 */
export async function runLoop(
  tempDirs: string[],
  answers: readonly (string | unknown)[],
  options: {
    files?: Record<string, string>;
    /** Plant anything in the workspace before the loop opens its reader and writer. */
    prepare?: (root: string) => Promise<void>;
    /**
     * Reuse a workspace directory instead of getting a fresh one.
     *
     * Two loops over the same directory is what a resume looks like from the
     * outside, and it is the only honest way to ask whether an observation from
     * the first run still means anything in the second.
     */
    root?: string;
    limits?: Partial<LoopLimits>;
    model?: string;
    run?: Runner;
    signal?: AbortSignal;
    clientOptions?: { model?: string };
    input?: Partial<ImplementationLoopInput>;
    deps?: Partial<ImplementationLoopDeps>;
  } = {},
): Promise<LoopHarness> {
  const root = options.root ?? (await workspaceTree(options.files));
  if (options.root === undefined) tempDirs.push(root);
  if (options.prepare) await options.prepare(root);
  const { record, contract, plan, criteria } = await plannedRun(tempDirs);
  const client = scriptedClient(answers, options.clientOptions);
  const runner = recordingRunner(options.run);

  const implementation = await runImplementationLoop(
    {
      runId: WORKSPACE_RUN_ID,
      record,
      contract,
      plan,
      workspaceRoot: root,
      workspace: {
        relativePath: `.mergesutra/worktrees/${WORKSPACE_RUN_ID}`,
        branch: `mergesutra/${WORKSPACE_RUN_ID}`,
        baseSha: record.base?.sha ?? 'f'.repeat(40),
        reused: false,
        primaryDirty: false,
      },
      limits: options.limits,
      model: options.model,
      ...options.input,
    },
    { client, run: runner, now: () => NOW, signal: options.signal, ...options.deps },
  );

  return { implementation, client, root, criteria, runner };
}

/** One action, formatted the way a model would have to send it. */
export function action(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export function finishAction(
  summary = 'Guard clause added and the tests cover it.',
  criteriaBelievedComplete: readonly string[] = [],
): Record<string, unknown> {
  return { action: 'FINISH', summary, criteriaBelievedComplete: [...criteriaBelievedComplete] };
}

export function readAction(
  p: string,
  reason = 'see the current behaviour',
): Record<string, unknown> {
  return { action: 'READ_FILE', path: p, reason };
}

export function writeAction(
  p: string,
  content: string,
  criterionIds: readonly string[] = [],
  /**
   * Which version this write replaces. Required by the protocol since Stage 7: a
   * write that does not say what it overwrites does not parse.
   */
  replaces: WritePrecondition = { expectedAbsent: true },
): Record<string, unknown> {
  return {
    action: 'WRITE_FILE',
    path: p,
    content,
    replaces,
    criterionIds,
    reason: 'add the guard',
  };
}

/** A write that claims the path is still empty. */
export const EXPECT_ABSENT: WritePrecondition = { expectedAbsent: true };

/** The precondition for the exact bytes `text`, i.e. the version it was read as. */
export function digestOf(text: string): WritePrecondition {
  return { expectedSha256: sha256Hex(text) };
}

/** The precondition for whatever this fixture workspace currently holds at `p`. */
export function digestOfWorkspaceFile(p: string): { readonly expectedSha256: string } {
  const text = WORKSPACE_FILES[p];
  if (text === undefined) throw new Error(`the fixture workspace has no file named ${p}`);
  return { expectedSha256: sha256Hex(text) };
}

export function checkAction(
  argv: readonly string[],
  reason = 'run the suite',
): Record<string, unknown> {
  return { action: 'RUN_CHECK', argv: [...argv], reason };
}

function recordingRunner(custom?: Runner): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (program, args) => {
    calls.push([program, ...args]);
    if (custom) return custom(program, args);
    return { code: 0, stdout: '', stderr: '' } satisfies RunResult;
  };
  return Object.assign(runner, { calls });
}

/**
 * A plan whose change list names exactly these files.
 *
 * The context assembler chooses what to read from the plan, so its tests need a
 * plan with a controlled file list and nothing else about it matters.
 */
export function planTouching(files: readonly string[]): ImplementationPlan {
  return parseImplementationPlan({
    schemaVersion: 1,
    runId: 'run-fixture-plan',
    body: {
      ...planBodyFor(['AC-1']),
      changes: files.map((file) => ({
        file,
        action: 'modify',
        reason: 'reject empty input here',
        criterionIds: ['AC-1'],
      })),
    },
    provenance: {
      model: TEST_MODEL,
      source: 'bharatcode',
      requestedAt: NOW.toISOString(),
      contractRunId: 'run-fixture-plan',
      contractVersion: 1,
      attempts: 1,
      promptTokens: null,
      completionTokens: null,
    },
    limitations: [],
  });
}

/**
 * A Stage 6 run against a repository that is not really Git.
 *
 * The stage's own suite and the command's suite both need the same thing: a real
 * Stage 1-4 record, and a git that answers the workspace questions without
 * touching this machine's Git. Keeping it here means the simulation of `git
 * worktree add` is written once, and a test cannot pass by disagreeing with
 * itself about what Git would have said.
 *
 * The two stateful answers mirror what real Git does — `worktree add` fills the
 * directory, and a directory that exists is one `worktree list` reports — so a
 * stage cannot reach a workspace by skipping the step that creates it. A git
 * command outside the workspace set fails the run rather than being answered
 * generously: "this stage only ever asked for these few things" is a claim under
 * test, not a convenience.
 */
export interface StageHarnessOptions {
  /** Extra files the created workspace should contain. */
  readonly files?: Record<string, string>;
  /** Report the human's checkout as dirty, which the stage must carry as a fact. */
  readonly dirtyPrimary?: boolean;
  /** Override one git answer, e.g. to make `check-ignore` say the directory is not ignored. */
  readonly refuseGit?: (argv: readonly string[]) => RunResult | null;
}

export interface StageHarness {
  readonly store: MemoryRunStore;
  readonly runId: string;
  readonly root: string;
  readonly workspacePath: string;
  readonly record: RunRecord;
  readonly criteria: readonly string[];
  readonly client: ScriptedClient;
  /** Every process invocation the stage made: workspace Git and model checks alike. */
  readonly calls: readonly string[][];
  /** The injections a CLI-level test hands to `run()` as `implement`. */
  readonly deps: ImplementStageDeps;
  readonly implement: (
    input?: ImplementStageInput,
    deps?: ImplementStageDeps,
  ) => Promise<ImplementStageResult>;
}

export function answerWorkspaceGit(
  argv: readonly string[],
  state: { readonly root: string; readonly workspacePath: string },
): RunResult {
  const sub = argv.slice(2).join(' ');
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
  const no = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });
  if (sub.startsWith('rev-parse --show-toplevel')) return ok(`${state.root}\n`);
  if (sub.startsWith('cat-file -t')) return ok('commit\n');
  if (sub.startsWith('check-ignore')) return ok('');
  if (sub.startsWith('status --porcelain')) return ok('');
  if (sub.startsWith('worktree list')) {
    return ok(existsSync(state.workspacePath) ? `worktree ${state.workspacePath}\n` : '');
  }
  if (sub.startsWith('rev-parse --verify refs/heads/')) return no('fatal: not a valid object name');
  if (sub.startsWith('rev-parse --verify HEAD')) return ok(`${GIT_MAIN_SHA}\n`);
  if (sub.startsWith('worktree add')) return ok('Preparing worktree (new branch)\n');
  return no(`unexpected git invocation: ${sub}`);
}

/**
 * The git command a recorded call actually asked for.
 *
 * `prepareWorkspace` prefixes every invocation with `-C <directory>`, while a
 * model-authored check arrives as the bare argv it named — so the verb is at a
 * different index depending on who asked, and reading it from a fixed position
 * would silently sort refusals into paths.
 */
export function gitCommand(argv: readonly string[]): string {
  const afterProgram = argv[0] === 'git' ? argv.slice(1) : argv;
  const afterCwd = afterProgram[0] === '-C' ? afterProgram.slice(2) : afterProgram;
  return afterCwd.join(' ');
}

export async function plantWorkspace(
  dir: string,
  files: Record<string, string> = {},
): Promise<void> {
  for (const [relative, contents] of Object.entries({ ...WORKSPACE_FILES, ...files })) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}

export async function implementHarness(
  tempDirs: string[],
  answers: readonly (string | unknown)[],
  options: StageHarnessOptions = {},
): Promise<StageHarness> {
  const run = await plannedRun(tempDirs);
  const root = run.prepared.root;
  const runId = run.record.runId;
  const workspacePath = path.join(root, '.mergesutra', 'worktrees', runId);

  const calls: string[][] = [];
  const stageRunner: Runner = async (program, args) => {
    calls.push([program, ...args]);
    if (program !== 'git') return { code: 0, stdout: '', stderr: '' };
    if (options.dirtyPrimary && args.slice(2).join(' ').startsWith('status --porcelain')) {
      return { code: 0, stdout: ' M src/parse.ts\n?? notes.md\n', stderr: '' };
    }
    const override = options.refuseGit?.(args);
    if (override) return override;
    const answer = answerWorkspaceGit(args, { root, workspacePath });
    // The one answer that creates something: the worktree appears with its files.
    if (answer.code === 0 && args.slice(2).join(' ').startsWith('worktree add')) {
      await plantWorkspace(workspacePath, options.files);
    }
    return answer;
  };

  const client = scriptedClient(answers);
  const deps: ImplementStageDeps = {
    store: run.prepared.store,
    client,
    run: stageRunner,
    now: () => NOW,
    cwd: root,
  };

  return {
    store: run.prepared.store,
    runId,
    root,
    workspacePath,
    record: run.record,
    criteria: run.criteria,
    client,
    calls,
    deps,
    implement: (input: ImplementStageInput = {}, extra: ImplementStageDeps = {}) =>
      runImplementStage({ runId, ...input }, { ...deps, ...extra }),
  };
}

export { cleanUp, NOW };
