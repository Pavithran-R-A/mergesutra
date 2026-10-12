import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { createRepositoryCommandRunner } from '../../src/security/repository-runner.js';

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mergesutra-required-sandbox-'));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('mandatory repository-command sandbox', () => {
  it('refuses to execute any command without an explicit sandbox configuration', async () => {
    const workspace = await scratch();
    const target = path.join(workspace, 'outside-command-must-not-run');
    const run = createRepositoryCommandRunner({ workspace, cwd: workspace, env: {} });
    await expect(
      run('node', ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(target) + ',"ran")']),
    ).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses when only one mandatory configuration field was supplied', async () => {
    const workspace = await scratch();
    const cases = [
      { MERGESUTRA_SANDBOX_IMAGE: 'node@sha256:' + 'a'.repeat(64) },
      { MERGESUTRA_DOCKER_EXECUTABLE: process.execPath },
    ];
    for (const env of cases) {
      const run = createRepositoryCommandRunner({ workspace, cwd: workspace, env });
      await expect(run('node', ['--version'])).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
    }
  });

  it('rejects mutable image tags rather than pulling from the network', async () => {
    const workspace = await scratch();
    const run = createRepositoryCommandRunner({
      workspace,
      cwd: workspace,
      env: {
        MERGESUTRA_SANDBOX_IMAGE: 'node:22',
        MERGESUTRA_DOCKER_EXECUTABLE: process.execPath,
      },
    });
    await expect(run('node', ['--version'])).rejects.toThrow(/digest/);
  });

  it('does not fall back to the host when a selected daemon cannot load the pinned image', async () => {
    const workspace = await scratch();
    const run = createRepositoryCommandRunner({
      workspace,
      cwd: workspace,
      env: {
        MERGESUTRA_SANDBOX_IMAGE: 'node@sha256:' + 'a'.repeat(64),
        // This is deliberately a non-Docker binary, not a backdoor to the host.
        MERGESUTRA_DOCKER_EXECUTABLE: process.execPath,
      },
    });
    await expect(run('node', ['--version'])).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
  });
});
