import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { releaseIdentityProblems } from './lib/release-identity.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const expectedTag = 'v' + pkg.version;
const releaseTag = process.env.RELEASE_TAG?.trim();

// An unexpected event must fail before any network access or npm publication.
if (
  releaseTag !== expectedTag ||
  process.env.GITHUB_EVENT_NAME !== 'release' ||
  process.env.GITHUB_REF !== 'refs/tags/' + expectedTag
) {
  process.stderr.write('Refusing npm release: expected a published GitHub Release for this version.\n');
  process.exit(1);
}

let head;
let tagCommit;
let remoteMainLine;
let expectedRepository;
try {
  const repositoryUrl = new URL(String(pkg.repository?.url ?? '').replace(/^git\+/, ''));
  const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git$/.exec(repositoryUrl.pathname);
  if (repositoryUrl.origin !== 'https://github.com' || !match) {
    throw new Error('the package repository is not an expected GitHub HTTPS URL');
  }
  expectedRepository = match[1];

  const git = (args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 4096,
    }).trim();
  head = git(['rev-parse', '--verify', 'HEAD']);
  tagCommit = git(['rev-parse', '--verify', 'refs/tags/' + expectedTag + '^{commit}']);
  // Read GitHub directly, not a checkout's mutable origin remote configuration.
  remoteMainLine = git([
    'ls-remote',
    '--exit-code',
    'https://github.com/' + expectedRepository + '.git',
    'refs/heads/main',
  ]);
} catch {
  // The network, tag or Git ref may be unavailable. Do not print child stderr.
  process.stderr.write('Refusing npm release: could not verify Git tag and protected main identity.\n');
  process.exit(1);
}

const problems = releaseIdentityProblems({
  version: pkg.version,
  releaseTag,
  eventName: process.env.GITHUB_EVENT_NAME,
  ref: process.env.GITHUB_REF,
  repository: process.env.GITHUB_REPOSITORY,
  expectedRepository,
  head,
  workflowSha: process.env.GITHUB_SHA,
  tagCommit,
  remoteMainLine,
});
if (problems.length > 0) {
  process.stderr.write('Refusing npm release:\n' + problems.map((p) => '- ' + p).join('\n') + '\n');
  process.exit(1);
}

process.stdout.write(
  'Release identity verified: ' +
    pkg.name +
    '@' +
    pkg.version +
    ' at ' +
    head +
    ', equal to protected main.\n',
);
