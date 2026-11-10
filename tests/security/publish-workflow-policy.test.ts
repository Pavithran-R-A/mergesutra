import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');

const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const SETUP_NODE_SHA = '249970729cb0ef3589644e2896645e5dc5ba9c38';
const UPLOAD_ARTIFACT_SHA = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
const DOWNLOAD_ARTIFACT_SHA = 'd3f86a106a0bac45b974a628896c90dbdf5c8093';
const UNTRUSTED_STEP_PREFIX =
  'env -u GITHUB_ENV -u GITHUB_OUTPUT -u GITHUB_PATH -u GITHUB_STEP_SUMMARY';

function runCommands(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*run:\s*(.+?)\s*$/.exec(line);
    return match && match[1] !== '|' ? [match[1] ?? ''] : [];
  });
}

function jobBlock(name: string): string {
  const start = WORKFLOW.indexOf(`  ${name}:`);
  if (start < 0) return '';
  const next = WORKFLOW.slice(start + 1).search(/^[ ]{2}[a-z][\w-]*:/m);
  return WORKFLOW.slice(start, next < 0 ? undefined : start + next + 1);
}

describe('the npm publish workflow is release-only and least-privilege', () => {
  it('runs only for a published GitHub Release', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}release:\n {4}types: \[published\]/m);
    expect(WORKFLOW).not.toMatch(
      /pull_request_target|pull_request:|\bpush:|workflow_dispatch|schedule:/,
    );
  });

  it('isolates OIDC from source installation and repository commands', () => {
    expect(WORKFLOW).toMatch(/^permissions:\n[ ]{2}contents: read\n/m);
    expect(jobBlock('qualify')).toContain('permissions:\n      contents: read');
    expect(jobBlock('verify')).toContain('permissions:\n      contents: read');
    expect(jobBlock('publish')).toMatch(
      /permissions:\n[ ]{6}contents: read\n[ ]{6}id-token: write/,
    );
    expect(WORKFLOW.match(/id-token:\s*write/g) ?? []).toHaveLength(1);
    expect(WORKFLOW).not.toMatch(/contents:\s*write/);
    expect(jobBlock('publish')).toContain('gh api "$tag_ref"');
    expect(jobBlock('publish')).toContain('gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main"');
    expect(jobBlock('publish')).toContain(
      'npm publish "$tarball" --access public --provenance --ignore-scripts',
    );
    expect(jobBlock('publish')).not.toMatch(/uses:\s*actions\/checkout|npm ci|npm run|scripts\//i);
  });

  it('contains no long-lived npm or repository secret', () => {
    expect(WORKFLOW).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|npm_token/i);
    expect(WORKFLOW).toMatch(/Trusted Publishing \(OIDC\)/);
  });

  it('pins every external action to an immutable commit', () => {
    expect(WORKFLOW).toContain(`actions/checkout@${CHECKOUT_SHA} # v6`);
    expect(WORKFLOW).toContain(`actions/setup-node@${SETUP_NODE_SHA} # v6`);
    expect(WORKFLOW).toContain(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA} # v4`);
    expect(WORKFLOW).toContain(`actions/download-artifact@${DOWNLOAD_ARTIFACT_SHA} # v4`);
    for (const line of WORKFLOW.split(/\r?\n/).filter((line) => line.includes('uses: '))) {
      expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\d+/);
    }
  });

  it('checks trusted main history and Node 24 registry settings', () => {
    expect(WORKFLOW).toMatch(/fetch-depth:\s*0/);
    expect(WORKFLOW).toMatch(/persist-credentials:\s*false/);
    expect(WORKFLOW).toMatch(/ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
    expect(WORKFLOW).toMatch(/node-version:\s*'24\.x'/);
    expect(WORKFLOW).toContain("registry-url: 'https://registry.npmjs.org'");
    expect(WORKFLOW).toMatch(/package-manager-cache:\s*false/);
  });

  it('qualifies before packing and publishes only verified artifacts', () => {
    expect(runCommands(jobBlock('qualify'))).toEqual([
      `${UNTRUSTED_STEP_PREFIX} node scripts/verify-release-tag.mjs`,
      `${UNTRUSTED_STEP_PREFIX} npm ci --ignore-scripts`,
      `${UNTRUSTED_STEP_PREFIX} npm audit --omit=dev --audit-level=high`,
      `${UNTRUSTED_STEP_PREFIX} npm run check`,
      `${UNTRUSTED_STEP_PREFIX} npm run verify:package`,
      `${UNTRUSTED_STEP_PREFIX} npm run test:artifact`,
      `${UNTRUSTED_STEP_PREFIX} npm run build`,
      'mkdir -p release-package',
      `${UNTRUSTED_STEP_PREFIX} npm pack --ignore-scripts --pack-destination release-package`,
      'node scripts/preflight-release-publish.mjs',
    ]);
    expect(runCommands(jobBlock('verify'))).toEqual(['node scripts/verify-published-release.mjs']);
    expect(jobBlock('verify')).toContain('npm install --prefix "$check_dir" --ignore-scripts');
    expect(jobBlock('verify')).toContain('npm audit signatures --prefix "$check_dir"');
    expect(jobBlock('verify')).not.toMatch(/id-token:\s*write/);
    expect(jobBlock('qualify')).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(jobBlock('verify')).toContain(
      'RELEASE_PACKAGE_VERSION: ${{ needs.qualify.outputs.package_version }}',
    );
    expect(jobBlock('verify')).toContain(
      'RELEASE_PACKAGE_NAME: ${{ needs.qualify.outputs.package_name }}',
    );
    expect(jobBlock('verify')).toContain(
      'RELEASE_COMMIT_SHA: ${{ needs.qualify.outputs.release_commit }}',
    );
    expect(WORKFLOW).toContain('actions/upload-artifact@');
    expect(WORKFLOW).toContain('actions/download-artifact@');
    expect(WORKFLOW).toContain('artifact_sha256: ${{ steps.artifact.outputs.sha256 }}');
    expect(WORKFLOW).toContain('RELEASE_COMMIT_SHA: ${{ steps.registry.outputs.release_commit }}');
    expect(WORKFLOW).toContain('scripts/lib/release-artifact.mjs');
    expect(WORKFLOW).toContain('manifest.json');
    expect(WORKFLOW).toContain('ARTIFACT_SHA256: ${{ needs.qualify.outputs.artifact_sha256 }}');
    expect(jobBlock('publish')).toContain('sha256sum "$tarball"');
    expect(jobBlock('publish')).toContain('test "$actual_sha256" = "$ARTIFACT_SHA256"');
    expect(jobBlock('publish')).toContain('jq -e');
    expect(jobBlock('publish')).toContain('--arg source "$EXPECTED_SOURCE_SHA"');
    expect(jobBlock('publish')).not.toContain('npm publish release-package/*.tgz');
    expect(jobBlock('qualify')).toContain('safe_git rev-parse --verify HEAD');
    expect(jobBlock('qualify')).toContain(
      'safe_git diff --no-ext-diff --no-textconv --exit-code "$GITHUB_SHA" -- .',
    );
    expect(jobBlock('qualify')).toContain('safe_git status --porcelain --untracked-files=all');
  });

  it('keeps runner command files away from install scripts', () => {
    const qualify = jobBlock('qualify');
    expect(qualify).toContain('npm ci --ignore-scripts');
    for (const command of ['npm ci --ignore-scripts', 'npm run check', 'npm run build', 'npm pack']) {
      expect(qualify).toContain(`${UNTRUSTED_STEP_PREFIX} ${command}`);
    }
    expect(qualify).toContain('persist-credentials: false');
  });

  it('binds the GitHub Release tag into the version/commit identity check', () => {
    expect(WORKFLOW).toContain('RELEASE_TAG: ${{ github.event.release.tag_name }}');
    expect(WORKFLOW).toContain('node scripts/verify-release-tag.mjs');
    const verify = readFileSync(path.join(ROOT, 'scripts', 'verify-release-tag.mjs'), 'utf8');
    expect(verify).toContain("'ls-remote'");
    expect(verify).toContain("'refs/heads/main'");
    expect(verify).toContain('GITHUB_REPOSITORY');
    expect(verify).toContain('releaseIdentityProblems');
  });

  it('never swallows a release failure', () => {
    expect(WORKFLOW).not.toMatch(/continue-on-error|\|\|\s*true/);
  });
});
