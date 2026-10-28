import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const spec = `${pkg.name}@${pkg.version}`;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

function npm(args, options = {}) {
  return spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    ...options,
  });
}

function view() {
  const result = npm(['view', spec, 'version', 'gitHead', '--json']);
  if (result.status === 0) {
    try {
      return { kind: 'meta', meta: JSON.parse(result.stdout) };
    } catch {
      return {
        kind: 'unreadable',
        output: 'npm returned non-JSON metadata for the published package.',
      };
    }
  }
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join('\n')
    .trim();
  // npm exits 1 for both a missing version and a failed read, and only its own
  // "code E404" line marks absence; an incidental token must not authorize a write.
  if (/^npm (?:ERR!|error) code E404\r?$/m.test(output)) return { kind: 'absent' };
  return { kind: 'unreadable', output };
}

function verify(meta) {
  const version = typeof meta === 'string' ? meta : meta?.version;
  const gitHead = typeof meta === 'object' && meta !== null ? meta.gitHead : undefined;
  if (version !== pkg.version) {
    process.stderr.write(
      `Registry version mismatch: expected ${pkg.version}, received ${String(version)}.\n`,
    );
    process.exit(1);
  }
  if (typeof gitHead !== 'string' || gitHead.length === 0) {
    process.stderr.write(
      `Registry metadata for ${spec} names no gitHead, so it cannot be tied to release commit ${head}.\n`,
    );
    process.exit(1);
  }
  if (gitHead !== head) {
    process.stderr.write(`Registry gitHead ${gitHead} does not match release commit ${head}.\n`);
    process.exit(1);
  }
  process.stdout.write(`Registry verified: ${spec} at ${gitHead}.\n`);
}

const existing = view();
if (existing.kind === 'unreadable') {
  process.stderr.write(
    `Could not read ${spec} from the registry; refusing to treat that as version absence.\n${existing.output}\n`,
  );
  process.exit(1);
}
if (existing.kind === 'meta') {
  verify(existing.meta);
  process.stdout.write('This exact version already exists on npm; refusing to republish it.\n');
  process.exit(0);
}

process.stdout.write(`Publishing ${spec} through npm Trusted Publishing.\n`);
const published = npm(['publish', '--access', 'public'], { inherit: true });
if (published.status !== 0) process.exit(published.status ?? 1);

let last = 'absent';
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const result = view();
  if (result.kind === 'meta') {
    verify(result.meta);
    process.exit(0);
  }
  last = result.kind;
  if (attempt < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}

process.stderr.write(
  `${spec} was published, but verification did not read it back. Last attempt: ${
    last === 'unreadable'
      ? 'the registry could not be read'
      : 'the registry reported the version absent'
  }. The version may already be live; re-run this helper to verify it rather than publish again.\n`,
);
process.exit(1);
