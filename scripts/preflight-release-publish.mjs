import { appendFileSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import { preflightPublish } from './lib/publish-registry.mjs';

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) {
  process.stderr.write('Refusing publication: GitHub output channel is unavailable.\n');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const spec = `${pkg.name}@${pkg.version}`;
const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
if (
  typeof pkg.name !== 'string' ||
  /[\r\n]/.test(pkg.name) ||
  !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(pkg.name)
) {
  process.stderr.write('Refusing publication: package name is not safe for job output.\n');
  process.exit(1);
}
if (
  typeof pkg.version !== 'string' ||
  /[\r\n]/.test(pkg.version) ||
  !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)
) {
  process.stderr.write('Refusing publication: package version is not safe for job output.\n');
  process.exit(1);
}
if (!/^[0-9a-f]{40}$/.test(head)) {
  process.stderr.write('Refusing publication: checkout commit is invalid.\n');
  process.exit(1);
}
const result = preflightPublish({
  spec,
  version: pkg.version,
  head,
  npm: (args) => spawnSync('npm', args, { encoding: 'utf8', stdio: 'pipe' }),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

if (result.code !== 0) process.exit(result.code);
appendFileSync(
  outputPath,
  `publish_required=${result.publishRequired}\npackage_name=${pkg.name}\npackage_version=${pkg.version}\nrelease_commit=${head}\n`,
  'utf8',
);
