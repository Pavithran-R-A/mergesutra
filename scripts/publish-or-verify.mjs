import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

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
    console.error('npm returned non-JSON metadata for the published package.');
    process.exit(1);
  }
}

function verify(meta) {
  const version = typeof meta === 'string' ? meta : meta?.version;
  const gitHead = typeof meta === 'object' && meta !== null ? meta.gitHead : undefined;
  if (version !== pkg.version) {
    console.error(
      `Registry version mismatch: expected ${pkg.version}, received ${String(version)}.`,
    );
    process.exit(1);
  }
  if (gitHead && gitHead !== head) {
    console.error(`Registry gitHead ${gitHead} does not match release commit ${head}.`);
    process.exit(1);
  }
  console.log(`Registry verified: ${spec}${gitHead ? ` at ${gitHead}` : ''}.`);
}

const existing = view();
if (existing) {
  verify(existing);
  console.log('This exact version already exists on npm; refusing to republish it.');
  process.exit(0);
}

console.log(`Publishing ${spec} through npm Trusted Publishing.`);
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

console.error(
  `${spec} was published but was not readable from the registry after verification retries.`,
);
process.exit(1);
