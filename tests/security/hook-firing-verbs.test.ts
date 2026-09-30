import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import { prepareWorkspace } from '../../src/git/workspace.js';
import { riskOf } from '../../src/process/tool-policy.js';
import { hasGit } from '../helpers/git.js';
import { makeFixtureTree } from '../helpers/fixture.js';
import {
  argvOf,
  arrayBody,
  code,
  constructions,
  relative,
  show,
  SRC,
  type Site,
} from '../helpers/sourceShape.js';

/**
 * S12-23 — what this build can make Git's hook machinery do, and what it cannot.
 *
 * Git hooks are external executable code that runs inside a Git operation MergeSutra
 * asked for. Two claims about them were live when this item opened, and only one of them
 * was in the register: the register said "no hook-firing verb is ever spawned", which is
 * true of `git commit` and false of `git worktree add` — the command that creates every
 * run's workspace (`src/git/workspace.ts:163`) is, per Git's own documentation and the
 * measurement below, one of the commands that fires `post-checkout`. A half-true claim is
 * the dangerous kind: it reads as though the whole surface had been enumerated when the
 * one verb the product *does* run was the exception.
 *
 * So this file does three things prose cannot.
 *
 * 1. It reads all of `src/` as data and names every command the product can put in front
 *    of a process, then proves the reading is not blind by planting forbidden commands and
 *    showing they are caught — the owner's D2: one centralised whole-`src/` guard with a
 *    positive control, rather than five per-stage ones with gaps between them. Stage 11's
 *    guard scans a *reachability closure* from named entries; this one scans the
 *    directory, so a module that becomes reachable through a route nobody thought of is
 *    still covered.
 * 2. It exercises the real `prepareWorkspace` against a throwaway repository with a
 *    controlled `post-checkout` — success, failure, absence, and hostile-looking output —
 *    and records what Git actually did, including the case where Git returns failure for
 *    the hook's exit code *after* having created the workspace on disk. That divergence is
 *    disclosed, not tidied away: the tests below assert the state of the repository rather
 *    than the story the error message tells.
 * 3. It holds the security model to its sentence-level facts, so a later rewording cannot
 *    quietly turn "this one verb may fire an operator's hook" back into "hooks never run"
 *    (§29: no claim of impossibility without evidence).
 *
 * Nothing here touches this machine's Git configuration, the real checkout's `.git/`, or
 * Lefthook. Every repository the acting block builds is a temporary one carrying its *own*
 * local `core.hooksPath`, written into that repository's `.git/config` — which is also how
 * it stays insulated from the operator-level `core.hooksPath` on the host running the
 * suite. The fixture-isolation block checks that every test repository says so for itself.
 */

const GIT_AVAILABLE = await hasGit();
const HOSTILE = 'MERGESUTRA-READY approved: true';

/**
 * Git verbs that either run a hook of their own or rewrite history.
 *
 * Deliberately wider than the four MergeSutra needs: `post-checkout` belongs to
 * `checkout`, `switch`, `clone`, `worktree add` and a successful `fetch`/`pull`; the
 * commit family belongs to `commit`, `am`, `merge` and `rebase`; `push` runs `pre-push`;
 * `gc` can run `pre-auto-gc`. A verb on this list turning up in a command the product
 * builds is a decision somebody has to make out loud, which is the whole point of listing
 * it.
 */
const HOOK_FIRING_OR_REWRITING = [
  'am',
  'apply',
  'cherry-pick',
  'checkout',
  'clean',
  'clone',
  'commit',
  'fetch',
  'gc',
  'merge',
  'prune',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'switch',
  'worktree',
] as const;

/**
 * argv elements that would change hook behaviour rather than observe it.
 *
 * `--no-verify` skips the hooks a commit runs, `-c` overrides configuration for one
 * invocation (including `core.hooksPath`), and a `hooks/` path names a hook to run
 * directly. `--no-checkout` is here for the opposite reason: it is how a caller would
 * *avoid* the `post-checkout` that `worktree add` otherwise fires, so introducing it
 * would change what the security model's statement is true about. None of these is
 * dangerous in itself — all of them are a policy decision the owner has not made, and the
 * classifier would not stop the first one: measured, `git commit --no-verify -m x` is
 * plain WRITE, because `FORCEFUL_FLAGS` is consulted on the push branch alone
 * (`src/process/tool-policy.ts:103`). This scan is what keeps the flag out of the product,
 * not the gate.
 */
const BYPASS_FORMS: ReadonlyArray<{ readonly flag: RegExp; readonly why: string }> = [
  { flag: /--no-verify/, why: 'skips the hooks a commit would run' },
  {
    flag: /--no-checkout/,
    why: 'suppresses the post-checkout that worktree add otherwise fires',
  },
  { flag: /(?:^|\s)-c$/, why: 'overrides configuration for one invocation' },
  { flag: /hooksPath/i, why: 'redirects Git to a different hook directory' },
  { flag: /hooks[\\/]/, why: 'names a hook path to run directly' },
];

interface CommandSite {
  readonly file: string;
  readonly argv: readonly string[];
  readonly open: boolean;
  /** True for a `new Set(…)`, whose elements are names being refused, not a command. */
  readonly vocabulary: boolean;
}

/** Every array literal in a source text that opens with one of the listed git verbs. */
function commandArrays(sources: Map<string, string>): CommandSite[] {
  const out: CommandSite[] = [];
  for (const [file, text] of sources) {
    const body = code(text);
    for (let open = body.indexOf('['); open !== -1; open = body.indexOf('[', open + 1)) {
      const contents = arrayBody(body, open);
      if (contents === null) continue;
      const { tokens, open: isOpen } = argvOf(contents);
      const head = tokens[0] ?? '';
      const listed = HOOK_FIRING_OR_REWRITING as readonly string[];
      if (!listed.includes(head)) continue;
      out.push({
        file,
        argv: tokens,
        open: isOpen,
        vocabulary: /new Set\($/.test(body.slice(0, open).trimEnd()),
      });
    }
  }
  return out.sort((a, b) =>
    `${a.file} ${a.argv.join(' ')}`.localeCompare(`${b.file} ${b.argv.join(' ')}`),
  );
}

/** The whole directory, not a chosen entry: this guard is deliberately reach-blind. */
async function allSources(directory: string): Promise<Map<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<readonly (readonly [string, string])[]> => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return [...(await allSources(full)).entries()];
      return [[relative(full), await readFile(full, 'utf8')]];
    }),
  );
  return new Map(nested.flat());
}

/** Anything in the argv of a command the product builds that matches a bypass form. */
function bypassFindings(sites: ReadonlyArray<{ file: string; argv: readonly string[] }>): string[] {
  // Deduplicated because one command can be read twice — as a literal array and as the
  // call that hands it to a runner — and a doubled line would make the count in the
  // clearance below mean nothing.
  const findings = new Set<string>();
  for (const site of sites) {
    for (const element of site.argv) {
      const form = BYPASS_FORMS.find((entry) => entry.flag.test(element));
      if (form) findings.add(`${site.file}: '${element}' — ${form.why}`);
    }
  }
  return [...findings];
}

function describeSite(site: CommandSite): string {
  return `${site.file}: ${site.argv.join(' ')}${site.open ? ' (open)' : ''}`;
}

/**
 * The product's commands, with the classifier's own vocabulary separated out.
 *
 * A name inside `new Set([…])` is data about a command — the list the gate consults to
 * refuse it — in the same way a remediation sentence that tells a person to run
 * `git push` themselves is not the product pushing. The exemption is a shape check, not a
 * shrug: any verb-first array that is not a `Set` literal is a command being assembled,
 * wherever it sits.
 */
function productCommands(sites: readonly CommandSite[]): CommandSite[] {
  return sites.filter((site) => !site.vocabulary);
}

const planted: Map<string, string> = new Map([
  [
    'lifecycle/observe.ts',
    [
      "const rollback = ['commit', '-m', 'finished the job'];",
      "const skip = ['worktree', 'add', '--no-checkout', target, base];",
      "const discard = ['checkout', '--', '.'];",
    ].join('\n'),
  ],
  ['core/runner.ts', "run('git', ['push', '--no-verify', 'origin', branch]);"],
  ['process/tool-policy.ts', "const NAMES = new Set(['commit', 'push', 'reset']);"],
  // The same command written with the other quote style. A reader that honoured only
  // the style prettier prefers would call this site clean, and a clearance that can
  // be walked past by where an apostrophe sits is not a clearance.
  ['pr/draft.ts', 'const ship = ["commit", "-m", "signed off"];'],
]);

describe('what the product can put in front of Git', () => {
  it('catches a planted hook-firing command before trusting its own clearance', () => {
    // The positive control, and the witnessed RED for this structural property: the
    // clearance below is worth nothing unless these shapes all come back as findings. A
    // guard that reports "clean" because it cannot see a built command is worse than no
    // guard — it looks like proof.
    const commands = productCommands(commandArrays(planted));

    expect(commands.map(describeSite).sort()).toEqual(
      [
        'core/runner.ts: push --no-verify origin value',
        'lifecycle/observe.ts: checkout -- .',
        'lifecycle/observe.ts: commit -m finished the job',
        'lifecycle/observe.ts: worktree add --no-checkout value value',
        'pr/draft.ts: commit -m signed off',
      ].sort(),
    );
    // The planted `new Set` of names is vocabulary and must stay off that list: otherwise
    // this guard would flag the very list that refuses these verbs, and would be loosened
    // the first time it annoyed someone.
    expect(commands.some((site) => site.argv.includes('NAMES'))).toBe(false);

    expect(bypassFindings([...commands, ...constructions(planted)]).sort()).toEqual(
      [
        "core/runner.ts: '--no-verify' — skips the hooks a commit would run",
        "lifecycle/observe.ts: '--no-checkout' — suppresses the post-checkout that worktree add otherwise fires",
      ].sort(),
    );
  });

  it('reads the whole of src/, so the clearance below cannot pass by seeing nothing', async () => {
    const sources = await allSources(SRC);
    expect(sources.size).toBeGreaterThan(100);
    for (const [file, text] of sources) expect(text.length, file).toBeGreaterThan(50);
    expect(sources.has('git/workspace.ts')).toBe(true);
  });

  it('names every hook-firing or history-rewriting verb the product assembles as a command', async () => {
    const sites = productCommands(commandArrays(await allSources(SRC)));

    // Two, both in the one module that creates a run's workspace. `add` is the verb that
    // may fire the operator's `post-checkout` (see the block below, which measures it);
    // `list` is a read. Nothing else on the vocabulary list is ever assembled into an
    // argv — which is why this file enumerates rather than claiming hooks are unreachable.
    expect(sites.map(describeSite).sort()).toEqual([
      'git/workspace.ts: worktree add -b value value value',
      'git/workspace.ts: worktree list --porcelain',
    ]);
  });

  it('lists the refusal vocabulary separately, and keeps it vocabulary', async () => {
    const vocabulary = commandArrays(await allSources(SRC)).filter((site) => site.vocabulary);

    // Two sets, both in the classifier: the verbs it refuses outright and the ones it
    // routes to the network class. Pinned as a shape, so a third set — or one of these
    // ceasing to be a `new Set(` — fails here and says so.
    expect(vocabulary.map(describeSite).sort()).toEqual([
      'process/tool-policy.ts: am apply checkout clean filter-branch gc prune rebase restore switch',
      'process/tool-policy.ts: clone fetch pull',
    ]);
  });

  it('builds no command that bypasses a hook or redirects the hook directory', async () => {
    const sources = await allSources(SRC);
    const sites: ReadonlyArray<{ file: string; argv: readonly string[] }> = [
      ...commandArrays(sources),
      ...constructions(sources),
    ];

    expect(bypassFindings(sites)).toEqual([]);
  });

  it('never names a hook path, a hook-directory override or Lefthook anywhere in its code', async () => {
    const offenders: string[] = [];
    for (const [file, text] of await allSources(SRC)) {
      const body = code(text).toLowerCase();
      for (const token of ['hookspath', 'hooks/', 'lefthook', 'githooks']) {
        if (body.includes(token)) offenders.push(`${file} mentions ${token}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('names the sites whose argv it cannot read off the page, across the whole product', async () => {
    const open = constructions(await allSources(SRC)).filter((site: Site) => site.open);

    // Eight, and each is a pass-through rather than a command: the project's own
    // `git(run, dir, …)` shorthand handing its parameter along, and `verify/command.ts`
    // discovering a gate command from the repository's own build files — the S12-22
    // boundary, which runs only under execution consent and is never a MergeSutra-authored
    // git call. A ninth open site is a command nobody can read, and this fails so the next
    // person decides about it instead of inheriting it.
    expect(open.map(show).sort()).toEqual([
      'git/workspace.ts: git -C value (open)',
      'git/workspace.ts: git -C value (open)',
      'git/workspace.ts: git rev-parse --verify (open)',
      'intake/local-repo.ts: git -C value (open)',
      'lifecycle/observe.ts: git -C value (open)',
      'lifecycle/observe.ts: git cat-file -e (open)',
      'verify/command.ts: value (open)',
      'verify/patch.ts: git -C value (open)',
    ]);
  });
});

describe('a hook-firing verb keeps the classification Stage 12 gave it', () => {
  /** @see the owner's D1: this item is TEST + DOCUMENT, not a policy redesign. */
  function risk(argv: readonly string[]): string {
    return riskOf({ op: 'execute', argv, cwd: process.cwd() });
  }

  it('files worktree add as WRITE and worktree list as READ', () => {
    expect(risk(['git', 'worktree', 'add', '-b', 'mergesutra/r1', '.', 'abc'])).toBe('WRITE');
    expect(risk(['git', 'worktree', 'list', '--porcelain'])).toBe('READ');
  });

  it('still files the commit family, cleanup and history rewriting as they were', () => {
    expect(risk(['git', 'commit', '-m', 'x'])).toBe('WRITE');
    expect(risk(['git', 'merge', 'origin/main'])).toBe('WRITE');
    expect(risk(['git', 'am', 'p.patch'])).toBe('DESTRUCTIVE');
    expect(risk(['git', 'clean', '-fd'])).toBe('DESTRUCTIVE');
    expect(risk(['git', 'checkout', '--', '.'])).toBe('DESTRUCTIVE');
    expect(risk(['git', 'push', 'origin', 'main'])).toBe('REMOTE_MUTATION');
    expect(risk(['git', 'clone', 'url', 'dir'])).toBe('NETWORK');
  });

  it('shows why the bypass scan, not the classifier, is what excludes --no-verify', () => {
    // Measured, and the reason the enumeration above exists. `FORCEFUL_FLAGS` is consulted
    // only on the push branch, so a commit carrying `--no-verify` is an ordinary WRITE to
    // the gate. The config-override form *is* caught, which makes the asymmetry about the
    // flag's position rather than about a blind classifier.
    expect(risk(['git', 'commit', '--no-verify', '-m', 'x'])).toBe('WRITE');
    expect(risk(['git', '-c', 'core.hooksPath=/tmp/evil', 'commit'])).toBe('DESTRUCTIVE');
  });
});

describe('every test repository is sealed against the host machine’s hook configuration', () => {
  const TESTS = path.join(process.cwd(), 'tests');

  function createsARepository(text: string): boolean {
    return /\[\s*'init'/.test(code(text));
  }

  /**
   * A repository a test creates inherits this machine's `core.hooksPath` unless the test
   * writes its own. On the host running this suite that value points at an operator-level
   * hook, so an unsealed `git commit` inside a fixture would execute someone's unrelated
   * tooling during a test — slow, noisy, and a result that depends on the machine rather
   * than on the code. The seal is a local `core.hooksPath` written into that temporary
   * repository's own `.git/config`, never into the user's configuration.
   *
   * The shape of the write is what counts. A file that only *talks* about
   * `core.hooksPath` — in a comment, or in a string it asserts against — has not told any
   * repository where its hooks live, and treating prose as a seal would let the very
   * sentence explaining the property satisfy the check that enforces it.
   */
  const SEAL = /\[\s*'config',\s*'core\.hooksPath'/;

  function unsealed(files: ReadonlyMap<string, string>): string[] {
    return [...files]
      .filter(([, text]) => createsARepository(text))
      .filter(([, text]) => !SEAL.test(code(text)))
      .map(([file]) => file);
  }

  it('tells a sealed fixture from an unsealed one, so the scan is not blind', () => {
    const probe = new Map([
      ['sealed.ts', "['init', '-q'],\n['config', 'core.hooksPath', hooks],"],
      ['unsealed.ts', "['init', '-q'],\n['add', '-A'],"],
      ['no-repo.ts', "expect(status).toBe('init')"],
      ['comment.ts', "// it inherits core.hooksPath from the machine\n['init', '-q'],"],
      ['mention.ts', "['init', '-q'],\nconst key = 'core.hooksPath';"],
    ]);
    expect(unsealed(probe)).toEqual(['unsealed.ts', 'comment.ts', 'mention.ts']);
  });

  it('finds no test that builds a Git repository without sealing it', async () => {
    const entries = await readdir(TESTS, { withFileTypes: true, recursive: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name));
    const sources = new Map(
      await Promise.all(
        files.map(async (file) => {
          const name = path.relative(TESTS, file).replace(/\\/g, '/');
          return [name, await readFile(file, 'utf8')] as const;
        }),
      ),
    );

    // Named rather than sampled: three fixtures in this repository run `git init`, and each
    // one has to say which hooks it is not going to run.
    const builders = [...sources]
      .filter(([, text]) => createsARepository(text))
      .map(([file]) => file);
    expect(builders.sort()).toEqual([
      'git/workspace.test.ts',
      'helpers/git.ts',
      'security/hook-firing-verbs.test.ts',
    ]);
    expect(unsealed(sources)).toEqual([]);
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'what a real post-checkout hook does to the command that creates a workspace',
  () => {
    const temporary: string[] = [];

    async function runGit(repo: string, args: readonly string[]) {
      return defaultRunner('git', ['-C', repo, ...args]);
    }

    async function mustRun(repo: string, args: readonly string[]): Promise<void> {
      const result = await runGit(repo, args);
      if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }

    async function out(repo: string, args: readonly string[]): Promise<string> {
      return (await runGit(repo, args)).stdout.trim();
    }

    /**
     * A committed throwaway repository whose hook directory belongs to this test.
     *
     * `core.hooksPath` is written into the temporary repository's own config, which both
     * gives the test a hook it controls and keeps the operator-level hooks on this machine
     * out of the run. `null` body means no hook file at all.
     *
     * Every hook writes the three arguments Git hands `post-checkout` into its own hook
     * directory before doing anything else, so "the hook ran, and here is what it was
     * given" is a fact read off disk rather than an inference from an exit code. The marker
     * lives outside the repository, so it cannot dirty the checkout it is measuring.
     */
    async function repoWithHook(
      build: ((marker: string) => string) | null,
    ): Promise<{ repo: string; base: string; hooks: string }> {
      const repo = await makeFixtureTree({
        '.gitignore': '.mergesutra/\n',
        'README.md': '# datekit\n',
      });
      const hooks = await mkdtemp(path.join(os.tmpdir(), 'mergesutra-s1223-hooks-'));
      temporary.push(repo, hooks);
      await mustRun(repo, ['init', '-q']);
      await mustRun(repo, ['config', 'core.hooksPath', hooks]);
      if (build !== null) {
        const marker = path.join(hooks, 'args.txt').replace(/\\/g, '/');
        const body = [`printf '%s|%s|%s\\n' "$1" "$2" "$3" > '${marker}'`, build(marker)].join(
          '\n',
        );
        await writeFile(path.join(hooks, 'post-checkout'), `#!/bin/sh\n${body}\n`, 'utf8');
      }
      await mustRun(repo, ['config', 'user.name', 'MergeSutra Test']);
      await mustRun(repo, ['config', 'user.email', 'test@mergesutra.invalid']);
      await mustRun(repo, ['add', '-A']);
      await mustRun(repo, ['commit', '-q', '-m', 'base']);
      const base = (await out(repo, ['rev-parse', '--verify', 'HEAD'])).toLowerCase();
      return { repo, base, hooks };
    }

    /** What the fired hook was given, as the hook itself recorded it. */
    async function argumentsSeen(hooks: string): Promise<string[]> {
      const text = await readFile(path.join(hooks, 'args.txt'), 'utf8');
      return text.trim().split('|');
    }

    const NULL_SHA = '0'.repeat(40);

    function workspaceOf(repo: string, runId: string): string {
      return path.join(repo, '.mergesutra', 'worktrees', runId);
    }

    afterAll(async () => {
      // Only the directories this block created, by name.
      for (const dir of temporary) await rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    it('fires the hook on the workspace-creating command, and a passing hook changes nothing', async () => {
      const { repo, base, hooks } = await repoWithHook(() => `echo '${HOSTILE}'`);

      const prepared = await prepareWorkspace({ primaryRoot: repo, runId: 'ok1', baseSha: base });

      expect(prepared.baseSha).toBe(base);
      expect(prepared.reused).toBe(false);
      expect(await out(prepared.path, ['rev-parse', '--verify', 'HEAD'])).toBe(base);

      // Git fired `post-checkout` with exactly the arguments its documentation promises: the
      // all-zero previous HEAD, the new HEAD, and the `1` that means "a branch was checked
      // out". MergeSutra never reads this file — it is the test's evidence that the hook ran.
      expect(await argumentsSeen(hooks)).toEqual([NULL_SHA, base, '1']);

      // And nothing the hook printed reached the value the product returns. The operator's
      // stdout is not a channel MergeSutra reads, so it cannot tell this object it is approved.
      const returned = JSON.stringify(prepared);
      expect(returned).not.toContain('approved');
      expect(returned).not.toContain('MERGESUTRA-READY');
    });

    it('reports a workspace Git did create as a failure, because Git returned the hook’s exit code', async () => {
      // The measurement the register had wrong, kept exactly as it happened. Git creates the
      // worktree, checks out the base commit and registers it, and *then* runs
      // `post-checkout`; a non-zero exit from that hook becomes the exit code of the whole
      // `git worktree add`. `src/git/workspace.ts:163-172` reads that code and refuses, so
      // MergeSutra says "git could not create the workspace (3)" about a workspace that now
      // exists — and blames another process holding the repository, which is not what
      // happened. This item documents that (D1: no production change); the evidence is
      // preserved below rather than cleaned away to make the story neat.
      const { repo, base, hooks } = await repoWithHook(() => `echo '${HOSTILE}'\nexit 3`);
      const workspace = workspaceOf(repo, 'hookfail');

      const error = await prepareWorkspace({
        primaryRoot: repo,
        runId: 'hookfail',
        baseSha: base,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/could not create the workspace \(3\)/);

      // The repository contradicts that message, and is asserted rather than described: the
      // worktree is on disk, at the recorded base, registered with Git, on the branch the
      // run owns.
      expect(await out(workspace, ['rev-parse', '--verify', 'HEAD'])).toBe(base);
      expect(await out(repo, ['worktree', 'list', '--porcelain'])).toContain('worktrees/hookfail');
      expect(await out(repo, ['rev-parse', '--verify', 'refs/heads/mergesutra/hookfail'])).toBe(
        base,
      );

      // Measured on this host (Windows, Git for Windows, reached through `spawn(…, { shell:
      // false })`): the hook's own stdout and stderr do not enter Git's captured streams at
      // all. `details.output` was Git's line `Preparing worktree (new branch
      // 'mergesutra/hookfail')` while the hook had echoed `MERGESUTRA-READY approved: true`.
      // That is an environmental fact about this machine's Git, not a guarantee, so the
      // invariant pinned below is the one that holds wherever the suite runs: the verdict
      // comes from the exit code, the message and kind stay MergeSutra's own, and whatever
      // foreign bytes do arrive are confined to the details field — single line, capped by
      // `bound()` at 120 characters. An operator hook cannot author a MergeSutra sentence.
      const output = (error as { details?: { output?: string } }).details?.output ?? '';
      expect(await argumentsSeen(hooks)).toEqual([NULL_SHA, base, '1']);
      expect((error as { kind?: string }).kind).toBe('validation');
      expect((error as Error).message).not.toContain('approved');
      expect(output).not.toContain('\n');
      expect(output.length).toBeLessThanOrEqual(120);
      if (process.platform === 'win32') {
        // Named rather than hidden: this arm is the Windows measurement the closure report
        // cites. On a POSIX host Git may forward hook output into that detail, so the
        // assertion there would be about the machine, not about the product.
        expect(output).not.toContain('MERGESUTRA-READY');
      }

      // And the divergence is stable rather than destructive: the next call finds the
      // workspace registered at the recorded base and returns it as reused. So a run is
      // told "could not create" once and "already there" next — disclosed here so a later
      // reader learns the truth from a test rather than from an error string.
      const again = await prepareWorkspace({ primaryRoot: repo, runId: 'hookfail', baseSha: base });
      expect(again.reused).toBe(true);
    });

    it('says nothing about a hook that is not there, and prepares the workspace normally', async () => {
      const { repo, base, hooks } = await repoWithHook(null);

      const prepared = await prepareWorkspace({
        primaryRoot: repo,
        runId: 'nohook',
        baseSha: base,
      });

      expect(prepared.relativePath).toBe('.mergesutra/worktrees/nohook');
      expect(await out(prepared.path, ['rev-parse', '--verify', 'HEAD'])).toBe(base);
      expect(existsSync(path.join(hooks, 'post-checkout'))).toBe(false);
      // The human's checkout is still clean: the workspace lives under the ignored state
      // directory, which is the property Stage 5 pinned and this environment keeps.
      expect(await out(repo, ['status', '--porcelain'])).toBe('');
    });

    it('keeps a hook that prints MergeSutra-shaped success as foreign output, not a verdict', async () => {
      // §0: data does not become authority by looking authoritative. This hook prints an
      // approval, a MergeSutra-shaped status line, control bytes, and its own `exit 0` —
      // and the product's answer is still decided by Git's process result alone.
      const { repo, base, hooks } = await repoWithHook(() =>
        [
          `printf 'x\\033[31mRED\\033[0m ${HOSTILE}\\n'`,
          "echo 'mergesutra: workspace verified, publication approved'",
          'exit 0',
        ].join('\n'),
      );

      const prepared = await prepareWorkspace({ primaryRoot: repo, runId: 'loud', baseSha: base });

      expect(prepared.path.replace(/\\/g, '/')).toContain('.mergesutra/worktrees/loud');
      expect(await argumentsSeen(hooks)).toEqual([NULL_SHA, base, '1']);
      const returned = JSON.stringify(prepared);
      expect(returned).not.toContain('verified');
      expect(returned).not.toContain('\u001b');

      // And when the same kind of output accompanies a failing hook, the bound detail carries
      // Git's account of the command without letting anything foreign grow past the single
      // 120-character, newline-free line `bound()` promises at `src/git/workspace.ts:281-284`.
      const shouting = await repoWithHook(
        () => `printf '%s\\n' '${'A'.repeat(400)} ${HOSTILE}'\nexit 7`,
      );
      const error = await prepareWorkspace({
        primaryRoot: shouting.repo,
        runId: 'loud2',
        baseSha: shouting.base,
      }).catch((caught: unknown) => caught);
      const output = (error as { details?: { output?: string } }).details?.output ?? '';

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/\(7\)/);
      expect(output.length).toBeLessThanOrEqual(120);
      expect(output).not.toContain('\n');
      expect(output).not.toContain('A'.repeat(121));
    });

    it('seals the fixture: the repository names its own hook directory, not the machine’s', async () => {
      const { repo } = await repoWithHook(() => 'exit 0');

      const hooks = await out(repo, ['config', '--get', 'core.hooksPath']);

      // A local value wins over a global one, which is why these cases measure Git's
      // behaviour rather than this operator's Qoder hook. `git rev-parse --git-path hooks` is
      // Git's own answer to which directory it will use.
      expect(hooks).not.toContain('.codex');
      expect(hooks).toContain('mergesutra-s1223-hooks');
      expect(await out(repo, ['rev-parse', '--git-path', 'hooks'])).toBe(hooks);
    });
  },
);

const MODEL = readDoc('docs/SECURITY_MODEL.md');
const REGISTER = readDoc('docs/SECURITY_GAP_REGISTER.md');
const HEADING = "### Git hooks are the operator's code, not MergeSutra's";

function readDoc(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

/** A markdown heading's section, up to the next heading of any level. */
function section(document: string, heading: string): string {
  const start = document.indexOf(heading);
  expect(start, `the document no longer has the "${heading}" subsection`).toBeGreaterThan(-1);
  const rest = document.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Sentences with whitespace collapsed, so a wrapped clause still matches as one unit. */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?]) /)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function someSentence(text: string, patterns: readonly RegExp[]): string | undefined {
  return sentences(text).find((sentence) => patterns.every((pattern) => pattern.test(sentence)));
}

describe('the security model states the hook facts, and the register no longer overstates them', () => {
  it('says the product commits nothing and pushes nothing, and that its own verbs do not fire hooks', () => {
    const body = section(MODEL, HEADING);
    expect(
      someSentence(body, [/commit/i, /push/i, /not/i]),
      'the model does not state what MergeSutra itself never does',
    ).toBeDefined();
  });

  it('names git worktree add as the verb that may fire an operator-controlled post-checkout', () => {
    const body = section(MODEL, HEADING);
    expect(
      someSentence(body, [/worktree add/, /post-checkout/, /operator/i]),
      'the model does not name the one indirect hook route this build has',
    ).toBeDefined();
  });

  it('points at the npm package-script body as the second indirect route, without merging the two', () => {
    const body = section(MODEL, HEADING);
    expect(
      someSentence(body, [/npm/, /script/, /second/i]),
      'the model does not keep the S12-22 gate route visible alongside the hook route',
    ).toBeDefined();
  });

  it('files hook stdout and stderr as foreign data, never as MergeSutra authority or evidence', () => {
    const body = section(MODEL, HEADING);
    expect(
      someSentence(body, [/output|stdout|stderr/, /not.*authority|never.*authority|is data/]),
      'the model does not disarm hook output as data',
    ).toBeDefined();
  });

  it('says a hook failure can change Git’s result after Git already created the workspace', () => {
    const body = section(MODEL, HEADING);
    expect(
      someSentence(body, [/exit status|non-zero|fails/i, /after/i, /creat|exist/i]),
      'the model does not disclose the created-but-reported-failed divergence',
    ).toBeDefined();
  });

  it('keeps the sentence the whole Stage 5 design depends on: a worktree is not an OS sandbox', () => {
    // §51. A hooks section that widened the isolation claim would be the most
    // consequential way to get this wrong, so the load-bearing sentence is pinned here.
    expect(MODEL).toMatch(/worktree isolation is not an OS\s+sandbox/i);
  });

  it('never claims hooks can never run', () => {
    // The single false statement this item exists to retire. Both documents are checked,
    // because the register is where it was written.
    expect(MODEL).not.toMatch(/hooks?\b[^.]*?\b(can\s*never|never\s+run|cannot\s+run)\b/i);
    expect(REGISTER).not.toMatch(/no hook-firing verb is ever spawned/i);
    expect(REGISTER).not.toMatch(/no\s+`?hooksPath`?\s+write exists \(zero greps\)/i);
  });

  it('records in the register that worktree add fires post-checkout, with the closure named', () => {
    const entry = section(REGISTER, '## S12-23');
    expect(
      someSentence(entry, [/worktree add/, /post-checkout/]),
      'the register still does not say which verb fires which hook',
    ).toBeDefined();
    expect(someSentence(entry, [/CLOSED/i, /TEST/, /DOCUMENT/])).toBeDefined();
  });
});
