import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleInitialContext, readForModel } from '../../src/implement/context.js';
import { openConfinedReader } from '../../src/security/reader.js';
import { assembleReviewContext } from '../../src/review/context.js';
import { cleanUp, hasGit, recordWith, reviewFixture } from '../helpers/review.js';
import { planTouching } from '../helpers/implement.js';

/**
 * The same policy, seen from every door a model can be handed bytes through —
 * S12-18 §15–§22.
 *
 * A name rule inside `readText` alone would be a boundary that only one command
 * crosses. So each route this build has is driven here with real files on disk:
 * the first context a loop is given, the `READ_FILE` it can ask for afterwards,
 * the search that reads files it never shows, and the two review routes — one
 * that reads a file, one that reads what Git says about it.
 */

const AVAILABLE = await hasGit();

const FAKE_KEY = 'sk-s1218fixture0123456789abcdef';
const MARKER = 'S1218-MARKER-ONLY-HERE';

const PRIVATE_PEM =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU-s1218-fake\n-----END OPENSSH PRIVATE KEY-----\n';
const CERT_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBfake-certificate-s1218-not-a-private-key\n-----END CERTIFICATE-----\n';

const dirs: string[] = [];
const gitDirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs.splice(0, dirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await cleanUp(gitDirs);
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-secret-routes-'));
  dirs.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

const TREE = {
  'src/app.ts': `export const banner = '${MARKER}';\n`,
  'src/example.ts': `// ${MARKER} lives in source too\nexport const x = 1;\n`,
  '.env': `BHARATCODE_API_KEY=${FAKE_KEY}\n`,
  '.npmrc': `//registry.npmjs.org/:_authToken=${FAKE_KEY}\n`,
  _netrc: `machine example.com login someone password ${FAKE_KEY}\n`,
  'notes/deploy-help.txt': `How the deploy key is stored:\n\n${PRIVATE_PEM}`,
  'certs/certificate.pem': CERT_PEM,
};

const LIMITS = { maxContextFiles: 6, maxContextBytes: 48 * 1024 };

describe('the doors into a model prompt', () => {
  it('gives the first context the source it named and a reason for each credential it did not', async () => {
    const reader = await openConfinedReader(await repo(TREE));
    const context = await assembleInitialContext({
      reader,
      files: ['src/app.ts', '.env', 'notes/deploy-help.txt', 'certs/certificate.pem'],
      limits: LIMITS,
    });

    expect(context.files.map((file) => file.relativePath)).toEqual([
      'src/app.ts',
      'certs/certificate.pem',
    ]);
    // A withheld path stays on the page as a withheld path: the model is told the
    // file exists and why its bytes are not coming.
    expect(context.skipped.map((entry) => entry.relativePath)).toEqual([
      '.env',
      'notes/deploy-help.txt',
    ]);
    expect(context.skipped[0]?.reason).toContain('dotenv');
    expect(context.skipped[1]?.reason).toContain('private key');
    expect(context.notYetPresent).toEqual([]);
    const rendered = JSON.stringify(context);
    expect(rendered).not.toContain(FAKE_KEY);
    expect(rendered).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(rendered).not.toContain('_authToken');
    // Budget accounting stays truthful: the bytes counted are the bytes handed over.
    const served = context.files.reduce(
      (total, file) => total + Buffer.byteLength(file.text, 'utf8'),
      0,
    );
    expect(context.bytes).toBe(served);
  });

  it('answers READ_FILE with the class that refused it and never with the value', async () => {
    const reader = await openConfinedReader(await repo(TREE));
    for (const [relative, fragment] of [
      ['.env', 'dotenv'],
      ['.npmrc', 'npm authentication'],
      ['_netrc', 'netrc'],
      ['notes/deploy-help.txt', 'private key'],
    ] as const) {
      const outcome = await readForModel(reader, relative, 4096);
      expect(outcome.ok, relative).toBe(false);
      expect(outcome.detail, relative).toContain(fragment);
      expect(outcome.text, relative).toBeUndefined();
    }
    const readable = await readForModel(reader, 'src/app.ts', 4096);
    expect(readable.ok).toBe(true);
    expect(readable.text).toContain(MARKER);
    expect(readable.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('leaves a credential out of a search answer while returning the same line from source', async () => {
    const reader = await openConfinedReader(await repo(TREE));
    const hits = await reader.search(MARKER);
    expect(hits.hits.map((hit) => hit.relativePath)).toEqual(['src/app.ts', 'src/example.ts']);
    expect(JSON.stringify(hits)).not.toContain(FAKE_KEY);

    // §16's own shape: the value someone would exfiltrate, asked for by the
    // fragment an attacker would actually type.
    const byValue = await reader.search('sk-s1218fixture');
    expect(byValue.hits).toEqual([]);
    expect(JSON.stringify(byValue)).not.toContain(FAKE_KEY);

    // The content rule reaches search too: a key body is not a search result,
    // whatever the file holding it is called.
    const keyBody = await reader.search('b3BlbnNzaC1rZXktdjE');
    expect(keyBody.hits).toEqual([]);
  });

  it('counts a file it refused as scanned by nobody', async () => {
    const reader = await openConfinedReader(await repo(TREE));
    const result = await reader.search('BEGIN OPENSSH PRIVATE KEY');
    expect(result.hits).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
    const scannedTwice = result.filesScanned;
    const withoutNotes = await reader.search('BEGIN CERTIFICATE');
    expect(withoutNotes.hits.map((hit) => hit.relativePath)).toEqual(['certs/certificate.pem']);
    expect(withoutNotes.filesScanned).toBe(scannedTwice);
  });
});

describe.skipIf(!AVAILABLE)('the review routes, on a real repository', () => {
  it('withholds a private key that arrived in a tracked file’s own diff', async () => {
    const fixture = await reviewFixture(gitDirs);
    // Somebody pasted a key into a file this run already changed. Git, not the
    // reader, is what hands this text over — so the content rule has to sit on
    // that route as well, or the boundary is one command deep. `src/parse.ts` is
    // the fixture's one tracked-and-modified path, which is what makes
    // `git diff <base> -- …` come back with a real hunk instead of nothing.
    const target = path.join(fixture.workspace, 'src/parse.ts');
    await writeFile(
      target,
      'export function parseDate(i: string): Date {\n  if (!i) throw new Error("empty");\n' +
        `  return new Date(i);\n}\n\n/* pasted by accident:\n${PRIVATE_PEM}*/\n`,
      'utf8',
    );

    const context = await assembleReviewContext({
      record: fixture.record,
      workspace: fixture.workspace,
      patch: fixture.patch,
    });
    const file = context.files.find((entry) => entry.path === 'src/parse.ts');

    expect(file?.presentation, 'the diff leg, not the reader leg').toBe('WITHHELD');
    expect(file?.text).toBe('');
    expect(file?.reason).toContain('private key');
    const rendered = JSON.stringify(context);
    expect(rendered).not.toContain('b3BlbnNzaC1rZXktdjE');
    expect(rendered).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('reports a plan-named key file as a limitation instead of showing its bytes', async () => {
    const fixture = await reviewFixture(gitDirs);
    const notes = path.join(fixture.workspace, 'notes/deploy-help.txt');
    await mkdir(path.dirname(notes), { recursive: true });
    await writeFile(notes, `Storage notes:\n\n${PRIVATE_PEM}`, 'utf8');

    const record = recordWith(fixture.record, {
      plan: planTouching(['src/parse.ts', 'notes/deploy-help.txt']),
    });
    const context = await assembleReviewContext({
      record,
      workspace: fixture.workspace,
      patch: fixture.patch,
    });

    // A plan-named file the patch never touched is read on its own route, into
    // `scope`, with its own account of what went wrong in `scopeLimitations`.
    expect(JSON.stringify(context.scopeLimitations)).toContain('notes/deploy-help.txt');
    const shown = context.scope.filter((entry) => entry.content !== '');
    expect(JSON.stringify(shown)).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(shown.map((entry) => entry.path)).not.toContain('notes/deploy-help.txt');
    expect(context.scope.map((entry) => entry.path)).not.toContain('notes/deploy-help.txt');
  });
});

describe('what the repair cycle can reach', () => {
  it('has no reader of its own, so the loop’s policy is the only one it can have', async () => {
    // `repair` runs the same bounded loop `implement` runs, which is where the
    // context assembler and READ_FILE live. A second reader in that directory
    // would be a second policy, and this item's whole point is that there is one.
    const files: string[] = [];
    for (const name of await readdir(path.join(process.cwd(), 'src/repair'))) {
      if (!name.endsWith('.ts')) continue;
      files.push(await readFile(path.join(process.cwd(), 'src/repair', name), 'utf8'));
    }
    const joined = files.join('\n');
    expect(joined).not.toMatch(/openConfinedReader|readText|readFileSync|readFile\(/);
  });
});
