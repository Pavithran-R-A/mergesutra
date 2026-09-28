import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { riskOf, type RiskClass } from '../../src/process/tool-policy.js';
import { constructions, reachFrom, relative, show, SRC } from '../helpers/sourceShape.js';

/**
 * What Stage 10 is never built to put in front of a process.
 *
 * `boundaries.test.ts` proves the import side: the production path cannot reach the
 * publication seam, a runner, a writer or a client. This file proves the other half,
 * which imports alone cannot settle — the repair stage reached processes through
 * *measurements*, and so does this one. `describePatch` asks git what a workspace
 * holds, and somewhere in the closure there are argv arrays, so somebody has to have
 * looked at every one of them and said what a publication stage is allowed to ask.
 *
 * The answer is short, and that is the finding: a pull request is assembled from
 * bytes that are already there, so the only commands worth having are the ones that
 * read. There is no push, no merge, no rebase, no reset, no clean, no `gh`, no
 * publish, and no shell — because each of those would let a page nobody approved be
 * acted on, which is precisely the event §11 through §14 of the stage exist to make
 * unrepresentable.
 *
 * Nothing here is executed. The claims are made of source text and of the product's
 * own classifier: the first two blocks show what that classifier catches — every git
 * verb a publication would reach for, and the programs that are not git at all, since
 * Stage 12 closed the day `gh`, `npm` and `curl` read as ordinary EXECUTE — so a stage
 * that did build one of those argv arrays would be refused twice over. The third block
 * is the evidence that it does not have to: every command this stage's reach builds is a
 * git read. Without the first two, the third would be a scan that found nothing and
 * called it clean.
 */

/** The command a person types, and the stage it calls: the whole production path. */
function entries(): string[] {
  return [path.join(SRC, 'cli', 'pr.ts'), path.join(SRC, 'pr', 'stage.ts')];
}

function risksOf(argv: readonly string[]): RiskClass {
  return riskOf({ op: 'execute', argv, cwd: process.cwd() });
}

describe('what a publication stage could ever put in front of a process', () => {
  it('reaches a real span of the product, so the scan below cannot pass by finding nothing', async () => {
    const sources = await reachFrom(entries());

    // The orchestrator's own dependencies: Stage 7's patch measurement, Stage 8's
    // pack reader and the state layer that files the record. A closure this thin
    // would mean the walk broke, and an empty scan would then read as clean.
    // `pr/publisher.ts` is deliberately absent — the seam is unreachable from here,
    // which is what `boundaries.test.ts` pins down.
    expect([...sources.keys()]).toEqual(
      expect.arrayContaining([
        'cli/pr.ts',
        'pr/stage.ts',
        'pr/candidate.ts',
        'pr/draft.ts',
        'verify/patch.ts',
        'report/write.ts',
        'state/run-store.ts',
      ]),
    );
    expect(sources.size).toBeGreaterThan(15);
    for (const [, text] of sources) expect(text.length).toBeGreaterThan(50);
  });

  it('refuses the git verbs a publication would need, before checking that none is built', async () => {
    // The positive control for the classifier. Each of these is a command a future
    // contributor or a repository file could put in front of a process, and the
    // classifier is what stands between the ask and the process. These are the ones
    // it carries by itself.
    const refused: ReadonlyArray<readonly [string[], RiskClass]> = [
      [['git', 'push'], 'REMOTE_MUTATION'],
      [['git', 'push', 'origin', 'mergesutra/run-1'], 'REMOTE_MUTATION'],
      [['git', 'push', '--force'], 'DESTRUCTIVE'],
      [['git', 'push', '--force-with-lease'], 'DESTRUCTIVE'],
      [['git', 'push', '-f'], 'DESTRUCTIVE'],
      [['git', 'reset', '--hard', 'HEAD~1'], 'DESTRUCTIVE'],
      [['git', 'clean', '-fd'], 'DESTRUCTIVE'],
      [['git', 'rebase', 'main'], 'DESTRUCTIVE'],
    ];

    for (const [argv, expected] of refused) {
      expect(risksOf(argv), argv.join(' ')).toBe(expected);
    }
  });

  it('sees the publishing commands now, and still builds none of them', async () => {
    // The other half of the positive control, rewritten by Stage 12. It used to read
    // "the classifier's remote knowledge is git-specific, so `gh pr create` and
    // `npm publish` fall through to ordinary EXECUTE and nothing in this stage may be
    // credited to the risk gate" — a limitation recorded rather than repaired from
    // Stage 10. The gate now classifies a program by what its argv reaches, so those
    // commands arrive as a remote mutation or a network channel and are refused before
    // any consent is read. That is a real gain and this stage does not lean on it: what
    // still stops a publication is that no module in the reach constructs these argvs at
    // all, which is the enumeration below and the import ban in `boundaries.test.ts`.
    const nowFlagged: readonly (readonly [string[], RiskClass])[] = [
      [['gh', 'pr', 'create'], 'REMOTE_MUTATION'],
      [['gh', 'api', '/repos/x/y/pulls', '--method', 'POST'], 'REMOTE_MUTATION'],
      [['npm', 'publish'], 'REMOTE_MUTATION'],
      [['pnpm', 'publish'], 'REMOTE_MUTATION'],
      [['curl', '-X', 'POST', 'https://api.github.com/repos/x/y/pulls'], 'NETWORK'],
    ];

    for (const [argv, expected] of nowFlagged) {
      expect(risksOf(argv), argv.join(' ')).toBe(expected);
    }

    // The verbs that write the local repository and are honestly not remote acts:
    // `git commit` and `git add`. Their absence above is not the safety either — the
    // safety is that this stage builds no command but the reads. Stage 10 commits
    // nothing, which is the recorded consequence: a workspace MergeSutra never
    // committed has nothing to push, and a person who wants those commits makes them.
    expect(risksOf(['git', 'commit', '-m', 'via mergesutra'])).toBe('WRITE');
    expect(risksOf(['git', 'add', '.'])).toBe('WRITE');
    expect(risksOf(['git', 'merge', 'origin/main'])).toBe('WRITE');
  });

  it('constructs only commands that read, and names every one of them', async () => {
    const sites = constructions(await reachFrom(entries()));

    const closed = sites.filter((site) => !site.open);
    const unsafe = closed
      .filter((site) => {
        const risk = risksOf(site.argv);
        return risk === 'DESTRUCTIVE' || risk === 'REMOTE_MUTATION';
      })
      .map((site) => `${show(site)} is ${risksOf(site.argv)}`);
    expect(unsafe).toEqual([]);

    // The whole enumeration, listed rather than sampled. A publication run measures
    // the workspace twice at most — once for the patch, once for the base it sits on
    // — and asks git what it is looking at. Nothing else in the stage's reach builds
    // a command at all, which is why there is nowhere for a push to enter.
    //
    // The first entry is Stage 9's, reached transitively: `state/run-record.ts` and
    // the pack layer import the review and repair documents, so the walk arrives at
    // the review context assembler and the per-file diff it reads a reviewer's model.
    // That diff is a read over bytes already on disk, which is why it belongs on this
    // list rather than being excepted from it — but it is a reason to keep the list
    // long enough that the next transitive arrival is noticed here.
    expect(closed.map(show).sort()).toEqual([
      'review/context.ts: git -C value diff --no-ext-diff --no-renames value -- value',
      'verify/patch.ts: git diff --name-status --no-renames --no-ext-diff -z value',
      'verify/patch.ts: git ls-files --others --exclude-standard -z',
      'verify/patch.ts: git rev-parse --show-toplevel',
      'verify/patch.ts: git rev-parse HEAD',
    ]);
    expect([...new Set(closed.map((site) => site.argv[0] ?? ''))]).toEqual(['git']);
  });

  it('leaves the commands it cannot write out to the modules that check them', async () => {
    const open = constructions(await reachFrom(entries())).filter((site) => site.open);

    // A spread means an argv this file cannot read, so each one is named rather than
    // waved through. `verify/patch.ts` is the project's own `git(run, dir, args)`
    // shorthand passing its parameter along; every caller of it that a publication
    // run reaches is literal, which is what lets the list above count as complete.
    // `verify/command.ts` is a *gate*: its argv is discovered from the repository's
    // own build files, so MergeSutra never wrote a command down. Gates run only under
    // the execution consent Stage 7 records, and Stage 10 never runs one — it reads
    // the receipts Stage 7 left. A gate that escaped its declared argv is Stage 7's
    // test to catch, and `tests/repair/source-shape.test.ts` already names this site.
    //
    // A third open site, or one in a module Stage 10 newly reached, would be a
    // command nobody can read off the page, and this fails so that the next person
    // decides about it rather than inheriting it.
    expect(open.map(show).sort()).toEqual([
      'verify/command.ts: value (open)',
      'verify/patch.ts: git -C value (open)',
    ]);
  });

  it('never names a removal, an escalation or a publish as something to start', async () => {
    const banned = new Set([
      'rm',
      'del',
      'rd',
      'rmdir',
      'shred',
      'erase',
      'sudo',
      'runas',
      'doas',
      'diskpart',
      'mkfs',
      'dd',
      'gh',
      'hub',
      'npm',
      'pnpm',
      'yarn',
      'curl',
      'wget',
      'ssh',
      'scp',
    ]);

    const offenders = constructions(await reachFrom(entries()))
      .filter((site) => banned.has((site.argv[0] ?? '').toLowerCase()))
      .map(show);

    // MergeSutra does not delete, does not publish, and does not ask a hosting
    // service for anything. A person who wants any of those runs them.
    expect(offenders).toEqual([]);
  });

  it('asks for no shell anywhere in its reach', async () => {
    const sources = await reachFrom(entries());

    const offenders: string[] = [];
    for (const [file, text] of sources) {
      if (file === 'core/runner.ts') continue;
      const body = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const token of ['child_process', 'execSync', 'execFile', 'spawn(', 'spawnSync']) {
        if (body.includes(token)) offenders.push(`${file} mentions ${token}`);
      }
    }
    expect(offenders).toEqual([]);

    // The one module that owns child processes, read for what it may do: argv, and
    // never a shell — a shell would let an argv string be re-split into a command
    // this scan never saw.
    const runner = sources.get('core/runner.ts');
    expect(runner, 'the runner must be reachable for this to mean anything').toBeDefined();
    const body = (runner ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(body.includes('shell: false'), 'shell: false').toBe(true);
    for (const word of ['shell: true', 'exec(', 'cmd.exe', 'powershell', ' /c ']) {
      expect(body.includes(word), word).toBe(false);
    }
  });

  it('keeps the reach free of any module that talks to a hosting service', async () => {
    const sources = await reachFrom(entries());
    const text = [...sources.values()]
      .map((body) => body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');

    expect(
      [...sources.keys()].filter(
        (file) => file.startsWith('github/') || file.startsWith('bharatcode/'),
      ),
    ).toEqual([]);
    for (const word of ['createPullRequest', 'octokit', 'api.github.com', 'Bearer ']) {
      expect(text.includes(word), word).toBe(false);
    }
    // The words a publication stage may print, and the ones it may not print about
    // itself: no outcome here may read as though a remote had answered.
    for (const file of ['pr/stage.ts', 'cli/pr.ts']) {
      const body = sources.get(file) ?? '';
      for (const word of ['PR CREATED', 'HUMAN_APPROVED_FOR_PR — published']) {
        expect(body.includes(word), `${relative(path.join(SRC, file))} ${word}`).toBe(false);
      }
    }
  });
});
