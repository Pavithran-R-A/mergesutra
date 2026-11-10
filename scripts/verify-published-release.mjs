import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { verifyPublished } from './lib/publish-registry.mjs';

const packageName = process.env.RELEASE_PACKAGE_NAME;
const version = process.env.RELEASE_PACKAGE_VERSION;
const head = process.env.RELEASE_COMMIT_SHA;
if (
  !packageName ||
  !version ||
  !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName) ||
  !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ||
  !/^[0-9a-f]{40}$/.test(head ?? '')
) {
  process.stderr.write('Refusing release verification: qualified identity is unavailable.\n');
  process.exit(1);
}
const spec = `${packageName}@${version}`;
const code = verifyPublished({
  spec,
  version,
  head,
  npm: (args) => spawnSync('npm', args, { encoding: 'utf8', stdio: 'pipe' }),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

process.exit(code);
