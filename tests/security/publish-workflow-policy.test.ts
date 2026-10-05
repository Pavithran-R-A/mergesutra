import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');

const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const SETUP_NODE_SHA = '249970729cb0ef3589644e2896645e5dc5ba9c38';

function runCommands(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*run:\s*(.+?)\s*$/.exec(line);
    return match ? [match[1] ?? ''] : [];
  });
}

describe('the npm publish workflow is release-only and least-privilege', () => {
  it('runs only for a published GitHub Release', () => {
    expect(WORKFLOW).toMatch(/^on:\n  release:\n    types: \[published\]/m);
    expect(WORKFLOW).not.toMatch(/pull_request_target|pull_request:|\bpush:|workflow_dispatch|schedule:/);
  });

  it('keeps top-level permissions read-only and grants OIDC only to the publish job', () => {
    expect(WORKFLOW).toMatch(/^permissions:\n  contents: read\n/m);
    expect(WORKFLOW).toMatch(
      /jobs:\n  publish:[\s\S]*?    permissions:\n      contents: read\n      id-token: write\n/,
    );
    expect((WORKFLOW.match(/id-token:\s*write/g) ?? [])).toHaveLength(1);
    expect(WORKFLOW).not.toMatch(/contents:\s*write/);
  });

  it('contains no long-lived npm or repository secret', () => {
    expect(WORKFLOW).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|npm_token/i);
    expect(WORKFLOW).toMatch(/Trusted Publishing \(OIDC\)/);
  });

  it('pins both external actions to current immutable v6 commits', () => {
    expect(WORKFLOW).toContain(`actions/checkout@${CHECKOUT_SHA} # v6`);
    expect(WORKFLOW).toContain(`actions/setup-node@${SETUP_NODE_SHA} # v6`);
    for (const line of WORKFLOW.split(/\r?\n/).filter((line) => line.includes('uses: '))) {
      expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\d+/);
    }
  });

  it('checks out the complete history on Node 24 against the public npm registry', () => {
    expect(WORKFLOW).toMatch(/fetch-depth:\s*0/);
    expect(WORKFLOW).toMatch(/node-version:\s*'24\.x'/);
    expect(WORKFLOW).toContain("registry-url: 'https://registry.npmjs.org'");
  });

  it('runs source, runtime-audit and package gates before the publish helper', () => {
    expect(runCommands(WORKFLOW)).toEqual([
      'npm ci',
      'npm audit --omit=dev --audit-level=high',
      'npm run check',
      'npm run verify:package',
      'npm run test:artifact',
      'node scripts/verify-release-tag.mjs',
      'node scripts/publish-or-verify.mjs',
    ]);
  });

  it('binds the GitHub Release tag into the version/commit identity check', () => {
    expect(WORKFLOW).toContain('RELEASE_TAG: ${{ github.event.release.tag_name }}');
    expect(WORKFLOW).toContain('node scripts/verify-release-tag.mjs');
  });

  it('never swallows a release failure', () => {
    expect(WORKFLOW).not.toMatch(/continue-on-error|\|\|\s*true/);
  });
});
