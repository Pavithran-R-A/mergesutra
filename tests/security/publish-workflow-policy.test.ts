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

function runCommands(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*run:\s*(.+?)\s*$/.exec(line);
    return match ? [match[1] ?? ''] : [];
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
      'npm publish release-package/*.tgz --access public --provenance --ignore-scripts',
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
      'node scripts/verify-release-tag.mjs',
      'npm ci',
      'npm audit --omit=dev --audit-level=high',
      'npm run check',
      'npm run verify:package',
      'npm run test:artifact',
      'git diff --exit-code && test -z "$(git status --porcelain --untracked-files=all)"',
      'npm run build',
      'mkdir -p release-package',
      'npm pack --ignore-scripts --pack-destination release-package',
      'node scripts/preflight-release-publish.mjs',
    ]);
    expect(runCommands(jobBlock('verify'))).toEqual(['node scripts/verify-published-release.mjs']);
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
