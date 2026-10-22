import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'live-smoke.yml'), 'utf8');
const SCRIPT = readFileSync(path.join(ROOT, 'scripts', 'live-smoke.mjs'), 'utf8');
const RULES = readFileSync(path.join(ROOT, 'scripts', 'lib', 'live-smoke-rules.mjs'), 'utf8');

const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const EVIDENCE_PATH = '.mergesutra/live-smoke-export/';
const JOB_CEILING_MINUTES = 15;

/**
 * What the one-request smoke is allowed to be, and what it is allowed to do.
 *
 * Three files decide this run: the workflow grants it a credential, the script spends it, and the
 * rules module holds the numbers. None of them is a field the next editor can widen by accident,
 * so all three are read as data here and every rule below is made to fire by a planted mutation.
 * The reason this suite exists is the lesson the full validation workflow learned the hard way: a
 * promise about a budget the code behind it does not keep is worse than no promise, because an
 * operator reads it before spending money.
 */

/** The body of a step, from its `- name:` line to the next step or the end of the job. */
function stepOf(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}`);
  if (start < 0) return `__missing_step__:${name}`;
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next < 0 ? rest : rest.slice(0, next);
}

/** The frozen budget block, as the literal text the module declares. */
function budgetFields(rules: string): Record<string, string> {
  const block = /export const SMOKE_BUDGET = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(rules);
  if (!block) return {};
  const fields: Record<string, string> = {};
  for (const line of (block[1] ?? '').split('\n')) {
    const entry = /^\s*(\w+):\s*(.+?),?\s*$/.exec(line);
    if (entry) fields[entry[1] ?? ''] = (entry[2] ?? '').trim();
  }
  return fields;
}

function smokeViolations(workflow: string, script: string, rules: string): string[] {
  const problems: string[] = [];

  if (!/^on:\n {2}workflow_dispatch:/m.test(workflow)) {
    problems.push('the smoke is not manual-only: it has no `workflow_dispatch:` trigger');
  }
  if (/pull_request(?:_target)?:/.test(workflow)) {
    problems.push('the smoke runs on a pull-request event');
  }
  if (/^\s{2}push:/m.test(workflow)) problems.push('the smoke runs on a push');
  if (/^\s{2}schedule:/m.test(workflow) || /^\s{2}workflow_run:/m.test(workflow)) {
    problems.push('the smoke can start itself on a clock or another workflow');
  }
  if ((workflow.match(/contents:\s*read/g) ?? []).length !== 2) {
    problems.push('the workflow and its job must each declare `contents: read`, exactly once');
  }
  if (/contents:\s*write|issues:\s*write|pull-requests:\s*write|id-token:\s*write/.test(workflow)) {
    problems.push('the smoke was granted a write scope');
  }
  const secretRefs = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  if (new Set(secretRefs).size !== 1 || !secretRefs.includes('BHARATCODE_API_KEY')) {
    problems.push(
      `only BHARATCODE_API_KEY may be referenced, saw ${secretRefs.join(',') || '(none)'}`,
    );
  }
  if (workflow.includes('GH_TOKEN') || workflow.includes('GITHUB_TOKEN')) {
    problems.push('the smoke has no GitHub API work to do, so it must be handed no token');
  }
  if (!workflow.includes('default: false'))
    problems.push('the spend switch does not default to false');
  if (!workflow.includes("if: github.ref == 'refs/heads/main' && inputs.run_smoke == true")) {
    problems.push('the smoke can run on a ref other than main, or without the switch');
  }
  if (!workflow.includes('default: qwen-3.8-27b')) {
    problems.push('the selectable model set does not default to qwen-3.8-27b');
  }
  if (!workflow.includes(`timeout-minutes: ${String(JOB_CEILING_MINUTES)}`)) {
    problems.push(`the job ceiling is not ${String(JOB_CEILING_MINUTES)} minutes`);
  }
  for (const line of workflow.split(/\r?\n/).filter((entry) => entry.includes('uses: '))) {
    if (!/@[0-9a-f]{40}\s+#\s+v\d+/.test(line)) {
      problems.push(`an action is not pinned to a verified commit and a tag: ${line.trim()}`);
    }
  }
  if (!/persist-credentials:\s*false/.test(workflow)) {
    problems.push('checkout persists the Actions credential into Git configuration');
  }
  if (!/package-manager-cache:\s*false/.test(workflow)) {
    problems.push('setup-node caches package-manager state into this runner');
  }
  if (!workflow.includes(`path: ${EVIDENCE_PATH}`)) {
    problems.push(`the uploaded artifact is not exactly \`${EVIDENCE_PATH}\``);
  }
  if ((workflow.match(/retention-days:\s*14/g) ?? []).length !== 1) {
    problems.push('the smoke evidence is not retained for exactly the one documented window');
  }
  if (!/if \[ -z "\$\{BHARATCODE_API_KEY:-\}" \]; then/.test(workflow)) {
    problems.push('an unconfigured secret is not refused before the minutes are spent on it');
  }
  if (/echo[^\n]*\$\{?BHARATCODE_API_KEY/.test(workflow))
    problems.push('a shell step prints the credential');
  if (
    !/- name: Refuse an unconfigured secret[\s\S]*?exit 78[\s\S]*?- name: Install/.test(workflow)
  ) {
    problems.push('the credential preflight does not run before install and build');
  }
  // Anything that could widen the request from the workflow would make the budget a negotiation.
  for (const forbidden of [
    'BHARATCODE_TIMEOUT_MS',
    'BHARATCODE_MAX_RETRIES',
    'max_output_tokens',
  ]) {
    if (workflow.includes(forbidden)) {
      problems.push(`the workflow configures ${forbidden}; the budget is code, not an input`);
    }
  }
  // Exactly two steps may name the credential: the preflight that only tests it for emptiness,
  // and the one step that spends it. Install and build must not see it at all.
  const credentialSteps = ['Install', 'Build the adapter this smoke will exercise', 'Setup Node'];
  for (const name of credentialSteps) {
    if (stepOf(workflow, name).includes('BHARATCODE')) {
      problems.push(`the ${name} step holds the model credential`);
    }
  }
  if (
    (workflow.match(/BHARATCODE_API_KEY: \$\{\{ secrets\.BHARATCODE_API_KEY \}\}/g) ?? [])
      .length !== 2
  ) {
    problems.push('the credential must reach exactly the preflight step and the smoke step');
  }
  if (!workflow.includes('run: node scripts/live-smoke.mjs')) {
    problems.push('the credentialed step is not the one-request smoke script');
  }
  if (/run:\s*(?:npm run check|npm test|node scripts\/e2e-validation)/.test(workflow)) {
    problems.push('the smoke re-runs the offline suite or the full chain instead of one request');
  }

  // The script spends the credential. It may do nothing else with it.
  if (/node:child_process|spawnSync|\bexecFile\b|\bexecSync\b|\bexec\(|\beval\(/.test(script)) {
    problems.push(
      'the smoke script can start a process or evaluate code; it must only make a request',
    );
  }
  if (/\bfetch\(/.test(script)) {
    problems.push(
      'the smoke script must reach the provider through the production adapter, not fetch',
    );
  }
  if ((script.match(/client\.complete\(/g) ?? []).length !== 1) {
    problems.push('the smoke script does not hold to exactly one completion call site');
  }
  if ((script.match(/client\.listModels\(\)/g) ?? []).length !== 1) {
    problems.push('the smoke script must read the authenticated catalog exactly once');
  }
  for (const wired of [
    'maxTokens: SMOKE_BUDGET.maxOutputTokens',
    'enableThinking: SMOKE_BUDGET.enableThinking',
    'temperature: SMOKE_BUDGET.temperature',
    'timeoutMs: SMOKE_BUDGET.deadlineMs',
    'maxRetries: SMOKE_BUDGET.maxRetries',
    'AbortSignal.timeout(SMOKE_BUDGET.deadlineMs)',
  ]) {
    if (!script.includes(wired)) {
      problems.push(`the smoke script no longer takes its bound from the rules module: ${wired}`);
    }
  }
  if (/maxTokens:\s*\d|temperature:\s*\d|timeoutMs:\s*\d/.test(script)) {
    problems.push('the smoke script hardcodes a request bound next to the budget it should read');
  }
  if (!script.includes('adapter.requireApiKey(')) {
    problems.push('the smoke script does not use the product’s own missing-credential refusal');
  }
  if (!script.includes('ids.includes(requestedModel)')) {
    problems.push('the smoke does not refuse a model that the authenticated catalog does not list');
  }
  if (!script.includes('credentialLeakFindings(entries, secret)') || !/await rm\(/.test(script)) {
    problems.push('the smoke would upload an artifact without auditing it for credential bytes');
  }
  if (/stdout\.write\([^)]*\bapiKey\b|stderr\.write\([^)]*\bapiKey\b/.test(script)) {
    problems.push('the smoke script writes the raw key to a log');
  }
  // A green exit is the one thing this script can claim about the provider, so it may only be
  // claimed for a verdict that says PASS — and saying it must still end the run.
  if (
    !/if \(verdict\.status === 'PASS'\) \{\s*process\.exitCode = EXIT\.PASS;\s*return;/.test(script)
  ) {
    problems.push('a passing exit no longer follows only a PASS verdict, or does not end the run');
  }

  // The numbers themselves, and the one reading of the stream that counts as an answer.
  const budget = budgetFields(rules);
  const required: Record<string, string> = {
    completionsAsked: '1',
    maxOutputTokens: '512',
    temperature: '0',
    enableThinking: 'false',
    stream: 'true',
    store: 'false',
    deadlineMs: '90_000',
    maxRetries: '0',
  };
  for (const [field, value] of Object.entries(required)) {
    if (budget[field] !== value) {
      problems.push(`SMOKE_BUDGET.${field} is ${budget[field] ?? '(absent)'}, not ${value}`);
    }
  }
  if (!rules.includes("if (finish !== 'stop')")) {
    problems.push('the verdict no longer requires the provider’s own completed terminal event');
  }
  if (!rules.includes('if (elapsedMs > budget.deadlineMs) {')) {
    problems.push('the elapsed time is no longer compared with the ceiling it was given');
  }
  // The ceiling has to fit the job that runs it, with room for install and build.
  const deadlineSeconds = Number((budget.deadlineMs ?? '0').replace(/_/g, '')) / 1000;
  if (Number.isFinite(deadlineSeconds) && deadlineSeconds * 2 > JOB_CEILING_MINUTES * 60) {
    problems.push('the job ceiling no longer leaves the request room to fail inside it');
  }

  return problems;
}

const CLEAN = smokeViolations(WORKFLOW, SCRIPT, RULES);

describe('the one-request live smoke', () => {
  it('obeys every bound written above, against the files that really run', () => {
    expect(CLEAN, CLEAN.join('\n')).toEqual([]);
  });

  it('is manual-only, main-only, and off until a person turns it on', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(WORKFLOW).toContain("if: github.ref == 'refs/heads/main' && inputs.run_smoke == true");
    expect(WORKFLOW).toContain('default: false');
    expect(WORKFLOW).toContain('- qwen-3.8-27b');
    expect(WORKFLOW).toContain('- deepseek-v4.1-flash');
  });

  it('hands the credential to two steps and contacts GitHub with no token at all', () => {
    expect(WORKFLOW).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
    expect(
      (WORKFLOW.match(/BHARATCODE_API_KEY: \$\{\{ secrets\.BHARATCODE_API_KEY \}\}/g) ?? []).length,
    ).toBe(2);
    expect(stepOf(WORKFLOW, 'Install')).not.toContain('BHARATCODE');
    expect(stepOf(WORKFLOW, 'Build the adapter this smoke will exercise')).not.toContain(
      'BHARATCODE',
    );
    const smoke = stepOf(WORKFLOW, 'Send the one bounded request');
    expect(smoke).toContain('BHARATCODE_MODEL: ${{ inputs.model }}');
    expect(smoke).toContain('run: node scripts/live-smoke.mjs');
  });

  it('proves the credential exists before spending install and build minutes on it', () => {
    const preflight = WORKFLOW.indexOf('- name: Refuse an unconfigured secret');
    const install = WORKFLOW.indexOf('- name: Install');
    const smoke = WORKFLOW.indexOf('- name: Send the one bounded request');
    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(install);
    expect(install).toBeLessThan(smoke);
    expect(stepOf(WORKFLOW, 'Refuse an unconfigured secret without printing it')).toContain(
      'exit 78',
    );
    expect(WORKFLOW).toContain('no request was sent');
  });

  it('uploads only the smoke’s own evidence directory, for the documented window', () => {
    expect(
      WORKFLOW.match(new RegExp(`path: ${EVIDENCE_PATH.replace(/\./g, '\\.')}`, 'g')) ?? [],
    ).toHaveLength(1);
    expect(WORKFLOW).not.toMatch(/path:\s*\.mergesutra\s*$/m);
    expect(WORKFLOW.match(/retention-days:\s*14/g) ?? []).toHaveLength(1);
    expect(WORKFLOW).toContain('if-no-files-found: ignore');
  });

  it('spends nothing it was not told to spend', () => {
    expect(budgetFields(RULES)).toMatchObject({
      completionsAsked: '1',
      maxOutputTokens: '512',
      temperature: '0',
      enableThinking: 'false',
      stream: 'true',
      store: 'false',
      deadlineMs: '90_000',
      maxRetries: '0',
    });
    expect(SCRIPT).toContain('maxTokens: SMOKE_BUDGET.maxOutputTokens');
    expect(SCRIPT).toContain('AbortSignal.timeout(SMOKE_BUDGET.deadlineMs)');
  });

  it('cannot run a repository command, by construction', () => {
    expect(SCRIPT).not.toMatch(/node:child_process|spawnSync|execFile|execSync|\beval\(/);
    expect(SCRIPT).not.toMatch(/\bfetch\(/);
    expect(SCRIPT.match(/client\.complete\(/g) ?? []).toHaveLength(1);
    expect(SCRIPT.match(/client\.listModels\(\)/g) ?? []).toHaveLength(1);
  });

  it('audits its own artifact before anything is uploaded', () => {
    expect(SCRIPT).toContain('credentialLeakFindings(entries, secret)');
    expect(SCRIPT).toContain('audit.findings.length === 0');
    expect(SCRIPT).toMatch(/await rm\(/);
  });
});

describe('the policy fires on the mutations it exists for', () => {
  const onWorkflow = (change: (text: string) => string) =>
    smokeViolations(change(WORKFLOW), SCRIPT, RULES);
  const onScript = (change: (text: string) => string) =>
    smokeViolations(WORKFLOW, change(SCRIPT), RULES);
  const onRules = (change: (text: string) => string) =>
    smokeViolations(WORKFLOW, SCRIPT, change(RULES));

  it('fires when the smoke is wired to an automatic trigger', () => {
    expect(
      onWorkflow((text) => text.replace('  workflow_dispatch:', '  workflow_dispatch:\n  push:')),
    ).toContain('the smoke runs on a push');
    expect(
      onWorkflow((text) =>
        text.replace('  workflow_dispatch:', '  workflow_dispatch:\n  pull_request_target:'),
      ),
    ).toContain('the smoke runs on a pull-request event');
  });

  it('fires when the spend switch defaults to true or the job can run off main', () => {
    expect(onWorkflow((text) => text.replace('default: false', 'default: true'))).toContain(
      'the spend switch does not default to false',
    );
    expect(
      onWorkflow((text) =>
        text.replace(
          "if: github.ref == 'refs/heads/main' && inputs.run_smoke == true",
          'if: inputs.run_smoke == true',
        ),
      ),
    ).toContain('the smoke can run on a ref other than main, or without the switch');
  });

  it('fires when the credential reaches a step that has no business holding it', () => {
    expect(
      onWorkflow((text) =>
        text.replace(
          '      - name: Install\n        run: npm ci',
          '      - name: Install\n        env:\n          BHARATCODE_API_KEY: ${{ secrets.BHARATCODE_API_KEY }}\n        run: npm ci',
        ),
      ).join('\n'),
    ).toContain('the Install step holds the model credential');
    expect(
      onWorkflow((text) =>
        text.replace(
          "      NO_COLOR: '1'",
          "      NO_COLOR: '1'\n      GH_TOKEN: ${{ github.token }}",
        ),
      ),
    ).toContain('the smoke has no GitHub API work to do, so it must be handed no token');
  });

  it('fires when a write scope, a floating action or a widened artifact path appears', () => {
    expect(
      onWorkflow((text) =>
        text.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
      ),
    ).toContain('the smoke was granted a write scope');
    expect(onWorkflow((text) => text.replace(CHECKOUT_SHA, 'v6')).join('\n')).toContain(
      'an action is not pinned to a verified commit and a tag',
    );
    expect(
      onWorkflow((text) => text.replace('persist-credentials: false', 'persist-credentials: true')),
    ).toContain('checkout persists the Actions credential into Git configuration');
    expect(onWorkflow((text) => text.replace(EVIDENCE_PATH, '.mergesutra/'))).toContain(
      `the uploaded artifact is not exactly \`${EVIDENCE_PATH}\``,
    );
  });

  it('fires when the budget becomes a workflow input instead of code', () => {
    expect(
      onWorkflow((text) =>
        text.replace(
          '        run: node scripts/live-smoke.mjs',
          '        run: node scripts/live-smoke.mjs\n        # BHARATCODE_TIMEOUT_MS: 540000',
        ),
      ),
    ).toContain('the workflow configures BHARATCODE_TIMEOUT_MS; the budget is code, not an input');
  });

  it('fires when the script is given a process, a second request, or its own numbers', () => {
    expect(
      onScript((text) =>
        text.replace(
          "import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';",
          "import { spawnSync } from 'node:child_process';\nimport { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';",
        ),
      ),
    ).toContain(
      'the smoke script can start a process or evaluate code; it must only make a request',
    );
    expect(
      onScript((text) =>
        text.replace(
          '  const file = await writeEvidence(evidence);',
          '  await client.complete({ messages: SMOKE_MESSAGES, model: requestedModel });\n  const file = await writeEvidence(evidence);',
        ),
      ),
    ).toContain('the smoke script does not hold to exactly one completion call site');
    expect(
      onScript((text) =>
        text.replace('maxTokens: SMOKE_BUDGET.maxOutputTokens', 'maxTokens: 100000'),
      ),
    ).toContain(
      'the smoke script no longer takes its bound from the rules module: maxTokens: SMOKE_BUDGET.maxOutputTokens',
    );
  });

  it('fires when the artifact stops being audited or the catalog stops being checked', () => {
    expect(
      onScript((text) =>
        text.replace('credentialLeakFindings(entries, secret)', 'noLeakCheck(entries, secret)'),
      ),
    ).toContain('the smoke would upload an artifact without auditing it for credential bytes');
    expect(
      onScript((text) => text.replace('ids.includes(requestedModel)', 'ids.length >= 0')),
    ).toContain('the smoke does not refuse a model that the authenticated catalog does not list');
    expect(
      onScript((text) =>
        text.replace(
          "if (verdict.status === 'PASS') {\n    process.exitCode = EXIT.PASS;\n    return;\n  }",
          'process.exitCode = EXIT.PASS;',
        ),
      ),
    ).toContain('a passing exit no longer follows only a PASS verdict, or does not end the run');
  });

  it('fires when a bound is quietly widened, or the terminal event stops being required', () => {
    expect(
      onRules((text) => text.replace('maxOutputTokens: 512', 'maxOutputTokens: 5120')),
    ).toContain('SMOKE_BUDGET.maxOutputTokens is 5120, not 512');
    expect(onRules((text) => text.replace('deadlineMs: 90_000', 'deadlineMs: 600_000'))).toContain(
      'SMOKE_BUDGET.deadlineMs is 600_000, not 90_000',
    );
    expect(onRules((text) => text.replace('maxRetries: 0', 'maxRetries: 3'))).toContain(
      'SMOKE_BUDGET.maxRetries is 3, not 0',
    );
    expect(
      onRules((text) => text.replace("if (finish !== 'stop')", 'if (finish === never)')),
    ).toContain('the verdict no longer requires the provider’s own completed terminal event');
    expect(
      onRules((text) =>
        text.replace(
          'if (elapsedMs > budget.deadlineMs) {',
          'if (elapsedMs > budget.deadlineMs * 6) {',
        ),
      ),
    ).toContain('the elapsed time is no longer compared with the ceiling it was given');
  });

  it('fires when the budget block disappears entirely rather than being narrowed', () => {
    expect(
      onRules((text) =>
        text.replace(/export const SMOKE_BUDGET[\s\S]*?\n\}\);/, 'export const NO_BUDGET = 1;'),
      ),
    ).toContain('SMOKE_BUDGET.maxOutputTokens is (absent), not 512');
  });
});
