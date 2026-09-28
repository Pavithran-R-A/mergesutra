import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { riskOf, type RiskClass } from '../../src/process/tool-policy.js';
import {
  code,
  constructions,
  reachFrom,
  relative,
  show,
  SRC,
  type Site,
} from '../helpers/sourceShape.js';

/**
 * What Stage 11 is never built to do to a workspace or to a run's history.
 *
 * §35 and §56 say recovery must never mean `git reset --hard`, `git clean -fd`,
 * `git checkout -- .`, an automatic stash or a delete-and-rebuild. That rule is easy to
 * honour in a first draft and easy to lose afterwards — not through a diff that
 * announces itself, but through `observe.ts` importing one more helper because it was
 * handy, or the dispatcher gaining a case that "just finishes the job". A behaviour test
 * cannot see a change like that coming, so this file reads the source as data and names
 * every command the recovery path could put in front of a process.
 *
 * Two reaches are scanned, because Stage 11 has two halves with different risk.
 *
 * The *observer* — `mergesutra status`, and `src/lifecycle/resume.ts` up to the moment it
 * hands a plan over — is where a rollback would be tempting, since a broken-looking run
 * is precisely when someone reaches for `checkout`. It is also the half that owes no
 * credential, no model and no network, so its closure is checked for those absences
 * rather than taking them on trust.
 *
 * The *dispatcher* is the whole `mergesutra resume --execute` path. Its claim is weaker
 * but not free: resuming a stage builds no command beyond the reads those stages already
 * built in Stages 3–10, and it gains no route to a repair nobody approved, to the
 * publication seam, or to a hosting service nobody was asked to contact.
 *
 * Nothing here is executed. The classifications come from the product's own risk gate,
 * and the second and third blocks show what that gate catches and, more usefully, what it
 * does not: `git checkout -- .`, `git restore` and `git stash` are merely WRITE to it, so
 * §35's ban on those rests on the enumeration below and on the scanner that produced it —
 * both of which are proven here, in the same way Stage 10 proved that its ban on `gh`
 * rested on absence rather than on a gate.
 */

/** The observation half: prints a state and a plan, and decides nothing to run. */
function observerEntries(): string[] {
  return [
    path.join(SRC, 'cli', 'status.ts'),
    path.join(SRC, 'lifecycle', 'status.ts'),
    path.join(SRC, 'lifecycle', 'resume.ts'),
  ];
}

/** The acting half: everything `mergesutra resume --execute` can arrive at. */
function dispatcherEntries(): string[] {
  return [path.join(SRC, 'cli', 'resume.ts')];
}

function risksOf(argv: readonly string[]): RiskClass {
  return riskOf({ op: 'execute', argv, cwd: process.cwd() });
}

/**
 * Tokens that rewrite history or throw work away.
 *
 * Matched as whole argv elements, so `git diff --no-ext-diff` and
 * `git worktree list --porcelain` are not mistaken for the verbs they sit beside.
 */
const REWRITE = [
  'reset',
  'clean',
  'checkout',
  'restore',
  'stash',
  'rebase',
  'push',
  'apply',
  'rm',
  'remove',
  'commit',
  'merge',
  'gc',
] as const;

/** Every site that would put a rollback in front of a process, spelled out if any exists. */
function rewriteSites(sites: readonly Site[]): string[] {
  return sites
    .filter((site) => site.argv.some((token) => (REWRITE as readonly string[]).includes(token)))
    .map((site) => `${show(site)} is ${site.open ? 'only partly known' : risksOf(site.argv)}`);
}

/** Strip comments across a whole reach: prose about a command is not a command. */
function prose(reach: Map<string, string>): string {
  return [...reach.values()].map((text) => code(text)).join('\n');
}

describe('what recovery could ever put in front of a process', () => {
  it('reaches a real span of the product, so the scans below cannot pass by finding nothing', async () => {
    const sources = await reachFrom(observerEntries());

    // Status's own reading path: the workspace observer, the snapshot it builds, the
    // staleness graph, the budget and the lock. If this list came back thin, the walk
    // would have broken somewhere and every "no offender found" below would be noise.
    expect([...sources.keys()]).toEqual(
      expect.arrayContaining([
        'cli/status.ts',
        'lifecycle/status.ts',
        'lifecycle/resume.ts',
        'lifecycle/resume-plan.ts',
        'lifecycle/snapshot.ts',
        'lifecycle/observe.ts',
        'lifecycle/staleness.ts',
        'lifecycle/next-actions.ts',
        'lifecycle/budget.ts',
        'lifecycle/lock.ts',
        'verify/patch.ts',
        'state/run-store.ts',
      ]),
    );
    expect(sources.size).toBeGreaterThan(40);
    for (const [, text] of sources) expect(text.length).toBeGreaterThan(50);
  });

  it('refuses the verbs that end a run history, before checking that none is built', async () => {
    // The positive control for the gate. Each of these is what §35 forbids, and the
    // classifier is what stands between a later contributor's convenience and a process.
    const refused: ReadonlyArray<readonly [string[], RiskClass]> = [
      [['git', 'reset', '--hard', 'HEAD~1'], 'DESTRUCTIVE'],
      [['git', 'clean', '-fd'], 'DESTRUCTIVE'],
      [['git', 'worktree', 'remove', '../wt'], 'DESTRUCTIVE'],
      [['git', 'apply', '--reverse', 'p.diff'], 'DESTRUCTIVE'],
      [['git', 'rebase', 'main'], 'DESTRUCTIVE'],
      [['git', 'push', 'origin', 'main'], 'REMOTE_MUTATION'],
    ];

    for (const [argv, expected] of refused) {
      expect(risksOf(argv), argv.join(' ')).toBe(expected);
    }

    // The other half, and the half Stage 12 changed. These were the §35 prohibitions
    // the classifier did *not* see: `checkout -- .` discards every uncommitted byte in
    // the workspace and was filed as an ordinary WRITE, which is why this stage refused
    // to credit its safety to the risk gate and enumerated its commands instead. The
    // gate now treats all five as destruction, so a run cannot be talked into erasing
    // the artifact ADR-057 declares authoritative. The enumeration and the positive
    // control below stay — a second layer is the point of a second layer, not a first.
    for (const argv of [
      ['git', 'checkout', '--', '.'],
      ['git', 'restore', '--source=HEAD', '--worktree', '--', '.'],
      ['git', 'stash'],
      ['git', 'stash', 'pop'],
      ['git', 'switch', '--detach'],
    ]) {
      expect(risksOf(argv), argv.join(' ')).toBe('DESTRUCTIVE');
    }
  });

  it('would see a rollback command if one were ever written into the reach', async () => {
    // The positive control for the scanner, which is the claim the enumeration depends
    // on. A guard that reports "no rollback is built" because it cannot read a built
    // rollback is worse than none: it looks like proof. These are the exact shapes the
    // project uses to name a command, planted in the module that would be tempting to
    // add one to, and each has to come back tagged.
    const planted = new Map([
      [
        'lifecycle/observe.ts',
        [
          "const a = run('git', ['reset', '--hard', 'HEAD~1']);",
          "const b = run('git', ['checkout', '--', '.']);",
          "const c = run('git', ['stash', 'push']);",
          "const d = git(run, dir, ['clean', '-fd']);",
        ].join('\n'),
      ],
    ]);

    const sites = constructions(planted);
    expect(sites).toHaveLength(4);
    expect(rewriteSites(sites).sort()).toEqual(
      [
        'lifecycle/observe.ts: git checkout -- . is DESTRUCTIVE',
        'lifecycle/observe.ts: git clean -fd is DESTRUCTIVE',
        'lifecycle/observe.ts: git reset --hard HEAD~1 is DESTRUCTIVE',
        'lifecycle/observe.ts: git stash push is DESTRUCTIVE',
      ].sort(),
    );
  });

  it('constructs only commands that read, and names every one of them', async () => {
    const sites = constructions(await reachFrom(observerEntries()));
    const closed = sites.filter((site) => !site.open);

    expect(rewriteSites(sites)).toEqual([]);
    for (const site of closed) expect(risksOf(site.argv), show(site)).toBe('READ');

    // The whole enumeration, listed rather than sampled. Status measures a workspace and
    // a patch — the recorded base, the current bytes, the identity of the pack on disk —
    // and asks git what it is looking at. The `review/context.ts` entry arrives through
    // `report/write.ts`: reading a pack's identity reaches the module that assembles a
    // reviewer's model, which reads a per-file diff. That diff is a read over bytes
    // already on disk, so it belongs on this list; it is also a reason to keep the list
    // long enough that the next transitive arrival is noticed here.
    expect(closed.map(show).sort()).toEqual([
      'lifecycle/observe.ts: git rev-parse --show-toplevel',
      'lifecycle/observe.ts: git rev-parse --verify HEAD',
      'review/context.ts: git -C value diff --no-ext-diff --no-renames value -- value',
      'verify/patch.ts: git diff --name-status --no-renames --no-ext-diff -z value',
      'verify/patch.ts: git ls-files --others --exclude-standard -z',
      'verify/patch.ts: git rev-parse --show-toplevel',
      'verify/patch.ts: git rev-parse HEAD',
    ]);
    expect([...new Set(closed.map((site) => site.argv[0] ?? ''))]).toEqual(['git']);
  });

  it('names the sites whose argv it cannot read off the page', async () => {
    const open = constructions(await reachFrom(observerEntries())).filter((site) => site.open);

    // A spread means an argv this file cannot fully see, so each one is named rather than
    // waved through. Three of the four are the project's own `git(run, dir, args)`
    // shorthand passing its parameter along — the literal commands those helpers are
    // called with are the enumeration above. `verify/command.ts` is a *gate* whose argv is
    // discovered from the repository's own build files, so MergeSutra never wrote a
    // command down; gates run only under the execution consent Stage 7 records, and
    // status never runs one. A fifth open site, or one in a module the observer newly
    // reaches, is a command nobody can read, and this fails so the next person decides
    // about it rather than inheriting it.
    expect(open.map(show).sort()).toEqual([
      'lifecycle/observe.ts: git -C value (open)',
      'lifecycle/observe.ts: git cat-file -e (open)',
      'verify/command.ts: value (open)',
      'verify/patch.ts: git -C value (open)',
    ]);
  });

  it('reaches no writer, no stage and no client, because it decides nothing to run', async () => {
    const sources = await reachFrom(observerEntries());

    // The structural form of §34's "observe, then compare, then act somewhere else".
    // Status and the preview answer "what is true and what does that owe" — so the
    // modules that could carry out an answer are not reachable from them at all: no file
    // writer, no loop, no stage runner, no configuration, no model client, no hosting
    // service, and not even the command layer that would wire one in. `cli/resume.ts`
    // being absent is the point of the split: the observer is *called by* the command
    // layer and contains none of it.
    const absent = [
      'security/writer.ts',
      'implement/loop.ts',
      'implement/implement.ts',
      'plan/plan.ts',
      'verify/stage.ts',
      'review/stage.ts',
      'repair/stage.ts',
      'pr/stage.ts',
      'pr/publisher.ts',
      'config/load-config.ts',
      'bharatcode/client.ts',
      'github/gh-client.ts',
      'cli/program.ts',
      'cli/resume.ts',
    ];
    expect([...sources.keys()].filter((file) => absent.includes(file))).toEqual([]);
    expect(
      [...sources.keys()].filter(
        (file) => file.startsWith('github/') || file.startsWith('bharatcode/'),
      ),
    ).toEqual([]);
  });

  it('needs no model, no credential and no network to say what a run owes', async () => {
    const text = prose(await reachFrom(observerEntries()));

    for (const word of [
      'createPullRequest',
      'octokit',
      'api.github.com',
      'Bearer ',
      'fetch(',
      'https://',
      'http://',
    ]) {
      expect(text.includes(word), word).toBe(false);
    }
    // The lock is the one module in this reach that creates anything, and what it
    // creates is a directory. No runner, no writer, no client: holding a run open is not
    // a capability, which is the claim §53 makes a hero test of and this makes a
    // build gate of.
    const lock = (await reachFrom(observerEntries())).get('lifecycle/lock.ts') ?? '';
    expect(lock.length, 'lifecycle/lock.ts must be in the reach').toBeGreaterThan(50);
    for (const word of ['runner', 'child_process', "run('", 'writer', 'client']) {
      expect(code(lock).includes(word), word).toBe(false);
    }
  });

  it('asks for no shell anywhere in either half of recovery', async () => {
    for (const entries of [observerEntries(), dispatcherEntries()]) {
      const sources = await reachFrom(entries);
      const offenders: string[] = [];
      for (const [file, text] of sources) {
        if (file === 'core/runner.ts') continue;
        const body = code(text);
        for (const token of ['child_process', 'execSync', 'execFile', 'spawn(', 'spawnSync']) {
          if (body.includes(token)) offenders.push(`${file} mentions ${token}`);
        }
      }
      expect(offenders).toEqual([]);

      const runner = sources.get('core/runner.ts');
      expect(runner, 'the runner must be reachable for this to mean anything').toBeDefined();
      const body = code(runner ?? '');
      expect(body.includes('shell: false'), 'shell: false').toBe(true);
      for (const word of ['shell: true', 'exec(', 'cmd.exe', 'powershell', ' /c ']) {
        expect(body.includes(word), word).toBe(false);
      }
    }
  });
});

describe('what `resume --execute` is not given permission to reach', () => {
  it('reaches the stages it can stand in for, and nothing that publishes', async () => {
    const sources = await reachFrom(dispatcherEntries());

    // The dispatcher's whole job is to call the same stage runner the direct command
    // calls, so those runners are here on purpose — including a model client, which is
    // the honest difference from the observer above: a resumed loop can ask a model
    // something. That is why §18 puts the request behind `--execute`, and why the
    // preview prints the cost first.
    expect([...sources.keys()]).toEqual(
      expect.arrayContaining([
        'cli/resume.ts',
        'lifecycle/resume.ts',
        'plan/plan.ts',
        'implement/implement.ts',
        'verify/stage.ts',
        'review/stage.ts',
        'pr/stage.ts',
        'report/write.ts',
        'state/run-store.ts',
        'bharatcode/client.ts',
      ]),
    );

    // And these are the absences that make §17 and §26 structural rather than promised.
    // `repair/stage.ts` is unreachable because the dispatcher has no route to it; the
    // publication seam and every hosting-service module are unreachable because Stage 10
    // left them that way and this path does not reopen them; `cli/pr.ts` is absent
    // because a resumed publication stage is called, not re-parsed from a command line —
    // so an approval flag has no way to enter here.
    const unreachable = [
      'repair/stage.ts',
      'cli/repair.ts',
      'cli/pr.ts',
      'cli/doctor.ts',
      'cli/issue.ts',
      'pr/publisher.ts',
      'github/gh-client.ts',
      'intake/intake.ts',
    ];
    expect([...sources.keys()].filter((file) => unreachable.includes(file))).toEqual([]);
    expect([...sources.keys()].filter((file) => file.startsWith('github/'))).toEqual([]);
  });

  it('builds no command that a direct stage run did not already build', async () => {
    const sites = constructions(await reachFrom(dispatcherEntries()));
    const closed = sites.filter((site) => !site.open);

    expect(rewriteSites(sites)).toEqual([]);
    for (const site of closed) expect(risksOf(site.argv), show(site)).toBe('READ');

    // The full enumeration for the acting half, listed because "identical to Stages
    // 3–10" is only checkable as a set. Nine more than the observer, and all nine are
    // measurement: `git/workspace.ts` for the worktree a resumed loop stands in,
    // `verify/workspace.ts` for the `--check` a gate round wants, and the extra
    // `rev-parse`/`cat-file` reads that identify a base commit. Not one of them writes,
    // and nothing here is new to this stage — which is the property a later contributor
    // can break with a single added helper, so it is pinned.
    expect(closed.map(show).sort()).toEqual([
      'git/workspace.ts: git cat-file -t value',
      'git/workspace.ts: git check-ignore -- value',
      'git/workspace.ts: git rev-parse --show-toplevel',
      'git/workspace.ts: git rev-parse --verify HEAD',
      'git/workspace.ts: git status --porcelain',
      'git/workspace.ts: git worktree list --porcelain',
      'lifecycle/observe.ts: git rev-parse --show-toplevel',
      'lifecycle/observe.ts: git rev-parse --verify HEAD',
      'review/context.ts: git -C value diff --no-ext-diff --no-renames value -- value',
      'verify/patch.ts: git diff --name-status --no-renames --no-ext-diff -z value',
      'verify/patch.ts: git ls-files --others --exclude-standard -z',
      'verify/patch.ts: git rev-parse --show-toplevel',
      'verify/patch.ts: git rev-parse HEAD',
      'verify/workspace.ts: git diff --check',
    ]);
    expect([...new Set(closed.map((site) => site.argv[0] ?? ''))]).toEqual(['git']);
  });

  it('names the open sites in the acting half too', async () => {
    const open = constructions(await reachFrom(dispatcherEntries())).filter((site) => site.open);

    // Same reading as the observer's, plus `git/workspace.ts`: its two shorthand sites
    // pass a caller's arguments through, and the callers a resumed run reaches are the
    // literal reads above. A new open site is a command nobody can read off the page, and
    // `tests/repair/source-shape.test.ts` already names `verify/command.ts` as the gate.
    expect(open.map(show).sort()).toEqual([
      'git/workspace.ts: git -C value (open)',
      'git/workspace.ts: git -C value (open)',
      'git/workspace.ts: git rev-parse --verify (open)',
      'lifecycle/observe.ts: git -C value (open)',
      'lifecycle/observe.ts: git cat-file -e (open)',
      'verify/command.ts: value (open)',
      'verify/patch.ts: git -C value (open)',
    ]);
  });

  it('files no record and grants no capability of its own', async () => {
    const sources = await reachFrom(dispatcherEntries());
    const body = code(sources.get('cli/resume.ts') ?? '');

    // The command layer reads a record and prints what comes back. Every outcome this
    // path files is filed by the stage it stood in for, which is what lets §37's exit
    // rule be "return the authoritative resulting lifecycle outcome" instead of a guess
    // assembled here. `.save(` in this file would be that guarantee gone.
    expect(body.includes('.save('), 'no record written here').toBe(false);
    expect(body.includes('store.load('), 'it does read one').toBe(true);

    // §17 read as an import claim: the two digest-bound approval documents live in
    // modules this file never names. It cannot construct an approval because it cannot
    // name the type one is made of.
    for (const specifier of ['pr/approval.js', 'repair/consent.js', 'verify/consent.js']) {
      expect(body.includes(specifier), specifier).toBe(false);
    }
    for (const word of ['approved: true', 'grantApproval', '--yes', '--force']) {
      expect(body.includes(word), word).toBe(false);
    }
  });

  it('offers one flag that acts, and never a flag that skips reading', async () => {
    const source = await readFile(path.join(SRC, 'cli', 'program.ts'), 'utf8');
    const start = source.indexOf(".command('resume [run-id]')");
    expect(start, 'the resume command must be declared').toBeGreaterThan(-1);
    const next = source.indexOf('.command(', start + 1);
    const block = source.slice(start, next === -1 ? source.length : next);

    // §16's shape in one line: preview is what happens when you say nothing, and
    // `--execute` is the only word that changes that. `--yes` would be a way to say the
    // second without having seen the first.
    expect(block).toContain("'--execute'");
    expect(block).toContain("'--allow <gate-id>'");
    expect(block).not.toMatch(/--yes|--force|--all\b/);
    expect(code(source)).not.toContain("'--yes'");
  });
});

describe('the boundary recovery is not allowed to blur', () => {
  it('keeps every lifecycle module ignorant of the command layer', async () => {
    const dir = path.join(SRC, 'lifecycle');
    const names = await readdir(dir);
    const offenders: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.ts')) continue;
      const text = code(await readFile(path.join(dir, name), 'utf8'));
      for (const token of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = token[1] ?? '';
        if (specifier.includes('/cli/') || specifier.startsWith('./cli/')) {
          offenders.push(`${relative(path.join(dir, name))} imports ${specifier}`);
        }
      }
    }

    // `src/lifecycle/resume.ts` cannot dispatch: the stages it would run import state
    // modules this layer reads, and importing them back through the command layer would
    // be a cycle. So the executor arrives as a parameter instead — which is also what
    // makes a preview and an execution the same function with different hands.
    expect(offenders).toEqual([]);
  });

  it('does not sell recovery as a guarantee', async () => {
    const sources = await reachFrom([...observerEntries(), ...dispatcherEntries()]);
    const documented = new Map(sources);
    documented.set('cli/program.ts', await readFile(path.join(SRC, 'cli', 'program.ts'), 'utf8'));

    // §55's exact phrases, not the word "crash": `lock.ts` legitimately calls mkdir the
    // crash-safe primitive it is, and that is a statement about atomicity on two
    // operating systems, not a promise about anyone's work. What is forbidden is the
    // sentence a reader would act on — that resaving a run cannot lose anything, or that
    // recovery is complete.
    const claims = [
      /crash[- ]proof/i,
      /never loses/i,
      /perfect recovery/i,
      /bulletproof/i,
      /guarantees? (your|the) work/i,
    ];
    for (const [file, text] of documented) {
      for (const claim of claims) {
        expect(claim.test(text), `${file} says ${claim}`).toBe(false);
      }
    }
  });
});
