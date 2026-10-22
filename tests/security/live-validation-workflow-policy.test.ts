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
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const LIVE_RULES = readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'live-qualification.mjs'),
  'utf8',
);
const RUNTIME_PROOF = readFileSync(path.join(ROOT, 'scripts', 'sandbox-runtime-proof.mjs'), 'utf8');
const PROCEDURE = readFileSync(path.join(ROOT, 'docs', 'REAL_MODEL_E2E_PROCEDURE.md'), 'utf8');

const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const SETUP_NODE_SHA = '249970729cb0ef3589644e2896645e5dc5ba9c38';
const UPLOAD_SHA = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
const SANDBOX_IMAGE =
  'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';

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
    expect(WORKFLOW).toContain('default: qwen-3.8-27b');
    expect(WORKFLOW).toContain('- qwen-3.8-27b');
    expect(WORKFLOW).toContain('- deepseek-v4.1-flash');
    expect(WORKFLOW).toContain('DeepSeek requires Pro');
    const live = job('live-model');
    expect(live).toContain("if: github.ref == 'refs/heads/main' && inputs.run_live == true");
    expect(live).toContain('needs: no-key-chain');
    expect(live).toContain('BHARATCODE_MODEL: ${{ inputs.model }}');
    // The 25-minute chain deadline is enforced by the driver; this job ceiling also
    // has to cover the install, build, image pull and no-spend boundary proof that
    // must finish before the first model request can start.
    expect(live).toContain('timeout-minutes: 45');
    expect(live).toContain('node scripts/e2e-validation.mjs live');
  });

  it('keeps the BharatCode secret out of install, audit and deterministic test steps', () => {
    const live = job('live-model');
    expect(live).not.toMatch(/env:\n\s+GH_TOKEN:[\s\S]*BHARATCODE_API_KEY:[\s\S]*steps:/);
    const deterministic = live.slice(
      live.indexOf('- name: Install'),
      live.indexOf('- name: Verify selected model is in the authenticated catalog'),
    );
    expect(deterministic).not.toContain('BHARATCODE_API_KEY');
    expect(deterministic).not.toContain('BHARATCODE_MODEL');
    const modelStep = live.slice(live.indexOf('- name: Run the bounded real-model chain'));
    expect(modelStep).toContain('BHARATCODE_API_KEY: ${{ secrets.BHARATCODE_API_KEY }}');
    expect(modelStep).toContain('BHARATCODE_MODEL: ${{ inputs.model }}');
    // Below the transport's own ceiling, not above it. Node's fetch aborts a request whose
    // response headers never arrive at ~300s with
    // UND_ERR_HEADERS_TIMEOUT, whichever way this setting is configured — the bound is the
    // transport's, so this cap can never be the thing that waits longer than it. Proved
    // offline on this host: a local listener that accepts a connection and never answers,
    // Node 24 `fetch`, this variable set above the bound — rejected at about 306s with the
    // abort reason still our own sentinel unused. Run 39460563729 filled 304.5s of step
    // time with a network failure while this said 540000. A cap at exactly 300000 loses
    // that race nondeterministically (run 39445715858 reported the same wall of time as a
    // timeout), so the live job sets one below it and the failure names the budget
    // reached. The route answers as a stream, so once the stream opens this budget is
    // enforced on every read of the answer; the bound that still caps the figure is the
    // one before the headers arrive.
    // The driver runs the chain against the 25-minute wall clock: it will not
    // start a command once the clock is spent and gives each one the time left on it.
    expect(modelStep).toContain("BHARATCODE_TIMEOUT_MS: '290000'");
    expect(modelStep).toContain("BHARATCODE_MAX_RETRIES: '0'");
  });

  it('states the transport bound instead of promising a cap it cannot honour', () => {
    // The defect this catches is the one shipped in PR #46: a comment here and a claim in
    // README.md that a larger per-request cap buys patience, when the transport settles a
    // request whose headers never arrive at ~300s regardless — the bound is the transport's
    // on the headers, whichever shape the request asks the answer to arrive in. Every file
    // that documents the variable
    // makes the promise, so all of them are swept together — the procedure document is the
    // one an operator follows by hand, and it is where the figure is actually configured.
    const prose = `${WORKFLOW}\n${README}\n${PROCEDURE}`;
    // The bound has to be stated where the variable is documented, not merely somewhere:
    // a README that mentions ~300 s in one place and promises an unlimited cap in the
    // bullet itself is the document that misled the operator.
    const bullet = README.split(/\n(?=\/\* |- \*\*`)/).find((entry) =>
      entry.includes('BHARATCODE_TIMEOUT_MS'),
    );
    expect(bullet, 'README documents BHARATCODE_TIMEOUT_MS in its own bullet').toBeDefined();
    // The same pin as the procedure's row, not a spelling of it: `300 s`, `300s` and `~300 s`
    // all state the bound, and a bullet that says none of them must not pass because it wrote
    // `300  s` or `~300 seconds` where this looked for one exact substring.
    expect(bullet).toMatch(/~?300\s*s/);
    // Same rule for the procedure document: its row for this variable is the sentence an
    // operator reads before raising the cap by hand, so the bound belongs in that row.
    const row = PROCEDURE.split('\n').find((line) => line.includes('BHARATCODE_TIMEOUT_MS'));
    expect(row, 'the procedure documents BHARATCODE_TIMEOUT_MS in its own row').toBeDefined();
    // Not `300` anywhere in the line: a row that says `6300 ms` or counts three retries
    // would satisfy that and still promise patience the transport will not grant. The bound
    // is a span of seconds and the transport names itself, so the row has to carry both.
    expect(row, `${row}\n...names no transport bound`).toMatch(/~?300\s*s/);
    expect(row, `${row}\n...names no transport error`).toContain('UND_ERR_HEADERS_TIMEOUT');
    // The live job's own value is the only configured one, and it sits under the bound.
    const configured = prose.match(/BHARATCODE_TIMEOUT_MS:\s*'?(\d+)/g) ?? [];
    expect(configured).toHaveLength(1);
    expect(configured[0]).toContain('290000');
    // Any other figure written as a number of milliseconds is a budget promised above
    // the bound. Run and probe IDs are not followed by `ms`, so they do not trip this.
    // Thousands separators come out first, because a cap is the one number an operator
    // copies from a dashboard: `600,000 ms` is the same promise as `600000 ms`, and a
    // digit run that stops at a comma would let it into the documentation untouched —
    // worse, the seconds sweep below would read the orphaned `000 s` as three hundred.
    const counted = prose.replace(/(?<=\d),(?=\d)/g, '');
    for (const digits of counted.replace(/'290000'/g, '').match(/\b(\d{5,})\s*ms\b/g) ?? []) {
      const ms = Number(digits.replace(/\D/g, ''));
      expect(ms, `${digits} is promised above the transport bound`).toBeLessThan(300_000);
    }
    // The same mistake written in seconds instead of milliseconds. What is swept is a
    // hand-raised cap: a number of seconds that is a round multiple of ten, in any of the
    // spellings a person uses — `540 s`, `540s`, `540 seconds`, `540-second`, `1000s`. A
    // measured figure is not that shape, which is why the transport's own 304.5 s and 306 s
    // give-ups stay in these documents untouched while `~300 s` is checked and passes.
    // Minutes are deliberately not swept: the only minutes figures here are the run's own
    // wall clock, a ceiling the cap has to stay *under* rather than a promise of patience,
    // and no shape test tells those two sentences apart.
    for (const promise of counted.match(/\b\d{2,4}[\s-]*(?:seconds|second|secs|sec|s)\b/g) ?? []) {
      const seconds = Number(promise.replace(/\D/g, ''));
      if (seconds % 10 !== 0) continue;
      expect(seconds, `${promise} is promised above the transport bound`).toBeLessThanOrEqual(300);
    }
  });

  it('describes the wall clock the way the driver actually enforces it', () => {
    // The live step's comment tells the operator what happens when the 25 minutes run out.
    // It used to say each command is killed at "its share" of the clock, which is not what
    // the driver does: it refuses to start a command once the deadline has passed, and
    // gives a command it does start the less of its own ceiling and the time left. A
    // promise about the clock is only worth what the code behind it is worth, so the
    // promise and the code are pinned here — including where the code sits, because an
    // identical check written *after* the process started would refuse nothing.
    const refusal = DRIVER.indexOf(
      "if (mode === 'live' && Date.now() - startedAt >= LIVE_DEADLINE_MS)",
    );
    const start = DRIVER.indexOf('const result = spawnSync(file, args, {');
    expect(
      refusal,
      'the driver refuses to start a command on a spent clock',
    ).toBeGreaterThanOrEqual(0);
    expect(start, 'the driver starts its commands through one spawnSync').toBeGreaterThanOrEqual(0);
    expect(refusal, 'the refusal has to precede the spawn it refuses').toBeLessThan(start);
    expect(DRIVER).toContain(
      'timeout: Math.min(options.timeoutMs ?? remainingMs(), remainingMs())',
    );
    // The floor in `remainingMs()` is load-bearing, measured on this build's Node: a
    // `timeout` of 0 applies no limit at all, and a negative one throws before the child
    // starts. Without it, the clock running out hands the deadline's own command either an
    // unbounded wait or a RangeError, which is the opposite of the promise above.
    expect(DRIVER).toContain('Math.max(1_000, LIVE_DEADLINE_MS - (Date.now() - startedAt))');
    // The share-of-the-clock wording, in any of the shapes it has appeared in.
    expect(`${WORKFLOW}\n${DRIVER}\n${README}`).not.toMatch(
      /(share|slice|split|piece) of the \S+-minute wall/,
    );
  });

  it('configures the production sandbox image and absolute Docker path for the chain', () => {
    const live = job('live-model');
    expect(live).toContain(`MERGESUTRA_SANDBOX_IMAGE: ${SANDBOX_IMAGE}`);
    expect(live).toContain('MERGESUTRA_DOCKER_EXECUTABLE: /usr/bin/docker');
    expect(live.match(/MERGESUTRA_SANDBOX_IMAGE:\s*\S+/g) ?? []).toHaveLength(1);
  });

  it('verifies the daemon and preloads the pinned digest before any model request', () => {
    const live = job('live-model');
    const daemon = live.indexOf(
      '"$MERGESUTRA_DOCKER_EXECUTABLE" version --format \'{{ .Server.Version }}\'',
    );
    const pull = live.indexOf('"$MERGESUTRA_DOCKER_EXECUTABLE" pull "$MERGESUTRA_SANDBOX_IMAGE"');
    const inspect = live.indexOf(
      '"$MERGESUTRA_DOCKER_EXECUTABLE" image inspect --format \'resolved {{ .Id }}\' "$MERGESUTRA_SANDBOX_IMAGE"',
    );
    const proofStepStart = live.indexOf('- name: Prove the sandbox boundary without a model call');
    const proof = live.indexOf('node scripts/sandbox-runtime-proof.mjs');
    const model = live.indexOf('- name: Verify selected model is in the authenticated catalog');
    const chain = live.indexOf('- name: Run the bounded real-model chain');
    for (const [name, index] of Object.entries({
      daemon,
      pull,
      inspect,
      proofStepStart,
      model,
      chain,
    })) {
      expect(index, `${name} step is missing`).toBeGreaterThanOrEqual(0);
    }
    expect(daemon).toBeLessThan(pull);
    expect(pull).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(proofStepStart);
    expect(proofStepStart).toBeLessThan(proof);
    expect(proof).toBeLessThan(model);
    expect(model).toBeLessThan(chain);

    const proofStep = live.slice(proofStepStart, model);
    expect(proofStep).toContain(`MERGESUTRA_RUNTIME_PROOF_IMAGE: ${SANDBOX_IMAGE}`);
    expect(proofStep).toContain('MERGESUTRA_RUNTIME_PROOF_DOCKER: /usr/bin/docker');
    // No model provider is contacted and no credential is present while the boundary
    // is being proven; a skipped or conditional proof would qualify nothing.
    expect(proofStep).not.toContain('BHARATCODE');
    expect(proofStep).not.toMatch(/\n\s+if:/);
    expect(proofStep).not.toContain('continue-on-error');
  });

  it('proves repository commands run in Docker without the model credential', () => {
    expect(RUNTIME_PROOF).toContain('createSandboxedRunner');
    expect(RUNTIME_PROOF).toContain("'BHARATCODE_API_KEY'");
    expect(RUNTIME_PROOF).toContain('tokenInherited: false');
    expect(RUNTIME_PROOF).toContain('SANDBOX_RUNTIME_PROOF: PASS');
    expect(job('live-model')).toContain('node scripts/sandbox-runtime-proof.mjs');
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
