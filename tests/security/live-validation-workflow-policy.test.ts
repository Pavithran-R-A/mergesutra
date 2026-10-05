import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'live-validation.yml'),
  'utf8',
);

const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const SETUP_NODE_SHA = '249970729cb0ef3589644e2896645e5dc5ba9c38';
const UPLOAD_SHA = 'ea165f8d65b6e75b540449e92b4886f43607fa02';

function job(name: string, next?: string): string {
  const start = WORKFLOW.indexOf(`  ${name}:\n`);
  expect(start, `job ${name} is missing`).toBeGreaterThanOrEqual(0);
  const end = next ? WORKFLOW.indexOf(`  ${next}:\n`, start + 1) : WORKFLOW.length;
  return WORKFLOW.slice(start, end < 0 ? WORKFLOW.length : end);
}

describe('the controlled live-validation workflow', () => {
  it('has no pull-request trigger and no path to main pushes', () => {
    expect(WORKFLOW).toMatch(/^on:\n  workflow_dispatch:/m);
    expect(WORKFLOW).not.toMatch(/pull_request(?:_target)?:/);
    expect(WORKFLOW).not.toMatch(/^\s*push:/m);
  });

  it('keeps the workflow and both jobs read-only on GitHub', () => {
    expect(WORKFLOW.match(/contents:\s*read/g) ?? []).toHaveLength(3);
    expect(WORKFLOW).not.toMatch(/contents:\s*write|issues:\s*write|pull-requests:\s*write/);
    expect(WORKFLOW).not.toMatch(/id-token:\s*write/);
  });

  it('allows exactly one repository secret and it is the BharatCode key', () => {
    const refs = [...WORKFLOW.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
    expect(refs).toEqual(['BHARATCODE_API_KEY']);
    expect(WORKFLOW).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN:\s*\$\{\{\s*secrets/);
  });

  it('uses the ephemeral GitHub token only for MergeSutra-owned reads', () => {
    expect(WORKFLOW.match(/GH_TOKEN:\s*\$\{\{ github\.token \}\}/g) ?? []).toHaveLength(2);
    expect(WORKFLOW).not.toMatch(/GITHUB_TOKEN:/);
  });

  it('never exposes the BharatCode secret to the no-key matrix', () => {
    const noKey = job('no-key-chain', 'live-model');
    expect(noKey).not.toContain('BHARATCODE_API_KEY');
    expect(noKey).not.toContain('BHARATCODE_MODEL');
    expect(noKey).toContain('os: [ubuntu-latest, windows-latest]');
    expect(noKey).toContain('node scripts/e2e-validation.mjs no-key');
  });

  it('requires a deliberate live trigger and pins the only model this run is allowed to use', () => {
    const live = job('live-model');
    expect(live).toContain("if: github.ref == 'refs/heads/main' && inputs.run_live == true");
    expect(live).toContain('BHARATCODE_MODEL: deepseek-v4.1-flash');
    expect(live).toContain('needs: no-key-chain');
    expect(live).toContain('timeout-minutes: 15');
    expect(live).toContain('node scripts/e2e-validation.mjs live');
  });

  it('refuses a missing secret without printing it', () => {
    const live = job('live-model');
    expect(live).toContain('if [ -z "${BHARATCODE_API_KEY:-}" ]; then');
    expect(live).toContain('BHARATCODE_API_KEY repository secret is not configured.');
    expect(live).not.toMatch(/echo[^\n]*\$\{?BHARATCODE_API_KEY/);
  });

  it('pins every external action to an immutable verified commit', () => {
    expect(
      WORKFLOW.match(new RegExp(`actions/checkout@${CHECKOUT_SHA} # v6`, 'g')) ?? [],
    ).toHaveLength(2);
    expect(
      WORKFLOW.match(new RegExp(`actions/setup-node@${SETUP_NODE_SHA} # v6`, 'g')) ?? [],
    ).toHaveLength(2);
    expect(
      WORKFLOW.match(new RegExp(`actions/upload-artifact@${UPLOAD_SHA} # v4`, 'g')) ?? [],
    ).toHaveLength(2);

    for (const line of WORKFLOW.split(/\r?\n/).filter((line) => line.includes('uses: '))) {
      expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\d+/);
    }
  });

  it('removes checkout credentials and package-manager caching from both jobs', () => {
    expect(WORKFLOW.match(/persist-credentials:\s*false/g) ?? []).toHaveLength(2);
    expect(WORKFLOW.match(/package-manager-cache:\s*false/g) ?? []).toHaveLength(2);
  });

  it('uploads only the validation driver’s sanitized export directory', () => {
    expect(WORKFLOW.match(/path:\s*\.mergesutra\/live-validation-export\//g) ?? []).toHaveLength(2);
    expect(WORKFLOW).not.toMatch(/path:\s*\.mergesutra\s*$/m);
    expect(WORKFLOW.match(/retention-days:\s*14/g) ?? []).toHaveLength(2);
  });

  it('does not use a shell command to print the secret or environment', () => {
    expect(WORKFLOW).not.toMatch(/\b(?:env|printenv|set)\b[^\n]*BHARATCODE/i);
    expect(WORKFLOW).not.toMatch(/echo[^\n]*bc_live_|echo[^\n]*sk-/i);
  });
});
