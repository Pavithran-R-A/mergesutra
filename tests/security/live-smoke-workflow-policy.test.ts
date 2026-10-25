import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'live-smoke.yml'), 'utf8');
const SCRIPT = readFileSync(path.join(ROOT, 'scripts', 'live-smoke.mjs'), 'utf8');
const RULES = readFileSync(path.join(ROOT, 'scripts', 'lib', 'live-smoke-rules.mjs'), 'utf8');
const WIRE = readFileSync(path.join(ROOT, 'src', 'bharatcode', 'client.ts'), 'utf8');

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

/**
 * The body of `requestPayload` — the one place the shipped adapter decides what the route is sent.
 *
 * An empty string means the function is gone, which is itself the finding: the smoke's artifact
 * would then be describing a wire shape no code produces.
 */
function payloadBlock(source: string): string {
  const start = source.indexOf('function requestPayload(');
  if (start < 0) return '';
  const rest = source.slice(start);
  const end = rest.indexOf('\n}');
  return end < 0 ? rest : rest.slice(0, end);
}

function smokeViolations(workflow: string, script: string, rules: string, wire = WIRE): string[] {
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
  if (/^\s{6}model:/m.test(workflow)) {
    problems.push('the dispatch offers a model choice; this smoke is written for exactly one');
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
    'BHARATCODE_MODEL',
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
  // The dispatch may choose a frozen clock by name. It may not offer a number, a free-text name,
  // or any other smoke setting, because every one of those is code in the rules module.
  const variantInput = /^ {6}variant:\n(?: {8}.*\n)+/m.exec(workflow)?.[0] ?? '';
  if (variantInput === '') {
    problems.push('the dispatch offers no bounded variant selector');
  } else {
    const options = [...variantInput.matchAll(/^ {10}- (\S+)$/gm)].map((match) => match[1]);
    if (options.join(',') !== 'standard,availability') {
      problems.push(
        `the dispatch variant names ${options.join(',') || '(none)'}, not exactly standard,availability`,
      );
    }
    if (!/type:\s*choice/.test(variantInput)) {
      problems.push('the dispatch variant is not a closed choice');
    }
    if (!/default:\s*standard/.test(variantInput)) {
      problems.push('the dispatch variant does not default to the standard clock');
    }
  }
  if ((workflow.match(/MERGESUTRA_LIVE_SMOKE_VARIANT:/g) ?? []).length !== 1) {
    problems.push('the variant name does not reach exactly one step');
  }
  if (!workflow.includes('MERGESUTRA_LIVE_SMOKE_VARIANT: ${{ inputs.variant }}')) {
    problems.push('the smoke step does not receive the dispatch’s variant name');
  }
  for (const name of workflow.matchAll(/MERGESUTRA_LIVE_SMOKE_[A-Z_]+/g)) {
    if (name[0] !== 'MERGESUTRA_LIVE_SMOKE_VARIANT') {
      problems.push(`the workflow configures ${name[0]}; the budget is code, not an input`);
    }
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
  if ((script.match(/client\.complete\w*\(/g) ?? []).length !== 1) {
    problems.push('the smoke script does not hold to exactly one completion call site');
  }
  if ((script.match(/client\.listModels\(\)/g) ?? []).length !== 1) {
    problems.push('the smoke script must read the authenticated catalog exactly once');
  }
  for (const wired of [
    'maxTokens: budget.maxOutputTokens',
    'enableThinking: budget.enableThinking',
    'temperature: budget.temperature',
    'timeoutMs: budget.deadlineMs',
    'maxRetries: budget.maxRetries',
    'AbortSignal.timeout(budget.deadlineMs)',
  ]) {
    if (!script.includes(wired)) {
      problems.push(`the smoke script no longer takes its bound from the rules module: ${wired}`);
    }
  }
  // The variant is a name looked up in a frozen map. There must be no path from an environment
  // value to a number, or the dispatcher could widen the clock the freeze exists to bound.
  if (!script.includes('Object.hasOwn(SMOKE_VARIANTS, variantChoice)')) {
    problems.push('the smoke variant is not looked up in the frozen budget map');
  }
  if (!/if \(budget === null\) \{\s*refuse\(/.test(script)) {
    problems.push('an unknown smoke variant is not refused before any request is sent');
  }
  if (!/\? SMOKE_VARIANTS\[variantChoice\]\s*:\s*null;/.test(script)) {
    problems.push('a known smoke variant does not resolve to its own frozen budget');
  }
  // Every bound after the variant is chosen must come from that choice. A fallback to either
  // global budget would let the artifact describe a 90 s request that the client ran at 270 s.
  const variantAt = script.indexOf('const variantChoice');
  if (variantAt === -1 || /\bSMOKE_BUDGET\w*/.test(script.slice(variantAt))) {
    problems.push('the smoke reads a global budget after choosing a variant');
  }
  // ...and the two places the chosen object is handed on must name it directly. An alias lifted
  // before the choice, or a dropped argument, silently falls back to the module's standard
  // defaults, so a 270 s run could be judged and described against the 90 s clock.
  if (
    !script.includes('smokeVerdict(answer, { elapsedMs, budget })') ||
    !script.includes('    budget,\n  });')
  ) {
    problems.push('the smoke hands the verdict or the evidence a budget other than its chosen one');
  }
  if (/Number\(process\.env|parseInt\(process\.env|parseFloat\(process\.env/.test(script)) {
    problems.push('the smoke reads a request bound from the environment as a number');
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
  if (!script.includes('const requestedModel = SMOKE_BUDGET.model;')) {
    problems.push('the smoke no longer takes the model from its frozen budget');
  }
  if (!script.includes('modelChoice !== requestedModel')) {
    problems.push('the smoke would let BHARATCODE_MODEL point it at another model');
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

  // The wire itself. The smoke prints `stream`, `store`, the token ceiling and the reasoning mode as
  // facts about its request, but only `maxTokens` and `enableThinking` are its own to pass — the
  // shipped adapter decides the rest, so its bytes are part of this budget and not a paraphrase.
  const payload = payloadBlock(wire);
  for (const onTheWire of [
    'max_output_tokens',
    "reasoning: { effort: 'none' }",
    'store: false',
    'stream: true',
  ]) {
    if (!payload.includes(onTheWire)) {
      problems.push(`the adapter no longer puts ${onTheWire} on the wire the smoke reports`);
    }
  }

  // The numbers themselves, and the one reading of the stream that counts as an answer.
  const budget = budgetFields(rules);
  const required: Record<string, string> = {
    completionsAsked: '1',
    model: "'qwen-3.8-27b'",
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
  // The long clock is the same budget with one field replaced. Written as a spread rather than a
  // second literal so a field added to the standard budget cannot go missing from this variant;
  // pinned as literal text so nothing else can be changed alongside the clock.
  if (
    !/export const SMOKE_BUDGET_AVAILABILITY = Object\.freeze\(\{\s*\.\.\.SMOKE_BUDGET,\s*deadlineMs: 270_000,\s*\}\);/.test(
      rules,
    )
  ) {
    problems.push(
      'the availability variant is not the standard budget with only its clock replaced by 270_000',
    );
  }
  if (
    !/export const SMOKE_VARIANTS = Object\.freeze\(\{\s*standard: SMOKE_BUDGET,\s*availability: SMOKE_BUDGET_AVAILABILITY,\s*\}\);/.test(
      rules,
    )
  ) {
    problems.push(
      'the frozen variant map does not name exactly the standard and availability budgets',
    );
  }
  if (!rules.includes("if (finish !== 'stop')")) {
    problems.push('the verdict no longer requires the provider’s own completed terminal event');
  }
  if (!rules.includes('if (elapsedMs > budget.deadlineMs) {')) {
    problems.push('the elapsed time is no longer compared with the ceiling it was given');
  }
  // The provider chooses its own finish reason, model name, answer text and failure wording. None
  // of it may reach the job log or the artifact as bytes that open a second line, because a reader
  // of this job trusts those lines to be this smoke's own verdicts.
  if (!rules.includes('const safeString = (value) => singleLine(redact(value));')) {
    problems.push(
      'the smoke no longer routes every provider-chosen string through both redaction and the one-line filter',
    );
  }
  // The ceiling has to fit the longest budget, with room for install and build.
  const deadlineMilliseconds = [...rules.matchAll(/deadlineMs:\s*([\d_]+)/g)].map((match) =>
    Number((match[1] ?? '').replace(/_/g, '')),
  );
  const deadlineSeconds = Math.max(...deadlineMilliseconds) / 1000;
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds * 2 > JOB_CEILING_MINUTES * 60) {
    problems.push('the job ceiling no longer leaves the longest request room to fail inside it');
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
    expect(WORKFLOW).not.toMatch(/^\s{6}model:/m);
    expect(WORKFLOW).not.toContain('inputs.model');
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
    expect(smoke).not.toContain('BHARATCODE_MODEL');
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
      model: "'qwen-3.8-27b'",
      maxOutputTokens: '512',
      temperature: '0',
      enableThinking: 'false',
      stream: 'true',
      store: 'false',
      deadlineMs: '90_000',
      maxRetries: '0',
    });
    expect(SCRIPT).toContain('maxTokens: budget.maxOutputTokens');
    expect(SCRIPT).toContain('AbortSignal.timeout(budget.deadlineMs)');
  });

  it('offers exactly two frozen clocks, chosen by name and never by number', () => {
    expect(RULES).toMatch(
      /export const SMOKE_BUDGET_AVAILABILITY = Object\.freeze\(\{\s*\.\.\.SMOKE_BUDGET,\s*deadlineMs: 270_000,\s*\}\);/,
    );
    expect(RULES).toMatch(
      /export const SMOKE_VARIANTS = Object\.freeze\(\{\s*standard: SMOKE_BUDGET,\s*availability: SMOKE_BUDGET_AVAILABILITY,\s*\}\);/,
    );
    expect(WORKFLOW).toContain('MERGESUTRA_LIVE_SMOKE_VARIANT: ${{ inputs.variant }}');
    expect(SCRIPT).toContain('Object.hasOwn(SMOKE_VARIANTS, variantChoice)');
    expect(SCRIPT).toMatch(/\? SMOKE_VARIANTS\[variantChoice\]\s*:\s*null;/);
    expect(SCRIPT.slice(SCRIPT.indexOf('const variantChoice'))).not.toMatch(/\bSMOKE_BUDGET\b/);
    expect(SCRIPT).not.toMatch(/Number\(process\.env|parseInt\(process\.env/);
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
  const onWire = (change: (text: string) => string) =>
    smokeViolations(WORKFLOW, SCRIPT, RULES, change(WIRE));

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

  it('fires when the model stops being a bound and becomes a choice', () => {
    expect(
      onWorkflow((text) =>
        text.replace(
          '        type: boolean',
          `        type: boolean
      model:
        required: true
        default: 'qwen-3.8-27b'
        type: choice
        options:
          - qwen-3.8-27b
          - deepseek-v4.1-flash`,
        ),
      ),
    ).toContain('the dispatch offers a model choice; this smoke is written for exactly one');
    expect(
      onWorkflow((text) =>
        text.replace(
          '          MERGESUTRA_LIVE_SMOKE_VARIANT: ${{ inputs.variant }}',
          '          BHARATCODE_MODEL: ${{ inputs.model }}\n          MERGESUTRA_LIVE_SMOKE_VARIANT: ${{ inputs.variant }}',
        ),
      ),
    ).toContain('the workflow configures BHARATCODE_MODEL; the budget is code, not an input');
    expect(
      onScript((text) =>
        text.replace(
          'const requestedModel = SMOKE_BUDGET.model;',
          "const requestedModel = (process.env.BHARATCODE_MODEL ?? 'qwen-3.8-27b').trim();",
        ),
      ),
    ).toContain('the smoke no longer takes the model from its frozen budget');
    expect(
      onScript((text) => text.replace('modelChoice !== requestedModel', 'modelChoice.length > 64')),
    ).toContain('the smoke would let BHARATCODE_MODEL point it at another model');
    expect(
      onRules((text) => text.replace("model: 'qwen-3.8-27b'", "model: 'deepseek-v4.1-flash'")),
    ).toContain("SMOKE_BUDGET.model is 'deepseek-v4.1-flash', not 'qwen-3.8-27b'");
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
        text.replace(
          '  const file = await writeEvidence(evidence);',
          '  await client.completeStructured({ messages: SMOKE_MESSAGES, model: requestedModel, schema: answerSchema });\n  const file = await writeEvidence(evidence);',
        ),
      ),
    ).toContain('the smoke script does not hold to exactly one completion call site');
    expect(
      onScript((text) => text.replace('maxTokens: budget.maxOutputTokens', 'maxTokens: 100000')),
    ).toContain(
      'the smoke script no longer takes its bound from the rules module: maxTokens: budget.maxOutputTokens',
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
    expect(onRules((text) => text.replace('store: false', 'store: true'))).toContain(
      'SMOKE_BUDGET.store is true, not false',
    );
    expect(onRules((text) => text.replace('stream: true', 'stream: false'))).toContain(
      'SMOKE_BUDGET.stream is false, not true',
    );
    expect(
      onRules((text) => text.replace(/^ {2}enableThinking: false,/m, '  enableThinking: true,')),
    ).toContain('SMOKE_BUDGET.enableThinking is true, not false');
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

  it('fires when the long clock, the variant map, or the dispatch selector is widened', () => {
    expect(onRules((text) => text.replace('deadlineMs: 270_000', 'deadlineMs: 600_000'))).toContain(
      'the availability variant is not the standard budget with only its clock replaced by 270_000',
    );
    expect(
      onRules((text) =>
        text.replace(
          'availability: SMOKE_BUDGET_AVAILABILITY,',
          'availability: SMOKE_BUDGET_AVAILABILITY,\n  turbo: SMOKE_BUDGET,',
        ),
      ),
    ).toContain(
      'the frozen variant map does not name exactly the standard and availability budgets',
    );
    expect(onWorkflow((text) => text.replace('type: choice', 'type: string'))).toContain(
      'the dispatch variant is not a closed choice',
    );
    expect(
      onWorkflow((text) =>
        text.replace('          - availability', '          - availability\n          - turbo'),
      ),
    ).toContain(
      'the dispatch variant names standard,availability,turbo, not exactly standard,availability',
    );
    expect(
      onScript((text) =>
        text.replace(
          'const budget = Object.hasOwn(SMOKE_VARIANTS, variantChoice)',
          'const budget = { ...SMOKE_BUDGET, deadlineMs: Number(process.env.DEADLINE_MS) } ?? Object.hasOwn(SMOKE_VARIANTS, variantChoice)',
        ),
      ),
    ).toContain('the smoke reads a request bound from the environment as a number');
    expect(
      onScript((text) => text.replace('Object.hasOwn(SMOKE_VARIANTS, variantChoice)', 'true')),
    ).toContain('the smoke variant is not looked up in the frozen budget map');
    expect(onScript((text) => text.replace('if (budget === null) {', 'if (false) {'))).toContain(
      'an unknown smoke variant is not refused before any request is sent',
    );
    expect(
      onScript((text) =>
        text.replace(
          '    ? SMOKE_VARIANTS[variantChoice]\n    : null;',
          '    ? SMOKE_VARIANTS[variantChoice]\n    : SMOKE_BUDGET_AVAILABILITY;',
        ),
      ),
    ).toContain('a known smoke variant does not resolve to its own frozen budget');
    expect(
      onScript((text) => text.replace('    budget,\n  });', '    budget: SMOKE_BUDGET,\n  });')),
    ).toContain('the smoke reads a global budget after choosing a variant');
    expect(
      onScript((text) =>
        text.replace(
          'smokeVerdict(answer, { elapsedMs, budget })',
          'smokeVerdict(answer, { elapsedMs, budget: SMOKE_BUDGET_AVAILABILITY })',
        ),
      ),
    ).toContain('the smoke reads a global budget after choosing a variant');
  });

  it('fires when the chosen budget is not the object handed to the verdict or the evidence', () => {
    // A lifted alias is defined before the choice, so a scan that only starts at `variantChoice`
    // never sees it; the call sites themselves have to name the chosen object.
    expect(
      onScript((text) =>
        text
          .replace(
            '  const variantChoice',
            '  const liftedBudget = SMOKE_BUDGET;\n  const variantChoice',
          )
          .replace('    budget,\n  });', '    budget: liftedBudget,\n  });'),
      ),
    ).toContain('the smoke hands the verdict or the evidence a budget other than its chosen one');
    // Dropping the argument is the quiet version of the same fallback: the rules module's
    // default is the standard budget, so a 270 s run would be judged against 90 s.
    expect(onScript((text) => text.replace('    budget,\n  });', '  });'))).toContain(
      'the smoke hands the verdict or the evidence a budget other than its chosen one',
    );
    // The verdict is the other place a default can quietly replace the chosen clock.
    expect(onScript((text) => text.replace(', budget })', ', budget: liftedBudget })'))).toContain(
      'the smoke hands the verdict or the evidence a budget other than its chosen one',
    );
  });

  it('fires when the smoke is handed a transport of its own or a provider string stops being filtered', () => {
    expect(
      onScript((text) =>
        text.replace(
          '  const client = adapter.createBharatCodeClient({',
          "  const raw = await fetch('https://bharatcode.ai/api/model/v1/responses');\n  await raw.text();\n  const client = adapter.createBharatCodeClient({",
        ),
      ),
    ).toContain(
      'the smoke script must reach the provider through the production adapter, not fetch',
    );
    expect(
      onRules((text) =>
        text.replace(
          'const safeString = (value) => singleLine(redact(value));',
          "const safeString = (value) => String(value ?? '');",
        ),
      ),
    ).toContain(
      'the smoke no longer routes every provider-chosen string through both redaction and the one-line filter',
    );
  });

  it('fires when the adapter stops putting the fields the smoke reports onto the wire', () => {
    expect(onWire((text) => text.replace('    store: false,', '    store: true,'))).toContain(
      'the adapter no longer puts store: false on the wire the smoke reports',
    );
    expect(
      onWire((text) => text.replace('    stream: true,', '    stream: request.stream ?? true,')),
    ).toContain('the adapter no longer puts stream: true on the wire the smoke reports');
    expect(
      onWire((text) => text.replace("{ reasoning: { effort: 'none' } }", "{ reasoning: 'off' }")),
    ).toContain(
      "the adapter no longer puts reasoning: { effort: 'none' } on the wire the smoke reports",
    );
    expect(
      onWire((text) => text.replace('{ max_output_tokens: request.maxTokens }', '{ maxTokens }')),
    ).toContain('the adapter no longer puts max_output_tokens on the wire the smoke reports');
    expect(
      onWire((text) => text.replace(/function requestPayload\([\s\S]*?\n\}/, 'const removed = 1;')),
    ).toHaveLength(4);
  });

  it('fires when the budget block disappears entirely rather than being narrowed', () => {
    expect(
      onRules((text) =>
        text.replace(/export const SMOKE_BUDGET[\s\S]*?\n\}\);/, 'export const NO_BUDGET = 1;'),
      ),
    ).toContain('SMOKE_BUDGET.maxOutputTokens is (absent), not 512');
  });
});
