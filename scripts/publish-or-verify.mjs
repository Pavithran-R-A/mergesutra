import { readFileSync } from 'node:fs';
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
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    process.stderr.write('npm returned non-JSON metadata for the published package.\n');
    process.exit(1);
  }
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
  if (gitHead && gitHead !== head) {
    process.stderr.write(`Registry gitHead ${gitHead} does not match release commit ${head}.\n`);
    process.exit(1);
  }
  process.stdout.write(`Registry verified: ${spec}${gitHead ? ` at ${gitHead}` : ''}.\n`);
}

const existing = view();
if (existing) {
  verify(existing);
  process.stdout.write('This exact version already exists on npm; refusing to republish it.\n');
  process.exit(0);
}

process.stdout.write(`Publishing ${spec} through npm Trusted Publishing.\n`);
const published = npm(['publish', '--access', 'public'], { inherit: true });
if (published.status !== 0) process.exit(published.status ?? 1);

for (let attempt = 1; attempt <= 5; attempt += 1) {
  const meta = view();
  if (meta) {
    verify(meta);
    process.exit(0);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}

process.stderr.write(
  `${spec} was published but was not readable from the registry after verification retries.\n`,
);
process.exit(1);
