import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const expectedTag = `v${pkg.version}`;
const releaseTag = process.env.RELEASE_TAG?.trim();

if (!releaseTag) {
  process.stderr.write('RELEASE_TAG is missing; this workflow must run from a published GitHub Release.\n');
  process.exit(1);
}
if (releaseTag !== expectedTag) {
  process.stderr.write(
    `Release tag ${releaseTag} does not match package version ${pkg.version} (expected ${expectedTag}).\n`,
  );
  process.exit(1);
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const workflowSha = process.env.GITHUB_SHA?.trim();
if (!workflowSha || head !== workflowSha) {
  process.stderr.write(
    `Checked-out HEAD ${head} does not match workflow SHA ${workflowSha ?? '<missing>'}.\n`,
  );
  process.exit(1);
}

process.stdout.write(`Release identity verified: ${pkg.name}@${pkg.version} at ${head}.\n`);
