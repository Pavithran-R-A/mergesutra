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

const DIGEST_IMAGE = /^node@sha256:[0-9a-f]{64}$/;

/**
 * The images the job preloads, read from its `matrix.image` list. Each leg of the
 * matrix is one sandbox image, so the list is the qualification record: a leg that
 * names a tag would make the proof test whatever the registry happens to serve.
 */
function imageMatrix(text: string): string[] {
  const block = /image:\s*\n((?:\s*-\s*\S+\s*\n?)+)/.exec(text);
  if (!block) return [];
  const [, list = ''] = block;
  return [...list.matchAll(/-\s*(\S+)/g)]
    .map((match) => match[1])
    .filter((image): image is string => image !== undefined);
}

/**
 * Restrict the one job that deliberately runs a hostile fixture under Docker.
 * The host must have no repo secrets, no write-scoped token and no hidden
 * failure suppression, and every image it proves against must be digest-pinned
 * in the matrix and named by the harness it runs.
 */
function violations(text: string, harness = HARNESS): string[] {
  const problems: string[] = [];
  const matrix = imageMatrix(text);
  const defaultImage = /const DEFAULT_IMAGE =\s*'(node@sha256:[0-9a-f]{64})'/.exec(harness)?.[1];
  if (matrix.length < 2) problems.push('fewer than two sandbox images are qualified');
  for (const image of matrix) {
    if (!DIGEST_IMAGE.test(image)) problems.push(`matrix image is not digest-pinned: ${image}`);
  }
  if (defaultImage && !matrix.includes(defaultImage)) {
    problems.push('harness default image is not one the workflow preloads');
  }
  if (
    !/const IMAGE = process\.env\.MERGESUTRA_RUNTIME_PROOF_IMAGE \?\? DEFAULT_IMAGE/.test(harness)
  ) {
    problems.push('the proof image cannot be set by the matrix');
  }
  if (!/docker pull \$\{\{ matrix\.image \}\}/.test(text)) {
    problems.push('the preloaded image does not come from the matrix');
  }
  if (!/MERGESUTRA_RUNTIME_PROOF_IMAGE: \$\{\{ matrix\.image \}\}/.test(text)) {
    problems.push('the host-side proof does not run the matrix image');
  }
  if (!/MERGESUTRA_SANDBOX_IMAGE: \$\{\{ matrix\.image \}\}/.test(text)) {
    problems.push('the stage proof does not run the matrix image');
  }
  if (!/^permissions:\s*\n {2}contents: read\s*$/m.test(text)) {
    problems.push('permissions are not explicitly read-only');
  }
  if (/pull_request_target|secrets\.|id-token:|contents: write/.test(text)) {
    problems.push('workflow has privileged trigger or secret access');
  }
  if (!/^ {2}pull_request:\s*$/m.test(text) || !/^ {2}workflow_dispatch:\s*$/m.test(text)) {
    problems.push('expected ordinary PR and manual triggers missing');
  }
  if (!/^ {4}branches: \[main\]$/m.test(text)) {
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
  if (
    !/run: node --import tsx scripts\/sandbox-stage-proof\.mjs/.test(text) ||
    !/MERGESUTRA_DOCKER_EXECUTABLE: \/usr\/bin\/docker/.test(text)
  ) {
    problems.push('real Stage 6 and Stage 7 Docker proof not enforced');
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

  it('qualifies more than one sandbox image, each digest-pinned', () => {
    expect(imageMatrix(WORKFLOW).length).toBeGreaterThan(1);
    for (const image of imageMatrix(WORKFLOW)) expect(image).toMatch(DIGEST_IMAGE);
  });

  it('rejects a mutable tag in the matrix and drift between workflow and harness', () => {
    expect(violations(WORKFLOW.replace(/- node@sha256:[0-9a-f]{64}/, '- node:22'))).toContain(
      'matrix image is not digest-pinned: node:22',
    );
    const otherPinned = 'node@sha256:' + 'b'.repeat(64);
    expect(
      violations(WORKFLOW, HARNESS.replace(/node@sha256:[0-9a-f]{64}/, otherPinned)),
    ).toContain('harness default image is not one the workflow preloads');
  });

  it('rejects a harness that ignores the matrix and a pull that bypasses it', () => {
    expect(
      violations(
        WORKFLOW,
        HARNESS.replace(
          /const IMAGE = process\.env\.MERGESUTRA_RUNTIME_PROOF_IMAGE \?\? DEFAULT_IMAGE/,
          'const IMAGE = DEFAULT_IMAGE',
        ),
      ),
    ).toContain('the proof image cannot be set by the matrix');
    expect(
      violations(
        WORKFLOW.replace(
          'docker pull ${{ matrix.image }}',
          'docker pull node@sha256:' + 'c'.repeat(64),
        ),
      ),
    ).toContain('the preloaded image does not come from the matrix');
  });

  it('rejects a matrix that stops qualifying images and a proof that ignores its leg', () => {
    const oneLeg = WORKFLOW.replace(
      / {10}- node@sha256:0e5f[0-9a-f]{60}\n {10}- node@sha256:1407[0-9a-f]{60}\n/,
      '',
    );
    expect(oneLeg).not.toEqual(WORKFLOW);
    expect(violations(oneLeg)).toContain('fewer than two sandbox images are qualified');

    const pinnedHostProof = WORKFLOW.replace(
      'MERGESUTRA_RUNTIME_PROOF_IMAGE: ${{ matrix.image }}',
      'MERGESUTRA_RUNTIME_PROOF_IMAGE: node@sha256:' + 'e'.repeat(64),
    );
    expect(pinnedHostProof).not.toEqual(WORKFLOW);
    expect(violations(pinnedHostProof)).toContain(
      'the host-side proof does not run the matrix image',
    );

    const hardcodedStageProof = WORKFLOW.replace(
      'MERGESUTRA_SANDBOX_IMAGE: ${{ matrix.image }}',
      'MERGESUTRA_SANDBOX_IMAGE: node@sha256:' + 'f'.repeat(64),
    );
    expect(hardcodedStageProof).not.toEqual(WORKFLOW);
    expect(violations(hardcodedStageProof)).toContain(
      'the stage proof does not run the matrix image',
    );
  });

  it('rejects removal of stage engine proof or its controlled Docker settings', () => {
    expect(
      violations(
        WORKFLOW.replace('node --import tsx scripts/sandbox-stage-proof.mjs', 'echo skipped'),
      ),
    ).toContain('real Stage 6 and Stage 7 Docker proof not enforced');
    expect(
      violations(WORKFLOW.replace('MERGESUTRA_DOCKER_EXECUTABLE: /usr/bin/docker', '')),
    ).toContain('real Stage 6 and Stage 7 Docker proof not enforced');
  });

  it('rejects lost real-run evidence and a silently ignored failure', () => {
    expect(
      violations(WORKFLOW.replace('node scripts/sandbox-runtime-proof.mjs', 'echo skipped')),
    ).toContain('independent host-side proof does not run');
    expect(
      violations(
        WORKFLOW.replace(
          'node scripts/sandbox-runtime-proof.mjs',
          'node scripts/sandbox-runtime-proof.mjs || true',
        ),
      ),
    ).toContain('unsafe failure suppression or sandbox privilege');
  });
});
