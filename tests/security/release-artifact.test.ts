import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeReleaseArtifactManifest } from '../../scripts/lib/release-artifact.mjs';

const SHA = 'a'.repeat(40);
const scratch: string[] = [];

function packedDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mergesutra-release-artifact-'));
  scratch.push(directory);
  writeFileSync(path.join(directory, 'mergesutra-0.1.0.tgz'), 'qualified bytes');
  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release artifact manifests bind bytes to source identity', () => {
  it('records the exact package, source commit, and tarball digest', () => {
    const directory = packedDirectory();
    const result = writeReleaseArtifactManifest({
      directory,
      packageName: 'mergesutra',
      packageVersion: '0.1.0',
      sourceCommit: SHA,
    });
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as {
      schemaVersion: number;
      packageName: string;
      packageVersion: string;
      sourceCommit: string;
      tarball: string;
      sha256: string;
    };
    const digest = createHash('sha256').update('qualified bytes').digest('hex');
    expect(manifest).toEqual({
      schemaVersion: 1,
      packageName: 'mergesutra',
      packageVersion: '0.1.0',
      sourceCommit: SHA,
      tarball: 'mergesutra-0.1.0.tgz',
      sha256: digest,
    });
    expect(result).toEqual({ tarball: manifest.tarball, sha256: digest });
    expect(lstatSync(path.join(directory, 'manifest.json')).isFile()).toBe(true);
  });

  it('refuses multiple candidate tarballs', () => {
    const directory = packedDirectory();
    writeFileSync(path.join(directory, 'unexpected.tgz'), 'other bytes');
    expect(() =>
      writeReleaseArtifactManifest({
        directory,
        packageName: 'mergesutra',
        packageVersion: '0.1.0',
        sourceCommit: SHA,
      }),
    ).toThrow('Expected exactly one packed release tarball.');
  });

  it('refuses malformed source identity and existing manifests', () => {
    const directory = packedDirectory();
    expect(() =>
      writeReleaseArtifactManifest({
        directory,
        packageName: 'mergesutra',
        packageVersion: '0.1.0',
        sourceCommit: 'not-a-commit',
      }),
    ).toThrow('Release artifact identity is incomplete or malformed.');
    writeReleaseArtifactManifest({
      directory,
      packageName: 'mergesutra',
      packageVersion: '0.1.0',
      sourceCommit: SHA,
    });
    expect(() =>
      writeReleaseArtifactManifest({
        directory,
        packageName: 'mergesutra',
        packageVersion: '0.1.0',
        sourceCommit: SHA,
      }),
    ).toThrow();
  });
});
