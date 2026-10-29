import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import { publishOrVerify } from './lib/publish-registry.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const spec = `${pkg.name}@${pkg.version}`;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const code = publishOrVerify({
  spec,
  version: pkg.version,
  head,
  npm: (args, options = {}) =>
    spawnSync('npm', args, {
      encoding: 'utf8',
      stdio: options.inherit ? 'inherit' : 'pipe',
    }),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

process.exit(code);
