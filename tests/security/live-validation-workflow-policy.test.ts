import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'live-validation.yml'),
  'utf8',
);
const DRIVER = readFileSync(path.join(ROOT, 'scripts', 'e2e-validation.mjs'), 'utf8');
const LIVE_RULES = readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'live-qualification.mjs'),
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
  it('is manual-only and never runs from push or pull-request events', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(WORKFLOW).not.toMatch(/pull_request(?:_target)?:/);
    expect(WORKFLOW).not.toMatch(/^\s*push:/m);
  });

  it('keeps the workflow and both jobs read-only on GitHub', () => {
    expect(WORKFLOW.match(/contents:\s*read/g) ?? []).toHaveLength(3);
    expect(WORKFLOW).not.toMatch(/contents:\s*write|issues:\s*write|pull-requests:\s*write/);
    expect(WORKFLOW).not.toMatch(/id-token:\s*write/);
  });

  it('allows only the BharatCode repository secret, even when scoped to multiple steps', () => {
    const refs = [...WORKFLOW.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
    expect(new Set(refs)).toEqual(new Set(['BHARATCODE_API_KEY']));
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

  it('requires a deliberate live trigger and restricts the selectable model set', () => {
    expect(WORKFLOW).toContain('default: deepseek-v4.1-flash');
    expect(WORKFLOW).toContain('- deepseek-v4.1-flash');
    expect(WORKFLOW).not.toContain('- qwen-3.8-27b');
    const live = job('live-model');
    expect(live).toContain("if: github.ref == 'refs/heads/main' && inputs.run_live == true");
    expect(live).toContain('needs: no-key-chain');
    expect(live).toContain('BHARATCODE_MODEL: ${{ inputs.model }}');
    expect(live).toContain('timeout-minutes: 30');
    expect(live).toContain('node scripts/e2e-validation.mjs live');
  });

  it('keeps the BharatCode secret out of install, audit and deterministic test steps', () => {
    const live = job('live-model');
    expect(live).not.toMatch(/env:\n\s+GH_TOKEN:[\s\S]*BHARATCODE_API_KEY:[\s\S]*steps:/);
    const deterministic = live.slice(
      live.indexOf('- name: Install'),
      live.indexOf('- name: Run the bounded real-model chain'),
    );
    expect(deterministic).not.toContain('BHARATCODE_API_KEY');
    expect(deterministic).not.toContain('BHARATCODE_MODEL');
    const modelStep = live.slice(live.indexOf('- name: Run the bounded real-model chain'));
    expect(modelStep).toContain('BHARATCODE_API_KEY: ${{ secrets.BHARATCODE_API_KEY }}');
    expect(modelStep).toContain('BHARATCODE_MODEL: ${{ inputs.model }}');
    expect(modelStep).toContain("BHARATCODE_TIMEOUT_MS: '300000'");
    expect(modelStep).toContain("BHARATCODE_MAX_RETRIES: '0'");
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
    expect(WORKFLOW).not.toMatch(/(?:^|\n)\s*(?:env|printenv|set)\b[^\n]*BHARATCODE/i);
    expect(WORKFLOW).not.toMatch(/echo[^\n]*bc_live_|echo[^\n]*sk-/i);
  });

  it('fails live qualification when the fixture is incomplete despite green repository gates', () => {
    expect(LIVE_RULES).toContain("implementation?.status !== 'COMPLETED_BY_MODEL'");
    expect(LIVE_RULES).toContain('fixture-independent-acceptance');
    expect(LIVE_RULES).toContain('fixture-check-file');
    expect(LIVE_RULES).toContain('checkContainsAllThreeAssertions');
    expect(LIVE_RULES).toContain('dependencyFree');
    expect(LIVE_RULES).toContain('if (!review || review.findings.length > 0)');
    expect(LIVE_RULES).toContain('completionCount > MAX_MODEL_COMPLETIONS');
    expect(LIVE_RULES).toContain('observed model requests exceeded the chain ceiling');
    expect(LIVE_RULES).toContain('MAX_MODEL_COMPLETIONS = 12');
    expect(DRIVER).toContain(
      [
        '    const failures = liveQualificationFailures({',
        '      completionCount,',
        '      elapsedMs: Date.now() - startedAt,',
        '      deadlineMs: LIVE_DEADLINE_MS,',
        '      verifyExit,',
        '      implementation,',
        '      fixtureProof,',
        '      review,',
        '      repairPlanPresent: Boolean(finalRecord?.repairPlan),',
        '    });',
        '    for (const failure of failures) fail(failure);',
      ].join('\n'),
    );
    expect(DRIVER).toContain('inspectFixtureAcceptance({');
    expect(DRIVER).toContain('run: exec');
    expect(DRIVER).toContain('env: childEnv({ publicGit: true })');
    expect(DRIVER).toContain('fixtureAcceptance: fixtureProof');
  });

  it('initializes implementation evidence before independent fixture acceptance', () => {
    const declaration = DRIVER.indexOf(
      'const implementation = implementRecord?.implementation ?? finalRecord?.implementation ?? null;',
    );
    const fixtureCheck = DRIVER.indexOf('const changed = implementation?.changes?.map(');
    expect(declaration).toBeGreaterThan(0);
    expect(fixtureCheck).toBeGreaterThan(declaration);
  });

  it('records the model stages separately rather than trusting a final stage snapshot', () => {
    expect(DRIVER).toContain('planRecord = plan.json.record');
    expect(DRIVER).toContain('implementRecord = implement.json.record');
    expect(DRIVER).toContain('reviewRecord = review.json.record');
    expect(DRIVER).toContain('verifyRecord = verify.json.record');
  });
  it('reports the same fixture branch and issue that it actually clones', () => {
    expect(DRIVER).toContain("const FIXTURE_BRANCH = 'main';");
    expect(DRIVER).toContain(
      "const ISSUE_URL = 'https://github.com/Pavithran-R-A/mergesutra/issues/8';",
    );
    expect(DRIVER).toContain('branch: FIXTURE_BRANCH');
    expect(DRIVER).not.toContain("branch: 'e2e-fixture'");
  });
});
