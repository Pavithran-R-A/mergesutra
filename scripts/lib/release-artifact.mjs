import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const MANIFEST = 'manifest.json';

/** Create a small source-bound manifest beside one freshly packed tarball. */
export function writeReleaseArtifactManifest({
  directory,
  packageName,
  packageVersion,
  sourceCommit,
}) {
  if (
    typeof packageName !== 'string' ||
    packageName.length === 0 ||
    typeof packageVersion !== 'string' ||
    packageVersion.length === 0 ||
    !SHA.test(sourceCommit ?? '')
  ) {
    throw new Error('Release artifact identity is incomplete or malformed.');
  }
  const names = readdirSync(directory).sort();
  if (names.length !== 1 || !names[0]?.endsWith('.tgz')) {
    throw new Error('Expected exactly one packed release tarball.');
  }
  const tarball = names[0];
  const tarballPath = path.join(directory, tarball);
  const info = lstatSync(tarballPath);
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error('Release tarball must be a regular, singly linked file.');
  }
  const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  if (!HEX_DIGEST.test(sha256)) {
    throw new Error('Release tarball digest is malformed.');
  }
  const manifest = {
    schemaVersion: 1,
    packageName,
    packageVersion,
    sourceCommit,
    tarball,
    sha256,
  };
  writeFileSync(path.join(directory, MANIFEST), `${JSON.stringify(manifest)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o444,
  });
  return { tarball, sha256 };
}
