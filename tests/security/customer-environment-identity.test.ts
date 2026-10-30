import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import { describePatch } from '../../src/verify/patch.js';
import { hasGit, runWorkspace } from '../helpers/git.js';

/**
 * The customer workflow's second implementation of the product's patch identity.
 *
 * `scripts/lib/customer-environment.mjs` re-derives the identity from the bytes in
 * another process, and the hosted customer workflow compares that digest with the
 * one the run recorded. A re-implementation that drifts from the product does not
 * fail loudly: it reports a mismatch for a workspace the product measured correctly,
 * or (worse) agrees because both sides stopped looking at the same fact. So the two
 * implementations are asked the same question about the same real repository here,
 * including the executable bit the product's canonical form now binds.
 *
 * The library lives under `scripts/`, which vitest must not bundle — its loader
 * cannot resolve an absolute path containing spaces — so it is driven as a child
 * process, the same way the customer evidence tests drive theirs.
 */
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'customer-environment.mjs');
const runChild = promisify(execFile);

const HARNESS = `
import { pathToFileURL } from 'node:url';

const [libPath, workspace, base] = process.argv.slice(1);
const lib = await import(pathToFileURL(libPath).href);
process.stdout.write(JSON.stringify(lib.rederiveProductPatchIdentity(workspace, base)));
`;

interface RederivedIdentity {
  digest: string;
  files: string[];
}

async function rederived(workspace: string, base: string): Promise<RederivedIdentity> {
  const { stdout } = await runChild(
    process.execPath,
    ['--input-type=module', '-e', HARNESS, LIB, workspace, base],
    { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as RederivedIdentity;
}

const AVAILABLE = await hasGit();
const made: string[] = [];
let workspaces = 0;

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function workspace(files: Record<string, string>) {
  workspaces += 1;
  const prepared = await runWorkspace(files, `run-environment-identity-${String(workspaces)}`);
  made.push(prepared.primary);
  return prepared;
}

describe.skipIf(!AVAILABLE)('the customer workflow re-derives the product identity', () => {
  it('agrees on a patch that carries no executable file', async () => {
    const prepared = await workspace({ 'src/parse.ts': 'export const parse = () => 1;\n' });
    await writeFile(
      path.join(prepared.workspace, 'src/parse.ts'),
      'export const parse = () => 2;\n',
    );

    const product = await describePatch({ workspace: prepared.workspace, baseSha: prepared.base });

    expect(await rederived(prepared.workspace, prepared.base)).toEqual({
      digest: product.identity,
      files: ['src/parse.ts'],
    });
  });

  it('agrees when Git records a file as executable, which the identity binds', async () => {
    const prepared = await workspace({ 'scripts/run.sh': 'echo one\n' });
    await writeFile(path.join(prepared.workspace, 'scripts/run.sh'), 'echo two\n');
    const plain = await describePatch({ workspace: prepared.workspace, baseSha: prepared.base });

    const chmodResult = await defaultRunner('git', [
      '-C',
      prepared.workspace,
      'update-index',
      '--chmod=+x',
      'scripts/run.sh',
    ]);
    expect(chmodResult.code).toBe(0);

    const executable = await describePatch({
      workspace: prepared.workspace,
      baseSha: prepared.base,
    });
    expect(executable.files[0]?.executable).toBe(true);
    expect(executable.identity).not.toBe(plain.identity);

    expect(await rederived(prepared.workspace, prepared.base)).toEqual({
      digest: executable.identity,
      files: ['scripts/run.sh'],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'agrees on an untracked script whose executable bit only the disk can answer',
    async () => {
      const prepared = await workspace({ 'src/parse.ts': 'export const parse = () => 1;\n' });
      await mkdir(path.join(prepared.workspace, 'scripts'), { recursive: true });
      await writeFile(path.join(prepared.workspace, 'scripts/run.sh'), 'echo hi\n');
      await chmod(path.join(prepared.workspace, 'scripts/run.sh'), 0o755);

      const product = await describePatch({
        workspace: prepared.workspace,
        baseSha: prepared.base,
      });
      expect(product.files.find((file) => file.path === 'scripts/run.sh')?.executable).toBe(true);

      expect(await rederived(prepared.workspace, prepared.base)).toEqual({
        digest: product.identity,
        files: ['scripts/run.sh'],
      });
    },
  );
});
