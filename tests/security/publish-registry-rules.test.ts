import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * F05 — the release script must not read a registry failure as an absent version,
 * and must not call a publication verified without a commit identity.
 *
 * `scripts/publish-or-verify.mjs` used to return `null` from its `npm view` helper
 * for every non-zero exit, so an auth, network or registry failure was
 * indistinguishable from "this version is not published yet": the preflight would
 * proceed to publish, and the post-publish poll would retry five times and blame
 * propagation. Its verification also accepted metadata with no `gitHead`, so a
 * version whose bytes could not be tied to the release commit still printed
 * "Registry verified".
 *
 * The commit-tie rule was then over-corrected, and this suite also holds the repair
 * of that (round 2026-10-29, F07): `npm publish` does not write `gitHead` into the
 * manifest it sends — npm 11's `libnpmpublish` normalizes with `steps: ['fixName']`,
 * and `@npmcli/package-json` only produces `gitHead` when its steps name `gitHead` —
 * so a mandatory `gitHead` rejects a version this very script published correctly,
 * which made the release gate unable to go green for real. A version the registry
 * reports is now verified whether or not it carries a commit; a `gitHead` that *is*
 * present is still checked as a full lowercase 40-hex commit equal to the release
 * commit, and when there is none the script says so instead of claiming a tie.
 * Absence of the field never authorizes a write, so the fail-closed property that
 * F05 was about is preserved.
 *
 * The decisions now live in `scripts/lib/publish-registry.mjs`, which this suite
 * drives in a real Node process against scripted `npm` results. The shipped script
 * is checked for delegating to it rather than keeping a second copy of the rules.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'publish-registry.mjs');
const SCRIPT = path.join(ROOT, 'scripts', 'publish-or-verify.mjs');

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error: string | null;
}

const HARNESS = String.raw`
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [libPath] = process.argv.slice(2);
const lib = await import(pathToFileURL(libPath).href);
const out = [];
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function run(name, fn) {
  try {
    fn();
    out.push({ name, ok: true, error: null });
  } catch (error) {
    out.push({ name, ok: false, error: String(error && error.message ? error.message : error).slice(0, 400) });
  }
}

function meta(overrides = {}) {
  return { version: '0.2.0', gitHead: HEAD, ...overrides };
}

const EXPECT = { version: '0.2.0', head: HEAD };

function viewOk(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' };
}

function viewE404(spelling = 'error') {
  const prefix = spelling === 'error' ? 'npm error' : 'npm ERR!';
  return {
    status: 1,
    stdout: '',
    stderr:
      prefix + ' code E404\n' +
      'npm error 404 Not Found - GET https://registry.npmjs.org/mergesutra - Not found\n' +
      'npm error 404\n',
  };
}

function viewFail(code, detail = 'some failure') {
  return { status: 1, stdout: '', stderr: 'npm error code ' + code + '\nnpm error ' + detail + '\n' };
}

const PUBLISH_OK = { status: 0, stdout: '', stderr: '' };

function drive(responses, overrides = {}) {
  const calls = [];
  const printed = [];
  const refused = [];
  let waits = 0;
  let index = 0;
  const npm = (args, options = {}) => {
    calls.push({ args: [...args], inherit: options.inherit === true });
    if (index >= responses.length) throw new Error('unexpected npm call: ' + args.join(' '));
    return responses[index++];
  };
  const code = lib.publishOrVerify({
    spec: 'mergesutra@0.2.0',
    version: '0.2.0',
    head: HEAD,
    npm,
    out: (text) => printed.push(text),
    err: (text) => refused.push(text),
    wait: () => {
      waits += 1;
    },
    ...overrides,
  });
  return { code, calls, printed: printed.join(''), refused: refused.join(''), waits };
}

function kinds(result) {
  assert.ok(result && typeof result === 'object', 'the outcome must be a tagged object');
  return result;
}

// --- classification: only npm's own E404 may mean "absent" -------------------

run('treats only npm code E404 as absence, in both npm spellings', () => {
  assert.deepEqual(kinds(lib.classifyViewOutcome(viewE404('error'))), { kind: 'absent' });
  assert.deepEqual(kinds(lib.classifyViewOutcome(viewE404('ERR!'))), { kind: 'absent' });
});

run('does not read a bare 404 line as absence, because it may be a proxy error', () => {
  const result = kinds(
    lib.classifyViewOutcome({
      status: 1,
      stdout: '',
      stderr: 'npm error 404 Not Found - GET https://registry.npmjs.org/mergesutra\n',
    }),
  );
  assert.equal(result.kind, 'error');
});

run('does not read the E404 token inside other text as absence', () => {
  const result = kinds(
    lib.classifyViewOutcome({
      status: 1,
      stdout: '',
      stderr:
        'npm error code E404 Unable to do authenticated request as it is invalid\n' +
        'npm error Failed to perform query string parse\n',
    }),
  );
  assert.equal(result.kind, 'error');
  assert.match(result.reason, /401 Unauthorized|Unable to do authenticated request/);
});

run('does not read a registry error as absence', () => {
  for (const code of ['E500', 'E401', 'E403', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']) {
    const result = kinds(lib.classifyViewOutcome(viewFail(code)));
    assert.equal(result.kind, 'error', code + ' must not be absence');
  }
});

run('does not read a spawn failure as absence', () => {
  const result = kinds(
    lib.classifyViewOutcome({ status: null, stdout: '', stderr: '', error: new Error('spawn npm ENOENT') }),
  );
  assert.equal(result.kind, 'error');
  assert.match(result.reason, /ENOENT/);
});

run('does not read a killed npm as absence even when it flushed the E404 line', () => {
  // Absence has to mean a read npm itself answered. A process killed after writing its
  // status line reports no exit status at all, so the transcript is a partial write, and
  // calling that absence would let the helper publish over a read it never finished.
  const result = kinds(
    lib.classifyViewOutcome({
      status: null,
      stdout: '',
      stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/mergesutra\n',
      error: new Error('npm killed by SIGKILL'),
    }),
  );
  assert.equal(result.kind, 'error', 'a read with no exit status is not version absence');
  assert.match(result.reason, /did not report an exit status/);
});

run('does not read malformed JSON as absence', () => {
  const result = kinds(lib.classifyViewOutcome({ status: 0, stdout: 'not json', stderr: '' }));
  assert.equal(result.kind, 'error');
  assert.match(result.reason, /JSON/i);
});

run('does not read a successful but empty answer as absence', () => {
  // A killed-or-misbehaving npm can exit 0 having printed nothing. Reading that as
  // "no such version" would authorize a publish over a version the read never ruled out.
  for (const stdout of ['', '   ', '\n']) {
    const result = kinds(lib.classifyViewOutcome({ status: 0, stdout, stderr: '' }));
    assert.equal(result.kind, 'error', JSON.stringify(stdout) + ' must not be absence');
    assert.match(result.reason, /JSON/i);
  }
});

run('keeps a successful metadata object intact for verification', () => {
  const result = kinds(lib.classifyViewOutcome(viewOk(meta())));
  assert.equal(result.kind, 'metadata');
  assert.equal(result.metadata.version, '0.2.0');
  assert.equal(result.metadata.gitHead, HEAD);
});

run('bounds the failure text it reports', () => {
  const result = kinds(lib.classifyViewOutcome({ status: 1, stdout: '', stderr: 'x'.repeat(10000) }));
  assert.equal(result.kind, 'error');
  assert.ok(result.reason.length <= 300, 'reported reason was ' + result.reason.length + ' characters');
  assert.ok(result.reason.length > 0, 'a failure must still say something');
});

// --- verification: the version must match; a reported gitHead must be the commit --

run('accepts metadata whose 40-hex gitHead is the release commit', () => {
  assert.deepEqual(lib.verifyRegistryMetadata(meta(), EXPECT), {
    version: '0.2.0',
    gitHead: HEAD,
  });
});

run('accepts a matching version that reports no gitHead, and returns it commit-unbound', () => {
  // This is the answer npm itself gives for a version it published: libnpmpublish
  // normalizes with steps ['fixName'], so no gitHead is ever written for npm publish.
  // Refusing it made the release gate permanently red after a successful publish.
  const verified = lib.verifyRegistryMetadata({ version: '0.2.0' }, EXPECT);
  assert.equal(verified.version, '0.2.0');
  assert.equal(verified.gitHead, undefined);
});

run('refuses a gitHead that is present but not a full lowercase 40-hex commit', () => {
  // A bare /gitHead/ expectation cannot witness the format guard: every fall-through
  // message names gitHead too, so a guard mutated to compare only to HEAD stays green.
  for (const value of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(39) + 'g', 'HEAD', 'a'.repeat(40) + 'a']) {
    assert.throws(
      () => lib.verifyRegistryMetadata(meta({ gitHead: value }), EXPECT),
      /not a full lowercase 40-hex commit/,
      JSON.stringify(value),
    );
  }
});

run('refuses an empty gitHead, because a present field naming no commit is a bad claim', () => {
  assert.throws(() => lib.verifyRegistryMetadata(meta({ gitHead: '' }), EXPECT), /not a full lowercase 40-hex commit/);
});

run('refuses a null gitHead, which is a present field naming no commit', () => {
  assert.throws(() => lib.verifyRegistryMetadata(meta({ gitHead: null }), EXPECT), /not a full lowercase 40-hex commit/);
});

run('refuses a gitHead wrapped in a one-element array, because only a string can name a commit', () => {
  // Without the string check the regex would coerce this body to the release commit and the
  // refusal would fall through to the commit-equality comparison, which compares strings.
  assert.throws(
    () => lib.verifyRegistryMetadata(meta({ gitHead: [HEAD] }), EXPECT),
    /not a full lowercase 40-hex commit/,
  );
});

run('refuses an uppercase gitHead, because git and the registry record lowercase', () => {
  assert.throws(
    () => lib.verifyRegistryMetadata(meta({ gitHead: 'A'.repeat(40) }), EXPECT),
    /not a full lowercase 40-hex commit/,
  );
});

run('refuses a gitHead from another commit', () => {
  assert.throws(
    () => lib.verifyRegistryMetadata(meta({ gitHead: OTHER }), EXPECT),
    /does not match/,
  );
});

run('refuses a version mismatch', () => {
  assert.throws(
    () => lib.verifyRegistryMetadata(meta({ version: '0.1.0' }), EXPECT),
    /version mismatch/,
  );
});

run('accepts the bare version string npm prints when it has no gitHead to report', () => {
  // 'npm view mergesutra@0.2.0 version gitHead --json' answers "0.2.0", not an object,
  // when the registry holds no gitHead for that version — measured against npm 11.
  assert.throws(() => lib.verifyRegistryMetadata('0.9.9', EXPECT), /version mismatch/);
  const verified = lib.verifyRegistryMetadata('0.2.0', EXPECT);
  assert.equal(verified.version, '0.2.0');
  assert.equal(verified.gitHead, undefined);
});

run('refuses a null or array body as the version mismatch it is', () => {
  assert.throws(() => lib.verifyRegistryMetadata(null, EXPECT), /version mismatch/);
  assert.throws(() => lib.verifyRegistryMetadata([meta()], EXPECT), /version mismatch/);
});

// --- the release orchestration ---------------------------------------------

run('publishes only after the registry says the version is absent', () => {
  const result = drive([viewE404(), PUBLISH_OK, viewOk(meta())]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map((call) => call.args[0]), ['view', 'publish', 'view']);
  // The read has to ask for the fields the rules decide on; a query narrowed to the
  // spec alone would return the whole packument and the version check would read luck.
  assert.deepEqual(result.calls[0].args, ['view', 'mergesutra@0.2.0', 'version', 'gitHead', '--json']);
  assert.deepEqual(result.calls[1].args, ['publish', '--access', 'public']);
  assert.equal(result.calls[1].inherit, true);
  assert.match(result.printed, /Registry verified: mergesutra@0\.2\.0 at a{40}/);
});

run('refuses to publish when the preflight read fails', () => {
  const result = drive([viewFail('E500')]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.doesNotMatch(result.printed, /Publishing/);
  assert.match(result.refused, /could not read|Cannot read/i);
  assert.match(result.refused, /E500/);
});

run('refuses to publish when the preflight read fails without a registry code', () => {
  const result = drive([{ status: null, stdout: '', stderr: '', error: new Error('spawn npm ENOENT') }]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.doesNotMatch(result.printed, /Publishing/);
});

run('refuses to publish when the preflight read flushed an E404 line but never completed', () => {
  const result = drive([
    {
      status: null,
      stdout: '',
      stderr: 'npm error code E404\n',
      error: new Error('npm killed by SIGKILL'),
    },
    PUBLISH_OK,
    viewOk(meta()),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1, 'no write may follow a read that reported no exit status');
  assert.doesNotMatch(result.printed, /Publishing/);
  assert.match(result.refused, /refusing to treat that as version absence/);
});

run('refuses to publish when the registry answers success with no body', () => {
  const result = drive([{ status: 0, stdout: '', stderr: '' }, PUBLISH_OK, viewOk(meta())]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1, 'an empty success names no version, so no write may follow it');
  assert.doesNotMatch(result.printed, /Publishing/);
});

run('verifies a preflight version that reports no gitHead, and says it is not commit-bound', () => {
  const result = drive([viewOk({ version: '0.2.0' })]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map((call) => call.args[0]), ['view']);
  assert.doesNotMatch(result.printed, /Publishing/);
  assert.match(result.printed, /Registry verified: mergesutra@0\.2\.0/);
  assert.match(result.printed, /no gitHead/);
  assert.match(result.printed, new RegExp('not tied to release commit ' + HEAD));
  assert.match(result.printed, /Version, not commit, was proven/);
  assert.match(result.printed, /refusing to republish/i);
});

run('refuses to publish when the preflight gitHead names another commit', () => {
  const result = drive([viewOk(meta({ gitHead: OTHER }))]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.doesNotMatch(result.printed, /Publishing/);
  assert.match(result.refused, new RegExp(OTHER));
});

run('verifies an existing exact version without publishing', () => {
  const result = drive([viewOk(meta())]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map((call) => call.args[0]), ['view']);
  assert.match(result.printed, /refusing to republish/i);
});

run('returns the publish command failure without polling', () => {
  const result = drive([viewE404(), { status: 3, stdout: '', stderr: 'publish failed' }]);
  assert.equal(result.code, 3);
  assert.deepEqual(result.calls.map((call) => call.args[0]), ['view', 'publish']);
});

run('returns failure when the publish command could not start', () => {
  const result = drive([viewE404(), { status: null, stdout: '', stderr: '', error: new Error('spawn npm ENOENT') }]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
});

run('polls past absence after publishing, then verifies', () => {
  const result = drive([viewE404(), PUBLISH_OK, viewE404(), viewE404(), viewOk(meta())]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map((call) => call.args[0]), [
    'view',
    'publish',
    'view',
    'view',
    'view',
  ]);
  assert.equal(result.waits, 2);
  assert.match(result.printed, /Registry verified/);
});

run('retries a failed read after publishing, and reports the reason it read', () => {
  const result = drive([viewE404(), PUBLISH_OK, viewFail('E500'), viewOk(meta())]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map((call) => call.args[0]), ['view', 'publish', 'view', 'view']);
  assert.equal(result.waits, 1);
  assert.match(result.refused, /Read failed: .*E500/);
  assert.match(result.printed, /Registry verified/);
});

run('reports the absent answer it exhausted, not a read failure', () => {
  const result = drive([viewE404(), PUBLISH_OK, viewE404(), viewE404(), viewE404(), viewE404(), viewE404()]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 7);
  assert.equal(result.waits, 4);
  assert.match(result.refused, /was published, but verification did not read it back/);
  assert.match(result.refused, /Last attempt: reported absent/);
  assert.match(result.refused, /verify it rather than publish again/);
});

run('reports the failed read it exhausted, and keeps trying before it does', () => {
  const failures = [viewFail('E500'), viewFail('E500'), viewFail('E500'), viewFail('E500'), viewFail('E500')];
  const result = drive([viewE404(), PUBLISH_OK, ...failures]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 7);
  assert.equal(result.waits, 4);
  assert.match(result.refused, /Last attempt: read failed/);
});

run('verifies after publishing when the registry reports no gitHead', () => {
  // The whole reason this rule exists: npm publish does not record a gitHead, so the
  // first honest post-publish read of a real release answers with the version alone.
  // Refusing it turned a successful publication into a red release gate that no re-run
  // could fix, because the re-run hits the same answer.
  const result = drive([viewE404(), PUBLISH_OK, viewOk({ version: '0.2.0' })]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);
  assert.equal(result.waits, 0);
  assert.match(result.printed, /Registry verified: mergesutra@0\.2\.0/);
  assert.match(result.printed, /no gitHead/);
  assert.doesNotMatch(result.refused, /gitHead/);
});

run('still refuses a post-publish gitHead naming another commit', () => {
  const result = drive([viewE404(), PUBLISH_OK, viewOk(meta({ gitHead: OTHER }))]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 3);
  assert.match(result.refused, new RegExp(OTHER));
});

process.stdout.write(JSON.stringify(out) + '\n');
`;

let harnessDir = '';
let results: CaseResult[] = [];
let stderr = '';

beforeAll(async () => {
  harnessDir = await mkdtemp(path.join(tmpdir(), 'mergesutra-publish-registry-'));
  const file = path.join(harnessDir, 'harness.mjs');
  await writeFile(file, HARNESS, 'utf8');
  const run = spawnSync(process.execPath, [file, LIB], { encoding: 'utf8', timeout: 120_000 });
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

describe('the npm release script reads the registry honestly', () => {
  it('ran every case in a real Node process', () => {
    expect(results.length, stderr).toBe(37);
  });

  it('holds every case', () => {
    const failed = results.filter((entry) => !entry.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });

  it('names the rules that were missing, not only the happy path', () => {
    const names = results.map((entry) => entry.name).join('\n');
    for (const phrase of [
      'treats only npm code E404 as absence',
      'does not read the E404 token inside other text as absence',
      'does not read a killed npm as absence even when it flushed the E404 line',
      'does not read a successful but empty answer as absence',
      'refuses to publish when the registry answers success with no body',
      'accepts a matching version that reports no gitHead, and returns it commit-unbound',
      'refuses a gitHead that is present but not a full lowercase 40-hex commit',
      'refuses a gitHead wrapped in a one-element array, because only a string can name a commit',
      'refuses to publish when the preflight read fails',
      'refuses to publish when the preflight read flushed an E404 line but never completed',
      'retries a failed read after publishing',
      'reports the absent answer it exhausted',
      'verifies after publishing when the registry reports no gitHead',
    ]) {
      expect(names).toContain(phrase);
    }
  });

  it('keeps the shipped script a thin caller of the tested module', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).toContain("from './lib/publish-registry.mjs'");
    expect(source).toContain('publishOrVerify(');
    // A re-inlined rule has to name one of these two tokens whatever it calls its
    // variables, so thinness is proved by the vocabulary, not by one local's spelling.
    expect(source).not.toMatch(/gitHead/);
    expect(source).not.toMatch(/E404/);
    expect(source).not.toMatch(/status\s*!==\s*0\)\s*return null/);
  });
});
