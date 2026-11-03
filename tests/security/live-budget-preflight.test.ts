import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveCompletion } from '../../src/bharatcode/request-budget.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'live-budget.mjs');
const QUALIFICATION_LIB = path.join(ROOT, 'scripts', 'lib', 'live-qualification.mjs');
const runChild = promisify(execFile);

/**
 * The pre-request ceiling has to survive the trip from the workflow to the process that
 * actually sends a completion, and that trip crosses two boundaries no unit test of
 * `reserveCompletion` can see: the driver's environment, and the directory the count lives
 * in. Both can be quietly undone — a child environment that strips the ledger, a ceiling
 * pinned to a number the chain never measures against, a ledger that a re-run starts over
 * from, a filesystem whose exclusive create is not honoured — and every one of those reads
 * as a successful run, because nothing spends past a ceiling that was never installed.
 *
 * So this file tests the live chain's own gate. It runs the shipped module in a real Node
 * process against planted directories (the rules live under `scripts/`, which vitest cannot
 * bundle: its loader cannot resolve an absolute path containing spaces), and it plants the
 * hostile cases — a symlink, a file in place of a directory, a group-readable ledger, a
 * filesystem that ignores `O_EXCL`, a filesystem that ignores permission bits — rather than
 * hoping a hosted runner happens to produce one.
 */

interface LedgerResult {
  refusals: string[];
  notes: string[];
  survivors: string[];
  bytes: string;
}

interface HarnessOutput {
  ceiling: number;
  config: Record<string, string[]>;
  ledger: Record<string, LedgerResult>;
  childEnv: Record<string, string[]>;
  markerNames: string[];
}

const HARNESS = `
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const [payloadPath, libPath, rulesPath] = process.argv.slice(1);
const lib = await import(pathToFileURL(libPath).href);
const rules = await import(pathToFileURL(rulesPath).href);
const input = JSON.parse(await readFile(payloadPath, 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-livebudget-'));

const markerNames = Array.from({ length: 12 }, (_, index) =>
  'completion-' + String(index + 1).padStart(4, '0'),
);

async function plant(name, spec) {
  const base = path.join(root, name);
  await mkdir(base, { recursive: true });
  const ledger = path.join(base, 'ledger');
  if (spec.parentIsAFile) {
    // The ledger's parent is a regular file, so nothing can be created underneath it.
    const blocker = path.join(base, 'blocked');
    await writeFile(blocker, 'x', 'utf8');
    return path.join(blocker, 'ledger');
  }
  if (spec.kind === 'symlink') {
    const target = path.join(base, 'target');
    await mkdir(target, { recursive: true });
    await symlink(target, ledger, 'dir');
    return ledger;
  }
  if (spec.kind === 'file') {
    await writeFile(ledger, 'not a directory', 'utf8');
    return ledger;
  }
  if (spec.kind === 'markers') {
    await mkdir(ledger, { recursive: true, mode: 0o700 });
    for (const marker of markerNames.slice(0, spec.count)) {
      await writeFile(path.join(ledger, marker), '1\\n', 'utf8');
    }
    return ledger;
  }
  if (spec.kind === 'worldReadable') {
    await mkdir(ledger, { recursive: true });
    if (process.platform !== 'win32') await chmod(ledger, 0o755);
    return ledger;
  }
  return ledger;
}

const config = {};
for (const [name, env] of Object.entries(input.config)) {
  config[name] = lib.budgetConfigRefusals({ env });
}

const ledger = {};
for (const [name, spec] of Object.entries(input.planted)) {
  const at = await plant(name, spec);
  const result = await lib.ledgerRefusals({ ledger: at });
  const survivors = (await readdir(at).catch(() => [])).sort();
  // The bytes, not just the names: a marker whose file still exists but whose contents were
  // replaced is a refunded request wearing a spent request's name, and a directory listing
  // cannot tell the two apart.
  const contents = await Promise.all(
    survivors.map(async (entry) => {
      const text = await readFile(path.join(at, entry), 'utf8').catch(() => '<unreadable>');
      return text.trim();
    }),
  );
  ledger[name] = {
    refusals: result.refusals,
    notes: result.notes,
    survivors,
    bytes: contents.join('|'),
  };
}

// The two fake filesystems are the only way to ask what happens when the operating system
// does not do what the reservation needs. A real host cannot be made to ignore O_EXCL on
// demand, and a real Windows host cannot be made to model permission bits on demand, so the
// branches that decide "this ledger cannot be trusted" are exercised against a filesystem
// that behaves exactly as described.
function fakeFilesystem(mode, honorExclusive) {
  const created = new Set();
  const statOf = () => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isFile: () => false,
    mode,
  });
  return {
    names: () => Array.from(created),
    lstat: async (at) => {
      if (!created.has(at)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return statOf();
    },
    mkdir: async (at) => {
      created.add(at);
    },
    writeFile: async (at, text, options) => {
      // Every exclusive write succeeding is what a mount that silently ignores O_EXCL does
      // to two processes racing for the last slot: both of them think they won.
      if (options && options.flag === 'wx' && honorExclusive && created.has(at)) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      created.add(at);
    },
    unlink: async (at) => {
      created.delete(at);
    },
    rmdir: async (at) => {
      created.delete(at);
    },
  };
}

for (const [name, kind] of Object.entries(input.fakes)) {
  const at = path.join(root, 'fake', name, 'ledger');
  const fs =
    kind === 'ignoresExclusive'
      ? fakeFilesystem(0o700, false)
      : fakeFilesystem(0o777, true);
  const result = await lib.ledgerRefusals({ ledger: at, fs });
  ledger[name] = {
    refusals: result.refusals,
    notes: result.notes,
    survivors: fs.names(),
    bytes: '',
  };
}

const childEnv = {};
for (const [name, spec] of Object.entries(input.childEnv)) {
  childEnv[name] = Object.keys(lib.liveChildEnv({ env: spec.env, publicGit: spec.publicGit })).sort();
}

await rm(root, { recursive: true, force: true });

process.stdout.write(
  JSON.stringify({
    ceiling: rules.MAX_MODEL_COMPLETIONS,
    config,
    ledger,
    childEnv,
    markerNames,
  }),
);
`;

let harness: HarnessOutput;
let scratch = '';
let harnessMs = 0;

const CONFIG_CASES: Record<string, Record<string, string | undefined>> = {};

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'mergesutra-livebudget-spec-'));
  const runnerTemp = path.join(scratch, 'runner-temp');
  const ledger = path.join(runnerTemp, 'ledger');
  const payload = path.join(scratch, 'cases.json');

  // A synthetic key of the right shape: this file never reads a real credential, and the
  // gate under test refuses before any request could be built from it.
  const baseLive = {
    BHARATCODE_API_KEY: 'synthetic-value-not-a-real-credential',
    BHARATCODE_MODEL: 'qwen-3.8-27b',
    BHARATCODE_MAX_RETRIES: '0',
    BHARATCODE_MAX_COMPLETION_REQUESTS: '12',
    BHARATCODE_REQUEST_LEDGER: ledger,
  };
  const hostedLive = {
    ...baseLive,
    GITHUB_ACTIONS: 'true',
    RUNNER_TEMP: runnerTemp,
    GITHUB_RUN_ATTEMPT: '1',
  };
  Object.assign(CONFIG_CASES, {
    healthy: hostedLive,
    'no-budget-at-all': {
      ...baseLive,
      BHARATCODE_MAX_COMPLETION_REQUESTS: undefined,
      BHARATCODE_REQUEST_LEDGER: undefined,
    },
    'ceiling-only': { ...baseLive, BHARATCODE_REQUEST_LEDGER: undefined },
    'ledger-only': { ...baseLive, BHARATCODE_MAX_COMPLETION_REQUESTS: undefined },
    'ceiling-above-the-chain': { ...hostedLive, BHARATCODE_MAX_COMPLETION_REQUESTS: '13' },
    'ceiling-below-the-chain': { ...hostedLive, BHARATCODE_MAX_COMPLETION_REQUESTS: '11' },
    'ceiling-not-a-number': { ...hostedLive, BHARATCODE_MAX_COMPLETION_REQUESTS: 'twelve' },
    'ledger-relative': { ...hostedLive, BHARATCODE_REQUEST_LEDGER: 'ledger/relative' },
    'retries-enabled': { ...hostedLive, BHARATCODE_MAX_RETRIES: '3' },
    'retries-unset': { ...hostedLive, BHARATCODE_MAX_RETRIES: undefined },
    'rerun-attempt-2': { ...hostedLive, GITHUB_RUN_ATTEMPT: '2' },
    'rerun-attempt-3': { ...hostedLive, GITHUB_RUN_ATTEMPT: '3' },
    'hosted-attempt-unset': { ...hostedLive, GITHUB_RUN_ATTEMPT: undefined },
    'hosted-without-runner-temp': { ...hostedLive, RUNNER_TEMP: undefined },
    'ledger-outside-runner-temp': {
      ...hostedLive,
      BHARATCODE_REQUEST_LEDGER: path.join(scratch, 'elsewhere', 'ledger'),
    },
    'local-operator-no-github': baseLive,
  });

  const startedAt = Date.now();
  await writeFile(
    payload,
    JSON.stringify({
      config: CONFIG_CASES,
      planted: {
        fresh: { kind: 'absent' },
        symlink: { kind: 'symlink' },
        'regular-file': { kind: 'file' },
        'parent-blocked': { parentIsAFile: true },
        'already-spent': { kind: 'markers', count: 12 },
        'partly-spent': { kind: 'markers', count: 3 },
        'world-readable': { kind: 'worldReadable' },
      },
      fakes: {
        'ignores-exclusive-create': 'ignoresExclusive',
        'ignores-permission-bits': 'ignoresModes',
      },
      childEnv: {
        live: { env: { ...hostedLive, GH_TOKEN: 'x' }, publicGit: false },
        publicGit: { env: { ...hostedLive, GH_TOKEN: 'x' }, publicGit: true },
      },
    }),
    'utf8',
  );
  const { stdout } = await runChild(
    process.execPath,
    ['--input-type=module', '-e', HARNESS, payload, LIB, QUALIFICATION_LIB],
    { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 32 * 1024 * 1024 },
  );
  harnessMs = Date.now() - startedAt;
  harness = JSON.parse(stdout) as HarnessOutput;
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

const refusals = (name: string): string[] => {
  const recorded = harness.config[name];
  if (!recorded) throw new Error(`the harness recorded no configuration case named ${name}`);
  return recorded;
};

const ledgerCase = (name: string): LedgerResult => {
  const recorded = harness.ledger[name];
  if (!recorded) throw new Error(`the harness recorded no ledger case named ${name}`);
  return recorded;
};

const joined = (lines: string[]): string => lines.join('\n');

describe('the live chain budget configuration', () => {
  it('answers the whole matrix from one real Node process, inside the hook budget', () => {
    expect(Object.keys(harness.config)).toHaveLength(Object.keys(CONFIG_CASES).length);
    expect(harnessMs).toBeLessThan(25_000);
  });

  it('accepts a hosted live step that pins the chain ceiling to a private first-attempt ledger', () => {
    // The control the rest of this file needs: a configuration this gate must not refuse, so
    // that a refusal swept into every case cannot read as a passing guard.
    expect(refusals('healthy')).toEqual([]);
    expect(harness.ceiling).toBe(12);
  });

  it('refuses a live chain that never installed a ceiling at all', () => {
    expect(refusals('no-budget-at-all')).toHaveLength(1);
    // Each half-configured case names its own defect, and no case is answered by a message
    // that would fit all three. An operator who pinned the number and forgot the directory has
    // to be told which of the two they forgot; a refusal that merely recites both variable
    // names would be satisfied by returning that same sentence for every case, which is what
    // the exclusions below refuse to allow.
    expect(joined(refusals('no-budget-at-all'))).toContain('requires both');
    expect(joined(refusals('no-budget-at-all'))).not.toMatch(/nothing would be counted/);
    expect(joined(refusals('no-budget-at-all'))).not.toMatch(/nowhere to count/);
  });

  it('refuses a ceiling with nowhere to count, and a ledger with no ceiling', () => {
    // `ceiling-only` is the number without the directory — a promise nothing can enforce — and
    // `ledger-only` is the directory without the number, which counts up to nothing.
    expect(refusals('ceiling-only')).toHaveLength(1);
    expect(refusals('ledger-only')).toHaveLength(1);
    expect(joined(refusals('ceiling-only'))).toContain('nowhere to count');
    expect(joined(refusals('ceiling-only'))).not.toMatch(/nothing would be counted/);
    expect(joined(refusals('ledger-only'))).toContain('nothing would be counted');
    expect(joined(refusals('ledger-only'))).not.toMatch(/nowhere to count/);
  });

  it('refuses a ceiling that is not the number the chain is qualified against', () => {
    // The pre-request ceiling and `MAX_MODEL_COMPLETIONS` are one promise read two ways: the
    // guard stops the thirteenth request, the qualification rule fails a run that observed
    // one. A workflow pinning 13 while the rules still measure 12 would produce a run that
    // spent past its own stated budget and still reported qualified.
    for (const name of [
      'ceiling-above-the-chain',
      'ceiling-below-the-chain',
      'ceiling-not-a-number',
    ]) {
      const refusal = joined(refusals(name));
      expect(refusal, `${name} is not the chain ceiling`).toContain('12');
      expect(refusal, `${name} is not the chain ceiling`).toMatch(/ceiling/i);
    }
  });

  it('refuses a ledger path that is not absolute', () => {
    // A relative ledger resolves against each child's working directory, and the live chain
    // runs stages from the repository root and an implementation from a worktree: two
    // counters, neither of them a ceiling.
    expect(joined(refusals('ledger-relative'))).toMatch(/absolute/i);
  });

  it('refuses a live chain that may retry a completion', () => {
    // One `complete()` is `maxRetries + 1` POSTs. The ceiling still holds — every attempt
    // pays — but the live job's promise is that a busy provider is not answered by sending
    // again, and a chain that retried would spend the run's allowance on attempts nobody
    // asked for.
    expect(joined(refusals('retries-enabled'))).toContain('BHARATCODE_MAX_RETRIES');
    expect(joined(refusals('retries-unset'))).toContain('BHARATCODE_MAX_RETRIES');
  });

  it('refuses a hosted re-run, because its ledger is a fresh empty directory', () => {
    // `GITHUB_RUN_ID` is kept across re-runs; the ephemeral runner's temporary directory is
    // not. A re-run would therefore start from a count of zero and spend twelve more requests
    // under the same run the operator already watched stop.
    for (const name of ['rerun-attempt-2', 'rerun-attempt-3', 'hosted-attempt-unset']) {
      const refusal = joined(refusals(name));
      expect(refusal, `${name} is a re-run`).toContain('GITHUB_RUN_ATTEMPT');
      expect(refusal, `${name} is a re-run`).toMatch(/attempt/i);
    }
  });

  it('refuses a hosted ledger that is not inside the runner’s own temporary directory', () => {
    expect(joined(refusals('hosted-without-runner-temp'))).toContain('RUNNER_TEMP');
    expect(joined(refusals('ledger-outside-runner-temp'))).toContain('RUNNER_TEMP');
  });

  it('leaves an operator running the chain locally without GitHub Actions alone', () => {
    // The placement and attempt rules are properties of a hosted run. Refusing them locally
    // would refuse the only way a person can re-run this procedure by hand, and the ceiling
    // itself is still enforced by the checks that do not depend on a runner.
    expect(refusals('local-operator-no-github')).toEqual([]);
  });
});

describe('the live chain ledger directory', () => {
  it('creates a missing ledger and reports nothing to refuse', () => {
    expect(ledgerCase('fresh').refusals).toEqual([]);
  });

  it('refuses a ledger path that is a symbolic link', () => {
    // Whoever owns the link owns where the count lives: repointing it mid-run moves the
    // ceiling to a directory the guard is not looking at.
    expect(joined(ledgerCase('symlink').refusals)).toMatch(/symbolic link/i);
  });

  it('refuses a ledger path that is a regular file', () => {
    expect(joined(ledgerCase('regular-file').refusals)).toMatch(/directory/i);
  });

  it('refuses a ledger that cannot be created', () => {
    expect(joined(ledgerCase('parent-blocked').refusals)).toMatch(/created/i);
  });

  it('refuses a ledger whose exclusive creation the filesystem does not honour', () => {
    // The reservation is one `O_CREAT | O_EXCL` write and the whole ceiling rests on the
    // second writer losing. A mount that ignores `O_EXCL` turns two racing requests into two
    // accepted ones, so the preflight writes one throwaway name twice and stops if the
    // filesystem says it cannot lose.
    expect(joined(ledgerCase('ignores-exclusive-create').refusals)).toMatch(/exclusive/i);
  });

  it('refuses a pre-existing ledger that group or other can read or write', () => {
    const result = ledgerCase('world-readable');
    if (process.platform === 'win32') {
      // Measured on this host: a directory created with mode 0o700 reports 0o666, so the
      // mode field carries no information here and the check says it was inert rather than
      // pretending to have passed.
      expect(result.refusals).toEqual([]);
      expect(joined(result.notes)).toMatch(/permission/i);
    } else {
      expect(joined(result.refusals)).toMatch(/group|other/);
    }
  });

  it('does not treat a filesystem that cannot model permission bits as a refusal', () => {
    // Refusing here would reject every legitimate run on a host whose mode field is a
    // constant, and would do it while claiming the ledger was unsafe.
    const result = ledgerCase('ignores-permission-bits');
    expect(result.refusals).toEqual([]);
    expect(joined(result.notes)).toMatch(/permission/i);
  });

  it('leaves every reservation marker it finds in place', () => {
    // The preflight is the one thing that runs before the first request, and it must never
    // be a way to empty the count. Both directions are pinned: a marker that vanished is a
    // refunded request, and a probe file left behind is the preflight writing into a ledger
    // it only means to read.
    expect(ledgerCase('already-spent').survivors).toEqual(harness.markerNames);
    expect(ledgerCase('already-spent').refusals).toEqual([]);
    expect(ledgerCase('partly-spent').survivors).toEqual(harness.markerNames.slice(0, 3));
    expect(ledgerCase('fresh').survivors).toEqual([]);
    // The names alone would still match if the probe had been written *over* a marker: the
    // preflight would delete `completion-0001`, claim the name for itself, and leave a file
    // with that name behind — one request refunded while the listing looks untouched. The
    // planted bytes are what a spent slot is, so they are what has to survive.
    const spentBytes = harness.markerNames.map(() => '1').join('|');
    expect(ledgerCase('already-spent').bytes).toBe(spentBytes);
    expect(ledgerCase('partly-spent').bytes).toBe(
      harness.markerNames
        .slice(0, 3)
        .map(() => '1')
        .join('|'),
    );
  });

  it('proves the marker names it protects are the names the reservation actually writes', async () => {
    // Without this, the survival check above could be guarding a spelling no code produces.
    // `reserveCompletion` is the producer; its bytes are the contract.
    const ledger = path.join(scratch, 'real-markers');
    await reserveCompletion({ limit: 4, ledgerDirectory: ledger });
    await reserveCompletion({ limit: 4, ledgerDirectory: ledger });
    expect((await readdir(ledger)).sort()).toEqual(harness.markerNames.slice(0, 2));
  });
});

describe('the environment handed to every live child', () => {
  it('keeps the budget pair and strips the credential from repository-facing children', () => {
    // The count is only a ceiling if the process that sends the request can see it. Every
    // stage runs as its own child of this driver, so the pair has to ride along with all of
    // them — including the repository-facing children that must not carry the key.
    expect(harness.childEnv.live).toContain('BHARATCODE_REQUEST_LEDGER');
    expect(harness.childEnv.live).toContain('BHARATCODE_MAX_COMPLETION_REQUESTS');
    expect(harness.childEnv.live).toContain('BHARATCODE_API_KEY');
    expect(harness.childEnv.publicGit).toContain('BHARATCODE_REQUEST_LEDGER');
    expect(harness.childEnv.publicGit).toContain('BHARATCODE_MAX_COMPLETION_REQUESTS');
    expect(harness.childEnv.publicGit).not.toContain('BHARATCODE_API_KEY');
    expect(harness.childEnv.publicGit).not.toContain('BHARATCODE_MODEL');
    expect(harness.childEnv.publicGit).not.toContain('GH_TOKEN');
  });
});
