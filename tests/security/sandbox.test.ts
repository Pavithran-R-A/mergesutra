import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSandboxedRunner, sandboxDockerArgv } from '../../src/security/sandbox.js';
import type { Runner } from '../../src/core/runner.js';

const IMAGE = `node@sha256:${'b'.repeat(64)}`;
const dirs: string[] = [];
async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'mergesutra-sandbox-'));
  dirs.push(workspace);
  const inside = path.join(workspace, 'sub');
  await mkdir(inside);
  return { workspace, inside };
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('pinned, reduced-privilege Docker command', () => {
  it('exposes only the selected workspace and no host network, socket or credentials', async () => {
    const { workspace, inside } = await fixture();
    const argv = sandboxDockerArgv({
      workspace,
      cwd: inside,
      image: IMAGE,
      file: 'node',
      args: ['check.js', 'one two'],
      uid: 1001,
      gid: 1001,
    });
    expect(argv).toContain('--network=none');
    expect(argv).toContain('--cap-drop=ALL');
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--security-opt=no-new-privileges:true');
    expect(argv).toContain('--pull=never');
    expect(argv).toContain('--user');
    expect(argv).toContain('1001:1001');
    expect(argv).toContain('--workdir');
    expect(argv).toContain('/workspace/sub');
    expect(argv).toContain(`type=bind,source=${workspace},target=/workspace`);
    expect(argv.slice(-3)).toEqual(['node', 'check.js', 'one two']);
    expect(argv.join(' ')).not.toMatch(
      /docker\.sock|--privileged|--network=host|GH_TOKEN|BHARATCODE_API_KEY/,
    );
    expect(argv.filter((a) => a.startsWith('type=bind,'))).toHaveLength(1);
  });

  it('rejects mutable image tags, shell-shaped programs, and workspace escape', async () => {
    const { workspace, inside } = await fixture();
    const base = { workspace, cwd: inside, image: IMAGE, file: 'node', args: [] };
    expect(() => sandboxDockerArgv({ ...base, image: 'node:24' })).toThrow(/SANDBOX_UNAVAILABLE/);
    expect(() => sandboxDockerArgv({ ...base, file: '/bin/sh' })).toThrow(/SANDBOX_UNAVAILABLE/);
    expect(() => sandboxDockerArgv({ ...base, cwd: tmpdir() })).toThrow(/outside its workspace/);
  });

  it('rejects symlink escapes after resolving the real path', async () => {
    const { workspace } = await fixture();
    const link = path.join(workspace, 'escape');
    await symlink(tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() =>
      sandboxDockerArgv({
        workspace,
        cwd: link,
        image: IMAGE,
        file: 'node',
        args: [],
      }),
    ).toThrow(/outside its workspace/);
  });

  it('rejects a Docker executable located inside the untrusted workspace', async () => {
    const { workspace } = await fixture();
    const fakeDocker = path.join(workspace, 'docker');
    await import('node:fs/promises').then((fs) => fs.writeFile(fakeDocker, 'fake'));
    expect(() =>
      createSandboxedRunner({ workspace, image: IMAGE, dockerExecutable: fakeDocker }),
    ).toThrow(/inside the untrusted workspace/);
  });

  it('requires an absolute Docker binary before any host probe', async () => {
    const { workspace } = await fixture();
    expect(() =>
      createSandboxedRunner({ workspace, image: IMAGE, dockerExecutable: 'docker' }),
    ).toThrow(/absolute/);
  });

  it('never attempts docker run when the pinned local image is unavailable', async () => {
    const { workspace } = await fixture();
    const calls: string[][] = [];
    const hostRun: Runner = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 1, stdout: '', stderr: 'not found' };
    };
    const run = createSandboxedRunner({
      workspace,
      image: IMAGE,
      dockerExecutable: process.execPath,
      hostRun,
    });
    await expect(run('node', ['check.js'])).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
    expect(calls).toEqual([[process.execPath, 'image', 'inspect', IMAGE]]);
  });

  it('starts only the reduced container when the image was preloaded', async () => {
    const { workspace } = await fixture();
    const calls: string[][] = [];
    const hostRun: Runner = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    const run = createSandboxedRunner({
      workspace,
      image: IMAGE,
      dockerExecutable: process.execPath,
      hostRun,
    });
    const result = await run('npm', ['test']);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([process.execPath, 'image', 'inspect', IMAGE]);
    expect(calls[1]?.[0]).toBe(process.execPath);
    expect(calls[1]).toContain('--network=none');
    expect(calls[1]?.slice(-2)).toEqual(['npm', 'test']);
  });
});
