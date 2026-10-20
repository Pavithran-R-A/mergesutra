import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'publication-bundle.mjs');
const PUBLISH_LIB = path.join(ROOT, 'scripts', 'lib', 'publication-publish.mjs');

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error: string | null;
}

// The bundle is the only thing a later, write-scoped publication action is given, so
// these cases exercise the shipped module in a real Node process against real files:
// a page can only be reconstructed from bytes whose hashes still match, a path can
// only leave the workspace by being refused, and the runner may not reach the
// transport after a refusal. Running the cases in one child keeps the suite inside
// the documented hook budget while still using the module the script ships.
const HARNESS = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [libPath, publishLibPath] = process.argv.slice(2);
const lib = await import(pathToFileURL(libPath).href);
const publishLib = await import(pathToFileURL(publishLibPath).href);
const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-bundle-rules-'));
const out = [];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX64 = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const BASE = '1'.repeat(40);

function caseRun(name, fn) {
  return (async () => {
    try {
      await fn();
      out.push({ name, ok: true, error: null });
    } catch (error) {
      out.push({ name, ok: false, error: String(error && error.message ? error.message : error).slice(0, 400) });
    }
  })();
}

async function fixture(name) {
  const dir = path.join(root, name);
  const workspace = path.join(dir, 'workspace');
  const target = path.join(dir, 'target');
  const bundleDir = path.join(dir, 'bundle');
  const storeRoot = path.join(dir, 'store');
  await mkdir(workspace, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(workspace, 'check.mjs'), 'export const answer = 42;\n');
  await writeFile(path.join(workspace, 'new.js'), 'console.log("added");\n');
  await writeFile(path.join(target, 'check.mjs'), 'export const answer = 0;\n');
  await writeFile(path.join(target, 'old.txt'), 'remove me\n');
  return { dir, workspace, target, bundleDir, storeRoot };
}

function inputs(f, overrides = {}) {
  const check = overrides.check ?? 'export const answer = 42;\n';
  const added = overrides.added ?? 'console.log("added");\n';
  const patchIdentity = overrides.patchIdentity ?? HEX64;
  const publicationDigest = overrides.publicationDigest ?? HEX64_B;
  const runId = overrides.runId ?? 'run-20261020T000000Z-aaaaaa';
  const repository = overrides.repository ?? 'Pavithran-R-A/mergesutra';
  const candidate = {
    schemaVersion: 1,
    runId,
    repository,
    baseSha: BASE,
    patchIdentity,
    targetBranch: 'main',
    proposedBranch: 'mergesutra/' + runId,
    prTitle: 'Fix the fixture',
    prBody: 'A body',
    prBodySha256: HEX64,
    evidencePackIdentity: HEX64,
    issueCanonical: null,
    closesIssue: false,
    reviewCycle: 1,
    reviewedPatchIdentity: patchIdentity,
    reviewSummary: 'No findings.',
    verificationSummary: 'PASS',
    knownLimitations: [],
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  const patch = {
    schemaVersion: 1,
    baseSha: BASE,
    identity: patchIdentity,
    files: [
      { path: 'check.mjs', tracked: true, change: 'MODIFIED', contentSha256: sha(Buffer.from(check)) },
      { path: 'new.js', tracked: false, change: 'ADDED', contentSha256: sha(Buffer.from(added)) },
      { path: 'old.txt', tracked: true, change: 'DELETED', contentSha256: null },
    ],
    ...(overrides.patch ?? {}),
  };
  const recordText = JSON.stringify(
    {
      schemaVersion: 9,
      runId,
      stage: 'pr',
      outcome: 'PR_CANDIDATE_RECORDED',
      publications: [{ candidate }],
    },
    null,
    2,
  ) + '\n';
  const packText = {
    'report.json': JSON.stringify({ patch: { plannedIdentity: patchIdentity } }),
    'report.md': 'Patch: ' + patchIdentity + '\n',
    'commands.jsonl': '',
  };
  return {
    runId,
    repository,
    baseSha: BASE,
    targetBranch: 'main',
    proposedBranch: 'mergesutra/' + runId,
    patchIdentity,
    evidencePackIdentity: HEX64,
    publicationDigest,
    candidate,
    patch,
    workspace: f.workspace,
    recordText,
    packText,
    sourceRunUrl: 'https://github.com/Pavithran-R-A/mergesutra/actions/runs/1',
    ...overrides.top,
  };
}

async function written(f, overrides = {}) {
  const bundle = await lib.buildPublicationBundle(inputs(f, overrides));
  await lib.writePublicationBundle(overrides.bundleDir ?? f.bundleDir, bundle);
  return bundle;
}

// 1. The page, record, pack and bytes survive a write/read and reconstruct exactly.
await caseRun('a bundle round-trips and reconstructs the approved bytes', async () => {
  const f = await fixture('round-trip');
  await written(f);
  const bundle = await lib.readPublicationBundle(f.bundleDir);
  assert.equal(bundle.identity.patchIdentity, HEX64);
  assert.equal(bundle.identity.publicationDigest, HEX64_B);
  assert.deepEqual(bundle.identity.changedPaths, ['check.mjs', 'new.js', 'old.txt']);
  assert.deepEqual(bundle.identity.deletedPaths, ['old.txt']);
  lib.assertApprovedDigest(bundle.identity, HEX64_B.toUpperCase());
  await lib.applyPatch(f.target, bundle.patch);
  assert.equal(await readFile(path.join(f.target, 'check.mjs'), 'utf8'), 'export const answer = 42;\n');
  assert.equal(await readFile(path.join(f.target, 'new.js'), 'utf8'), 'console.log("added");\n');
  await assert.rejects(readFile(path.join(f.target, 'old.txt')));
  const staged = await lib.stageRunStore(f.storeRoot, bundle);
  assert.equal(await readFile(path.join(f.storeRoot, bundle.identity.runId + '.json'), 'utf8'), bundle.recordText);
  assert.equal(await readFile(path.join(f.storeRoot, bundle.identity.runId, 'report.md'), 'utf8'), bundle.packText['report.md']);
  assert.ok(staged.record.endsWith(bundle.identity.runId + '.json'));
});

// 2. A digest that is not the page is not a yes for anything.
await caseRun('refuses an approval for another page', async () => {
  const f = await fixture('wrong-approval');
  await written(f);
  const bundle = await lib.readPublicationBundle(f.bundleDir);
  assert.throws(() => lib.assertApprovedDigest(bundle.identity, 'c'.repeat(64)), /different candidate|digest/i);
  assert.throws(() => lib.assertApprovedDigest(bundle.identity, 'not-a-digest'), /64-character|digest/i);
});

// 3. Path traversal, absolute paths and MergeSutra's own scratch never reach disk.
for (const [name, badPath] of [
  ['refuses parent traversal', '../outside.txt'],
  ['refuses an absolute path', '/etc/escape.txt'],
  ['refuses a Windows absolute path', 'C:/escape.txt'],
  ['refuses MergeSutra scratch', '.mergesutra/runs/x'],
  ['refuses a nested scratch path', 'src/.mergesutra/x'],
]) {
  await caseRun(name, async () => {
    const f = await fixture('path-' + name.replaceAll(' ', '-'));
    await assert.rejects(
      lib.buildPublicationBundle(
        inputs(f, {
          patch: {
            files: [{ path: badPath, tracked: true, change: 'MODIFIED', contentSha256: HEX64 }],
          },
        }),
      ),
      /path/i,
    );
  });
}

// 4. A byte that moved after the bundle was built cannot be reconstructed.
await caseRun('refuses a file whose bytes do not match the recorded hash', async () => {
  const f = await fixture('hash-mismatch');
  await assert.rejects(
    lib.buildPublicationBundle(
      inputs(f, {
        patch: {
          files: [{ path: 'check.mjs', tracked: true, change: 'MODIFIED', contentSha256: HEX64 }],
        },
      }),
    ),
    /hash|content/i,
  );
});

// 5. An artifact cannot swap the candidate for a different patch.
await caseRun('refuses a candidate that names another patch', async () => {
  const f = await fixture('candidate-link');
  const input = inputs(f);
  input.candidate = { ...input.candidate, patchIdentity: 'd'.repeat(64) };
  await assert.rejects(lib.buildPublicationBundle(input), /patchIdentity|patch identity|same patch/i);
});

// 6. Overwriting a different record in the store is a rewrite, not a staging step.
await caseRun('refuses to overwrite a different run record', async () => {
  const f = await fixture('record-clash');
  const bundle = await written(f);
  await mkdir(f.storeRoot, { recursive: true });
  await writeFile(path.join(f.storeRoot, bundle.identity.runId + '.json'), '{"other":true}\n');
  await assert.rejects(lib.stageRunStore(f.storeRoot, bundle), /different|overwrite|record/i);
});

// 7. A deletion the base tree does not contain is a reconstruction that lies.
await caseRun('refuses to delete a file the base tree does not contain', async () => {
  const f = await fixture('missing-deletion');
  const bundle = await written(f);
  await rm(path.join(f.target, 'old.txt'));
  await assert.rejects(lib.applyPatch(f.target, bundle.patch), /delete|missing|exist/i);
});

// 8. The publication runner refuses before the transport when the reconstruction moved.
function fakePublish(payload) {
  return async () => {
    return {
      exitCode: 0,
      stdout: JSON.stringify(payload ?? {
        outcome: 'PR_DRAFT_OPENED',
        published: true,
        publication: {
          draft: true,
          url: 'https://github.com/Pavithran-R-A/mergesutra/pull/45',
          number: 45,
          branch: 'mergesutra/run-20261020T000000Z-aaaaaa',
          commitSha: 'e'.repeat(40),
        },
        recordFile: 'record.json',
      }),
      stderr: '',
    };
  };
}

async function runWithFakes(name, { measuredIdentity, publish, approval } = {}) {
  const f = await fixture(name);
  const bundle = await written(f, { bundleDir: path.join(f.dir, 'bundle') });
  const workRoot = path.join(f.dir, 'work');
  const worktreeDir = path.join(workRoot, 'repository', '.mergesutra', 'worktrees', bundle.identity.runId);
  const calls = [];
  const transport = async () => {
    calls.push('publish');
    return (publish ?? fakePublish())();
  };
  const result = await publishLib.runPublication({
    bundleDir: f.bundleDir,
    approval: approval ?? bundle.identity.publicationDigest,
    rootDir: f.dir,
    workRoot,
    deps: {
      prepareWorktree: async () => {
        await mkdir(path.join(worktreeDir, '..'), { recursive: true });
        await mkdir(worktreeDir, { recursive: true });
        await writeFile(path.join(worktreeDir, 'old.txt'), 'remove me\n');
        calls.push('prepare');
        return { repositoryDir: path.join(workRoot, 'repository'), worktreeDir };
      },
      measure: async () => {
        calls.push('measure');
        return { identity: measuredIdentity ?? bundle.patch.identity, files: bundle.patch.files };
      },
      publish: transport,
    },
  });
  return { result, calls, f, bundle };
}

await caseRun('publishes only after an unchanged reconstruction and a matching yes', async () => {
  const { result, calls, f, bundle } = await runWithFakes('runner-happy', {});
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.url, 'https://github.com/Pavithran-R-A/mergesutra/pull/45');
  assert.deepEqual(calls, ['prepare', 'measure', 'publish']);
  assert.equal(await readFile(path.join(f.dir, '.mergesutra', 'runs', bundle.identity.runId + '.json'), 'utf8'), bundle.recordText);
});

await caseRun('refuses after a moved patch and never calls the transport', async () => {
  const { result, calls } = await runWithFakes('runner-moved', { measuredIdentity: 'f'.repeat(64) });
  assert.equal(result.status, 'REFUSED');
  assert.ok(!calls.includes('publish'), 'transport was called after a refused reconstruction');
  assert.match(result.reason, /patch/i);
});

await caseRun('refuses a wrong approval and never calls the transport', async () => {
  const { result, calls } = await runWithFakes('runner-wrong-approval', { approval: 'c'.repeat(64) });
  assert.equal(result.status, 'REFUSED');
  assert.ok(!calls.includes('publish'), 'transport was called without a matching approval');
});

await caseRun('reports failure when the CLI did not open a draft', async () => {
  const { result, calls } = await runWithFakes('runner-not-opened', {
    publish: fakePublish({
      outcome: 'PR_PUBLICATION_BLOCKED',
      published: false,
      publication: null,
      recordFile: null,
    }),
  });
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(calls, ['prepare', 'measure', 'publish']);
});

await caseRun('reports the product refusal as a refusal, not a failure', async () => {
  const { result } = await runWithFakes('runner-cli-refused', {
    publish: async () => ({ exitCode: 3, stdout: '', stderr: 'the page moved' }),
  });
  assert.equal(result.status, 'REFUSED');
});

await caseRun('reports failure when GitHub did not mark the page a draft', async () => {
  const { result } = await runWithFakes('runner-not-draft', {
    publish: fakePublish({
      outcome: 'PR_DRAFT_OPENED',
      published: true,
      publication: {
        draft: false,
        url: 'https://github.com/Pavithran-R-A/mergesutra/pull/46',
        number: 46,
      },
      recordFile: null,
    }),
  });
  assert.equal(result.status, 'FAILED');
});

process.stdout.write(JSON.stringify(out) + '\n');
try { await rm(root, { recursive: true, force: true }); } catch {}
`;

let harnessDir = '';
let results: CaseResult[] = [];
let stderr = '';

beforeAll(async () => {
  harnessDir = await mkdtemp(path.join(tmpdir(), 'mergesutra-bundle-harness-'));
  const file = path.join(harnessDir, 'harness.mjs');
  await writeFile(file, HARNESS, 'utf8');
  const run = spawnSync(process.execPath, [file, LIB, PUBLISH_LIB], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  stderr = `${run.stderr ?? ''}`;
  try {
    results = JSON.parse((run.stdout ?? '').trim());
  } catch {
    results = [];
  }
});

afterAll(async () => {
  if (harnessDir) await rm(harnessDir, { recursive: true, force: true });
});

describe('the portable publication bundle', () => {
  it('ran every case in a real Node process', () => {
    expect(results.length, stderr).toBeGreaterThanOrEqual(13);
  });

  it('holds every case', () => {
    const failed = results.filter((entry) => !entry.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });

  it('names the refusal cases, not only the happy path', () => {
    const names = results.map((entry) => entry.name).join('\n');
    for (const phrase of [
      'refuses parent traversal',
      'refuses an absolute path',
      'refuses MergeSutra scratch',
      'refuses a candidate that names another patch',
      'refuses to overwrite a different run record',
      'never calls the transport',
    ]) {
      expect(names).toContain(phrase);
    }
  });
});
