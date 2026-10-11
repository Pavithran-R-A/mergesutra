import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'sandbox-runtime.yml'),
  'utf8',
);
const HARNESS = readFileSync(path.join(ROOT, 'scripts', 'sandbox-runtime-proof.mjs'), 'utf8');

/**
 * Restrict the one job that deliberately runs a hostile fixture under Docker.
 * The host must have no repo secrets, no write-scoped token and no hidden
 * failure suppression. The pinned image is checked against the harness too.
 */
function violations(text: string, harness = HARNESS): string[] {
  const problems: string[] = [];
  const image = /docker pull (node@sha256:[0-9a-f]{64})/.exec(text)?.[1];
  const expected = /const IMAGE =\s*'(node@sha256:[0-9a-f]{64})'/.exec(harness)?.[1];
  if (!image || image !== expected) problems.push('image is unpinned or does not match harness');
  if (!/^permissions:\s*\n  contents: read\s*$/m.test(text)) {
    problems.push('permissions are not explicitly read-only');
  }
  if (/pull_request_target|secrets\.|id-token:|contents: write/.test(text)) {
    problems.push('workflow has privileged trigger or secret access');
  }
  if (!/^  pull_request:\s*$/m.test(text) || !/^  workflow_dispatch:\s*$/m.test(text)) {
    problems.push('expected ordinary PR and manual triggers missing');
  }
  if (!/^    branches: \[main\]$/m.test(text)) {
    problems.push('push is not constrained to main');
  }
  if (!/persist-credentials: false/.test(text)) {
    problems.push('checkout persists GitHub credentials');
  }
  if (
    !/uses: actions\/checkout@[0-9a-f]{40} # v\d+/m.test(text) ||
    !/uses: actions\/setup-node@[0-9a-f]{40} # v\d+/m.test(text)
  ) {
    problems.push('external actions are not pinned');
  }
  if (/continue-on-error|\|\|\s*true|--privileged|--network=host|docker\.sock/.test(text)) {
    problems.push('unsafe failure suppression or sandbox privilege');
  }
  if (!/run: node scripts\/sandbox-runtime-proof\.mjs/.test(text)) {
    problems.push('independent host-side proof does not run');
  }
  return problems;
}

describe('real Docker workflow has explicit authority boundaries', () => {
  it('reads the shipped workflow and finds no policy gaps', () => {
    expect(violations(WORKFLOW)).toEqual([]);
  });

  it('rejects a privileged PR trigger or a write-scoped token', () => {
    expect(violations(WORKFLOW.replace('pull_request:', 'pull_request_target:'))).toContain(
      'workflow has privileged trigger or secret access',
    );
    expect(violations(WORKFLOW.replace('contents: read', 'contents: write'))).toContain(
      'permissions are not explicitly read-only',
    );
  });

  it('rejects mutable image tags and drift between workflow and the actual test', () => {
    expect(violations(WORKFLOW.replace(/node@sha256:[0-9a-f]{64}/, 'node:22'))).toContain(
      'image is unpinned or does not match harness',
    );
    expect(violations(WORKFLOW, HARNESS.replace('node@sha256:', 'alpine@sha256:'))).toContain(
      'image is unpinned or does not match harness',
    );
  });

  it('rejects lost real-run evidence and a silently ignored failure', () => {
    expect(violations(WORKFLOW.replace('node scripts/sandbox-runtime-proof.mjs', 'echo skipped'))).toContain(
      'independent host-side proof does not run',
    );
    expect(violations(WORKFLOW.replace('node scripts/sandbox-runtime-proof.mjs', 'node scripts/sandbox-runtime-proof.mjs || true'))).toContain(
      'unsafe failure suppression or sandbox privilege',
    );
  });
});
