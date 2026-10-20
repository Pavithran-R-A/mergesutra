import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'draft-publication.yml'),
  'utf8',
);
const RUNNER = readFileSync(path.join(ROOT, 'scripts', 'publish-draft.mjs'), 'utf8');
const LIVE = readFileSync(path.join(ROOT, '.github', 'workflows', 'live-validation.yml'), 'utf8');

const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const SETUP_NODE_SHA = '249970729cb0ef3589644e2896645e5dc5ba9c38';
const UPLOAD_SHA = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
const RUNNER_ARGUMENTS = [
  '--bundle "$BUNDLE_DIR"',
  '--approval "$APPROVAL_DIGEST"',
  '--repository "$GITHUB_WORKSPACE"',
  '--root "$GITHUB_WORKSPACE/.mergesutra/publication-run"',
];

/**
 * The write-scoped publication workflow, read as data.
 *
 * Its two neighbours hold the same line from opposite sides: the live job has the
 * model credential and read-only GitHub permissions, and this job has the write
 * token and no model credential. Nothing may quietly move either across. The rest
 * of the policy is about the one thing this workflow can do that no other can —
 * create a branch, a commit and a draft pull request — and the fact that a person,
 * a completed successful run on main, and an approval digest are all required
 * before the product is allowed to construct that write.
 */
describe('draft publication is manual, main-only and write-scoped', () => {
  it('runs only when a person dispatches it, and never on a push or a pull request', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(WORKFLOW).not.toMatch(/pull_request(?:_target)?:/);
    expect(WORKFLOW).not.toMatch(/^\s*push:/m);
    expect(WORKFLOW).not.toMatch(/workflow_run|schedule:|repository_dispatch/);
  });

  it('requires both the source run and the approved digest as text inputs', () => {
    expect(WORKFLOW).toMatch(
      / {6}run_id:\n {8}description: .+\n {8}required: true\n {8}type: string/,
    );
    expect(WORKFLOW).toMatch(
      / {6}approval_digest:\n {8}description: .+\n {8}required: true\n {8}type: string/,
    );
  });

  it('keeps the workflow read-only at the top and grants writes only to the publish job', () => {
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(WORKFLOW).toMatch(
      /jobs:\n {2}publish-draft:[\s\S]*? {4}permissions:\n {6}contents: write\n {6}pull-requests: write\n {6}actions: read\n/,
    );
    expect(WORKFLOW.match(/contents:\s*write/g) ?? []).toHaveLength(1);
    expect(WORKFLOW.match(/pull-requests:\s*write/g) ?? []).toHaveLength(1);
    expect(WORKFLOW.match(/actions:\s*read/g) ?? []).toHaveLength(1);
    expect(WORKFLOW).not.toMatch(/id-token|issues:\s*write|packages:\s*write|deployments:\s*write/);
  });

  it('refuses to run from any ref other than main', () => {
    expect(WORKFLOW).toContain("if: github.ref == 'refs/heads/main'");
    expect(WORKFLOW).toContain('[ "$GITHUB_REF" != "refs/heads/main" ]');
  });

  it('never receives a repository secret or a model credential', () => {
    expect(WORKFLOW).not.toMatch(/secrets\./);
    expect(WORKFLOW).not.toMatch(/BHARATCODE|bc_live_|NPM_TOKEN|NODE_AUTH_TOKEN/);
    expect(WORKFLOW.match(/GH_TOKEN:\s*\$\{\{ github\.token \}\}/g) ?? []).toHaveLength(3);
  });

  it('hands the write token only to the steps that read runs or publish', () => {
    const build = WORKFLOW.slice(WORKFLOW.indexOf('- name: Build'));
    const determinism = build.slice(
      0,
      build.indexOf('- name: Download the sanitized live artifact'),
    );
    expect(determinism).not.toContain('GH_TOKEN');
    const publish = WORKFLOW.slice(WORKFLOW.indexOf('- name: Publish the approved draft'));
    expect(publish.slice(0, publish.indexOf('run:'))).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('passes every input through env rather than into the script text', () => {
    const references = WORKFLOW.split(/\r?\n/).filter((line) => line.includes('${{ inputs.'));
    expect(references.length).toBeGreaterThan(0);
    for (const line of references) {
      expect(line).toMatch(/^\s+[A-Z][A-Z0-9_]*:\s*\$\{\{\s*inputs\.\w+\s*\}\}\s*$/);
    }
    expect(WORKFLOW).not.toMatch(/\$\{\{\s*github\.event\.inputs/);
  });

  it('pins every external action to an immutable verified commit', () => {
    expect(
      WORKFLOW.match(new RegExp(`actions/checkout@${CHECKOUT_SHA} # v6`, 'g')) ?? [],
    ).toHaveLength(1);
    expect(
      WORKFLOW.match(new RegExp(`actions/setup-node@${SETUP_NODE_SHA} # v6`, 'g')) ?? [],
    ).toHaveLength(1);
    expect(
      WORKFLOW.match(new RegExp(`actions/upload-artifact@${UPLOAD_SHA} # v4`, 'g')) ?? [],
    ).toHaveLength(1);
    for (const line of WORKFLOW.split(/\r?\n/).filter((line) => line.includes('uses: '))) {
      expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\d+/);
    }
  });

  it('checks out main completely without persisting the write token', () => {
    expect(WORKFLOW).toMatch(/ {8}ref: main/);
    expect(WORKFLOW).toMatch(/fetch-depth:\s*0/);
    expect(WORKFLOW).toMatch(/persist-credentials:\s*false/);
    expect(WORKFLOW).toMatch(/node-version:\s*'24\.x'/);
    expect(WORKFLOW).toMatch(/package-manager-cache:\s*false/);
  });

  it('verifies the source run is a completed, successful live validation reachable from main', () => {
    expect(WORKFLOW).toContain('--json status,conclusion,event,headBranch,headSha,workflowName');
    for (const claim of [
      'run.status !== "completed"',
      'run.conclusion !== "success"',
      'run.event !== "workflow_dispatch"',
      'run.headBranch !== "main"',
      'run.workflowName !== "Controlled live validation"',
    ]) {
      expect(WORKFLOW).toContain(claim);
    }
    expect(WORKFLOW).toContain('git merge-base --is-ancestor "$head_sha" origin/main');
  });

  it('downloads exactly the artifact naming the source run and finds exactly one bundle', () => {
    expect(WORKFLOW).toContain('gh run download "$RUN_ID" --name "live-model-$RUN_ID"');
    expect(WORKFLOW).toContain('find "$artifact" -type f -name bundle.json -print');
    expect(WORKFLOW).toContain('"${#bundles[@]}" -ne 1');
    expect(WORKFLOW).toContain('the publication bundle escaped the download directory');
  });

  it('refuses a bundle path that could inject a second GITHUB_ENV line', () => {
    const guard = '[[ "$bundle_dir" == *[[:cntrl:]]* ]]';
    const guardAt = WORKFLOW.indexOf(guard);
    const writeAt = WORKFLOW.indexOf('echo "BUNDLE_DIR=$bundle_dir" >> "$GITHUB_ENV"');

    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(writeAt);
    expect(WORKFLOW).toContain('the publication bundle path contains control characters');
  });

  it('builds, then downloads, then runs the product runner, then preserves its receipt', () => {
    const positions = [
      'run: npm ci',
      'run: npm run build',
      'gh run download "$RUN_ID"',
      'node scripts/publish-draft.mjs',
      'actions/upload-artifact@',
    ].map((needle) => {
      const index = WORKFLOW.indexOf(needle);
      expect(index, `${needle} is missing`).toBeGreaterThanOrEqual(0);
      return index;
    });
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1] ?? -1);
    }
  });

  it('invokes the runner with the downloaded bundle, the typed approval and the checkout', () => {
    for (const argument of RUNNER_ARGUMENTS) expect(WORKFLOW).toContain(argument);
    expect(WORKFLOW).toContain('node scripts/publish-draft.mjs \\');
  });

  it('uploads the receipt even when publication refuses or fails', () => {
    expect(WORKFLOW).toMatch(
      /- name: Upload the publication receipt\n {8}if: always\(\)\n {8}uses: actions\/upload-artifact@/,
    );
    expect(WORKFLOW).toContain('path: .mergesutra/publication-run/publication-result.json');
    expect(WORKFLOW).toContain('if-no-files-found: error');
  });

  it('never merges, pushes from the workflow, forces a ref or swallows a failure', () => {
    expect(WORKFLOW).not.toMatch(/continue-on-error|\|\|\s*true/);
    expect(WORKFLOW).not.toMatch(/git push|gh pr merge|--force\b/);
    expect(WORKFLOW).not.toMatch(/pulls\/\d+\/merge/);
  });
});

describe('the publication runner keeps the two credentials apart', () => {
  it('refuses to start when any model credential is present', () => {
    expect(RUNNER).toContain(
      "const MODEL_VARIABLES = ['BHARATCODE_API_KEY', 'BHARATCODE_KEY', 'BHARATCODE_MODEL'];",
    );
    expect(RUNNER).toContain('function assertSeparation()');
    expect(RUNNER).toContain('This job must never hold a model credential');
    const separation = RUNNER.indexOf('assertSeparation();');
    const publication = RUNNER.indexOf('await runPublication({');
    expect(separation).toBeGreaterThan(0);
    expect(publication).toBeGreaterThan(separation);
  });

  it('scopes the bundle to this repository before it stages or prepares anything', () => {
    const check = RUNNER.indexOf(
      'bundle.identity.repository.toLowerCase() !== expectedRepository.toLowerCase()',
    );
    const publication = RUNNER.indexOf('await runPublication({');
    expect(check).toBeGreaterThan(0);
    expect(publication).toBeGreaterThan(check);
    expect(RUNNER).toContain("await writeReceipt('REFUSED', reason, bundle);");
  });

  it('publishes through the product, which repeats the approval and the measurement', () => {
    expect(RUNNER).toContain("import { runPublication } from './lib/publication-publish.mjs';");
    expect(RUNNER).toContain("'pr',");
    expect(RUNNER).toContain("'--approve',");
    expect(RUNNER).toContain("'--publish',");
    expect(RUNNER).toContain('spawnSync(\n    process.execPath,');
  });

  it('takes the model credential out of the child environment as well', () => {
    expect(RUNNER).toContain('for (const name of MODEL_VARIABLES) delete env[name];');
  });

  it('never speaks to GitHub itself and never merges', () => {
    expect(RUNNER).not.toMatch(/\bgh api\b|\bgit push\b|\bgh pr merge\b|pulls\/\d+\/merge/);
    expect(RUNNER).not.toMatch(/\bgh\s+['"]/);
  });

  it('reports every outcome and distinguishes refusal from failure', () => {
    expect(RUNNER).toContain('const EXIT = { PUBLISHED: 0, REFUSED: 3, FAILED: 4, CONFIG: 78 };');
    expect(RUNNER).toContain("await writeReceipt('PUBLISHED'");
    expect(RUNNER).toContain("await writeReceipt('REFUSED'");
    expect(RUNNER).toContain("await writeReceipt('FAILED'");
    expect(RUNNER).toContain("status === 'PUBLISHED'");
  });
});

describe('the live workflow and the publication workflow are separate jobs', () => {
  it('the live workflow never gains write permissions and never mentions the publisher', () => {
    expect(LIVE).not.toMatch(/contents:\s*write|pull-requests:\s*write|actions:\s*read/);
    expect(LIVE).not.toContain('publish-draft');
    expect(LIVE).not.toContain('draft-publication');
  });

  it('the publication workflow is the only one with the write token', () => {
    expect(WORKFLOW).toContain('GH_TOKEN: ${{ github.token }}');
    expect(LIVE.match(/GH_TOKEN:\s*\$\{\{ github\.token \}\}/g) ?? []).toHaveLength(2);
    expect(WORKFLOW).not.toContain('BHARATCODE_API_KEY');
    expect(LIVE).toContain('BHARATCODE_API_KEY');
  });
});
