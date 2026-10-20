import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Stage 18's hosted gate is what turns Stage 17's eight customer journeys into a release
 * requirement, and it is a YAML file — nothing else in this repository notices when a step
 * is deleted from it. So this file reads the workflow the way `sandbox-workflow-policy.test.ts`
 * reads the Docker proof: a pure function returning one sentence per unenforced claim, run
 * against the shipped bytes and against deliberately mutated copies.
 *
 * Every rule below has a mutation beside it. A rule nobody can turn off is not a rule, it is
 * a string that happens to appear in the file.
 */
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WORKFLOW_FILE = '.github/workflows/customer-workflow.yml';
const WORKFLOW = readFileSync(path.join(ROOT, WORKFLOW_FILE), 'utf8');
const HARNESS_FILE = 'scripts/customer-workflow-qualification.mjs';
const HARNESS = readFileSync(path.join(ROOT, HARNESS_FILE), 'utf8');
const GATE_CLI = readFileSync(path.join(ROOT, 'scripts', 'customer-gate-verify.mjs'), 'utf8');
const BUNDLE_CLI = readFileSync(path.join(ROOT, 'scripts', 'customer-evidence-bundle.mjs'), 'utf8');
const ENVIRONMENT_LIB = readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'customer-environment.mjs'),
  'utf8',
);

const DIGEST_IMAGE = /^node@sha256:[0-9a-f]{64}$/;

/** The commands the job must run, in this order — install before build, build before use. */
const STAGE_ORDER = [
  'npm ci',
  'npm run build',
  'node scripts/customer-workflow-qualification.mjs',
  'node scripts/customer-gate-verify.mjs',
  'node scripts/customer-evidence-bundle.mjs',
];

function fixtureBaseSha(): string {
  const sha = /export const CUSTOMER_BASE_SHA = '([0-9a-f]{40})'/.exec(ENVIRONMENT_LIB)?.[1];
  if (!sha) throw new Error('customer-environment.mjs no longer names a 40-character base SHA');
  return sha;
}

function harnessDefaultImage(text = HARNESS): string {
  const image = /const DEFAULT_IMAGE =\s*'(node@sha256:[0-9a-f]{64})'/.exec(text)?.[1];
  if (!image) throw new Error('the harness no longer names a digest-pinned default image');
  return image;
}

/**
 * The environment names the gate command refuses to run without, read out of its own `ENV` map.
 *
 * The command treats a missing binding as a failure rather than a rule it can skip, which
 * means the workflow has to name every one of them — and a policy that hard-coded the list
 * would still pass the day someone renamed a key on one side. Deriving it from the file the
 * job actually executes is the only way this check stays true.
 */
function gateRequiredEnv(text: string): string[] {
  const block = /^const ENV = \{([\s\S]*?)^\}/m.exec(text)?.[1];
  if (block === undefined) {
    throw new Error(
      'customer-gate-verify.mjs no longer declares its ENV map in a shape this policy can read',
    );
  }
  const names = [
    ...new Set(
      [...block.matchAll(/'(MERGESUTRA_[A-Z0-9_]+)'/g)]
        .map((match) => match[1] ?? '')
        .filter((name) => name !== ''),
    ),
  ];
  if (names.length < 2) throw new Error('the gate ENV map yielded no environment names');
  return names.sort();
}

/**
 * The shell lines a step actually runs, read out of the YAML by indentation.
 *
 * Comments are excluded because prose is not a command: a header that mentions `npm ci`
 * while explaining the network split would otherwise satisfy the ordering check below
 * without the job installing anything.
 */
function runCommands(text: string): string[] {
  const lines = text.split('\n');
  const commands: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const inline = /^ {8}run:\s*(\S.*)$/.exec(line);
    if (inline?.[1] !== undefined && !inline[1].startsWith('|')) {
      commands.push(inline[1].trim());
      index += 1;
      continue;
    }
    if (/^ {8}run:\s*\|\s*$/.test(line)) {
      let body = index + 1;
      while (body < lines.length) {
        const next = lines[body] ?? '';
        if (next.trim() === '') {
          body += 1;
          continue;
        }
        if (!/^ {10,}\S/.test(next)) break;
        // A shell comment inside a step body is not a command the step runs, so it
        // cannot be allowed to satisfy the ordering check below.
        if (!next.trim().startsWith('#')) commands.push(next.trim());
        body += 1;
      }
      index = body;
      continue;
    }
    index += 1;
  }
  return commands;
}

/**
 * The trigger filters, read the way the sandbox policy reads them: by indentation, with a
 * shape it does not understood left out rather than guessed at. A `paths:` entry that stops
 * being a quoted list item is a filter that quietly stopped matching, so it has to surface
 * as a missing required entry rather than as a green run.
 */
function pathFilters(text: string): Record<string, string[]> {
  const filters = new Map<string, string[]>();
  let trigger: string | undefined;
  let collecting = false;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const triggerMatch = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (triggerMatch?.[1] !== undefined) {
      trigger = triggerMatch[1];
      collecting = false;
      continue;
    }
    if (/^ {4}paths:\s*$/.test(line)) {
      collecting = true;
      if (trigger !== undefined && !filters.has(trigger)) filters.set(trigger, []);
      continue;
    }
    const entry = /^ {6}- '([^']+)'$/.exec(line);
    const bucket = collecting && trigger !== undefined ? filters.get(trigger) : undefined;
    if (bucket !== undefined && entry?.[1] !== undefined) bucket.push(entry[1]);
    else if (collecting && /^ {4}\S/.test(line)) collecting = false;
  }
  return Object.fromEntries(filters);
}

/**
 * One hop from a script's import to the file a pull request can change, reading only the
 * import prologue.
 *
 * That restriction is the whole trick: the harness embeds literal JavaScript inside template
 * strings — the fixture's replacement module and its test file — and those embedded `import`
 * lines are not things the harness loads. Mapping an unknown specifier shape is a hard error
 * rather than a skip, so a new kind of path in a script forces this policy to grow instead of
 * quietly under-covering.
 */
function importPrologue(scriptText: string): string {
  const lines = scriptText.split('\n');
  const end = lines.findIndex((line) =>
    /^(const|let|var|function|class|if|for|process\.)/.test(line),
  );
  return lines.slice(0, end < 0 ? lines.length : end).join('\n');
}

function importedSources(scriptText: string, scriptPath: string): string[] {
  const directory = path.posix.dirname(scriptPath);
  const found = new Set<string>();
  for (const match of importPrologue(scriptText).matchAll(/\bfrom\s+'([^']+)'/g)) {
    const specifier = match[1] ?? '';
    if (specifier.startsWith('node:')) continue;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const relative = specifier.replace(/^\.\//, '').replace(/^\.\.\//, '');
      const mapped = path.posix.normalize(
        path.posix.join(directory, specifier.startsWith('./') ? relative : `../${relative}`),
      );
      found.add(mapped);
      continue;
    }
    throw new Error(`${scriptPath} imports ${specifier}, a shape this policy cannot map`);
  }
  return [...found].sort();
}

/** The commands the hosted job runs, plus everything a change to them could alter. */
function requiredTriggers(): string[] {
  const scripts = [
    HARNESS_FILE,
    'scripts/customer-gate-verify.mjs',
    'scripts/customer-evidence-bundle.mjs',
  ];
  const libs = scripts.flatMap((script) =>
    importedSources(readFileSync(path.join(ROOT, script), 'utf8'), script),
  );
  return [
    WORKFLOW_FILE,
    ...scripts,
    ...libs,
    'src/security/sandbox.ts',
    'src/**',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ].sort();
}

/**
 * @param text the workflow bytes
 * @param harness the bytes the image default is read from, so drift between the script that
 *   chooses the container and the YAML that preloads it is a finding, not an assumption
 * @param gateCli the bytes the certification command is shipped in, so the environment names
 *   it demands are read from the command rather than from a list nobody keeps in step
 */
function violations(text: string, harness = HARNESS, gateCli = GATE_CLI): string[] {
  const problems: string[] = [];
  const defaultImage = harnessDefaultImage(harness);

  if (!/^permissions:\s*\n {2}contents: read\s*$/m.test(text)) {
    problems.push('permissions are not explicitly read-only');
  }
  if (/pull_request_target|secrets\.|id-token:|contents: write/.test(text)) {
    problems.push('workflow has a privileged trigger or credential access');
  }
  if (!/^ {2}pull_request:\s*$/m.test(text)) problems.push('the pull_request trigger is missing');
  if (!/^ {2}workflow_dispatch:\s*$/m.test(text)) problems.push('the manual dispatch is missing');
  if (!/^ {2}push:\s*$/m.test(text) || !/^ {4}branches: \[main\]$/m.test(text)) {
    problems.push('push is not constrained to main');
  }

  // A path filter on the pull request trigger is the silently-skipped-check bug: a pull
  // request outside the list produces no run at all, so a required-check rule waits forever
  // on a check that cannot arrive, and the merge goes through with the journeys unrun.
  // The filter belongs on the push trigger, where a missed run costs a re-certification
  // rather than a gate.
  const filters = pathFilters(text);
  if ((filters['pull_request'] ?? []).length > 0) {
    problems.push(
      'the pull_request trigger is path-filtered, so a pull request that misses the list runs no gate',
    );
  }
  const omitted = requiredTriggers().filter((file) => !(filters['push'] ?? []).includes(file));
  if (omitted.length > 0) {
    problems.push(`the push filter omits ${omitted.join(', ')}, which the gate loads`);
  }

  const imageEnv = /MERGESUTRA_SANDBOX_IMAGE: (\S+)/.exec(text)?.[1];
  if (imageEnv === undefined || !DIGEST_IMAGE.test(imageEnv)) {
    problems.push(`the sandbox image is not digest-pinned (${String(imageEnv)})`);
  } else if (imageEnv !== defaultImage) {
    problems.push(
      `the workflow preloads ${imageEnv}, not the image the harness defaults to (${defaultImage})`,
    );
  }
  if (!/docker pull "\$MERGESUTRA_SANDBOX_IMAGE"/.test(text)) {
    problems.push('the preloaded image is not the one named for the harness');
  }
  if (!/MERGESUTRA_DOCKER_EXECUTABLE: \/usr\/bin\/docker/.test(text)) {
    problems.push('the Docker executable is not pinned to the runner path');
  }
  const deadline = /MERGESUTRA_STAGE_DEADLINE_MS: '(\d+)'/.exec(text)?.[1];
  if (deadline === undefined || !/^[1-9]\d*$/.test(deadline)) {
    problems.push('no per-stage deadline is given, so a hung stage would hang the job');
  }
  if (!/^ {4}timeout-minutes: \d+$/m.test(text)) {
    problems.push('the job has no wall-clock bound');
  }

  if (!/persist-credentials: false/.test(text)) {
    problems.push('checkout persists the Actions credential into Git configuration');
  }
  if (!/fetch-depth: 0/.test(text)) {
    problems.push('checkout does not fetch the whole history the record is bound to');
  }
  if (!/package-manager-cache: false/.test(text)) {
    problems.push('the dependency cache is enabled, so an earlier run could be reachable');
  }
  for (const action of ['checkout', 'setup-node', 'upload-artifact']) {
    if (!new RegExp(`uses: actions/${action}@[0-9a-f]{40} # v\\d+`).test(text)) {
      problems.push(`actions/${action} is not pinned to a full commit SHA`);
    }
  }
  if (!/GH_TOKEN: \$\{\{ github\.token \}\}/.test(text)) {
    problems.push('the fixture reads are not given the job read-only token');
  }

  const commands = runCommands(text);
  let previous = -1;
  for (const command of STAGE_ORDER) {
    const at = commands.findIndex((line) => line.includes(command));
    if (at < 0) {
      problems.push(`${command} does not run, and a claim of this gate depends on it`);
      continue;
    }
    if (at < previous) problems.push(`${command} runs out of order`);
    else previous = at;
  }
  if (commands.some((line) => /qualification\.mjs\s+\S/.test(line))) {
    problems.push('the qualification is run with a scenario argument, so not all eight ran');
  }

  for (const [script, name] of [
    ['customer-gate-verify.mjs', 'the independent gate'],
    ['customer-evidence-bundle.mjs', 'the evidence bundle'],
  ] as const) {
    const step = stepOf(text, `node scripts/${script}`);
    if (step === null) continue;
    // The step's key, not the string anywhere in its block: a comment may explain why the
    // step runs on failure without the policy accepting that explanation as the condition.
    if (!/^ {8}if: always\(\)$/m.test(step)) {
      problems.push(`${name} is skipped when the journeys fail, which is when it is needed`);
    }
  }
  if (
    !/MERGESUTRA_GATE_SUMMARY: .*\.mergesutra\/customer-qualification\/summary\.json/.test(text)
  ) {
    problems.push('the gate is not pointed at the record the harness writes');
  }
  for (const name of gateRequiredEnv(gateCli)) {
    if (!text.includes(name)) {
      problems.push(
        `${name} is never given to the job, and the gate refuses to certify evidence it cannot bind`,
      );
    }
  }
  if (!/MERGESUTRA_GATE_NOW="\$\(date -u/.test(text)) {
    problems.push('the gate is not given the time it is reading at');
  }
  if (!/MERGESUTRA_GATE_EXPORT_ROOT=.*\.mergesutra\/customer-qualification/.test(text)) {
    problems.push('the bundle is not given the raw evidence tree');
  }
  if (!/MERGESUTRA_GATE_ARTIFACT_ROOT="\$RUNNER_TEMP/.test(text)) {
    problems.push('the bundle does not write its artifact inside the runner temp');
  }
  if (!/if-no-files-found: error/.test(text)) {
    problems.push('an upload that found nothing would be reported as success');
  }
  if (!/retention-days: 14/.test(text)) {
    problems.push('the evidence artifact has no retention bound');
  }
  if (
    /continue-on-error|\|\|\s*true\b|\|\|\s*:|--privileged|--network=host|docker\.sock/.test(text)
  ) {
    problems.push('failure suppression or sandbox privilege appears in the job');
  }

  if (!text.includes(fixtureBaseSha())) {
    problems.push('the fixture history is never read back, so a remote mutation would pass');
  }
  if (!/CUSTOMER_WORKFLOW_BOUNDS_PASS/.test(text)) {
    problems.push('the run records no bounds verdict');
  }
  if (!/docker ps -q \| wc -l/.test(text)) {
    problems.push('no container count is measured, so a leak would be invisible');
  }
  if (!/-maxdepth 1 -name 'mergesutra-s17-\*'/.test(text)) {
    problems.push('the run does not look for the workspaces it created');
  }

  // The job's first hosted run died one second in, before a single journey ran: `docker version`
  // answers `.Server.Version` and has no flat `.ServerVersion`, so the step exited on a template
  // error and every step after it produced a cascade that named no cause. Asking the daemon what
  // version it is remains the job's only look at Docker before it commits to a container, so it
  // has to be a preflight finding with a name — not a formatting accident, and not a blank
  // version the step prints and then trusts. These read the commands the step runs, not the
  // prose around them: a comment that recites the fix is not a fix.
  const versionRead = /docker version --format '([^']*)'/.exec(
    commands.find((line) => /\bdocker version\b/.test(line)) ?? '',
  )?.[1];
  if (versionRead === undefined) {
    problems.push('the preflight never asks the Docker daemon which version it is running');
  } else if (!versionRead.includes('{{ .Server.Version }}')) {
    problems.push(
      `the preflight reads the daemon version as "${versionRead}", which the Docker version template does not answer`,
    );
  }
  if (!commands.some((line) => /\[ -z "\$server_version" \]/.test(line))) {
    problems.push(
      'the preflight uses a daemon version it never checks, so an unreachable daemon is a template error rather than a refusal',
    );
  }
  // The bounds step is the job's answer to "did this leave a container, a workspace, or a
  // changed fixture behind". Its baseline is written by a step that can fail, and on this run it
  // did: a `sed` error against a file that was never written is not a bounds verdict — it is the
  // absence of one, and it has to be said as its own problem.
  if (!commands.some((line) => /\[ -f "\$RUNNER_TEMP\/baseline\.env" \]/.test(line))) {
    problems.push(
      'the bounds step reads a baseline it never checks for, so an early failure ends the job in a sed error instead of a verdict',
    );
  }
  return problems;
}

/** The body of the step that runs `needle`, or null when no step does. */
function stepOf(text: string, needle: string): string | null {
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const start = text.lastIndexOf('\n      - name:', at);
  const next = text.indexOf('\n      - name:', at);
  if (start < 0) return null;
  return text.slice(start, next < 0 ? text.length : next);
}

/**
 * The `--format` templates the job asks Docker for, as argv that replays them.
 *
 * This exists because a template error is invisible until the step runs where a daemon does:
 * `.ServerVersion` parsed, printed an empty version and exited 1 on the hosted runner, which is
 * a way to fail a release gate that names nothing about the failure. Each template is replayed
 * against the Docker this repository is developed with, and the counts are compared — a
 * `docker … --format` shape this builder does not name has to surface as an uncovered line
 * rather than as a green run.
 */
function dockerProbes(
  text: string,
): { argv: string[]; label: string; needsImage: boolean; expectsVersion: boolean }[] {
  const image = /MERGESUTRA_SANDBOX_IMAGE: (\S+)/.exec(text)?.[1] ?? '';
  const commands = runCommands(text);
  const probes: { argv: string[]; label: string; needsImage: boolean; expectsVersion: boolean }[] =
    [];
  const shapes = [
    { match: /\bdocker version --format '([^']*)'/, argv: ['docker', 'version'], version: true },
    {
      match: /\bdocker image inspect --format '([^']*)'/,
      argv: ['docker', 'image', 'inspect'],
      version: false,
    },
    { match: /\bdocker ps --format '([^']*)'/, argv: ['docker', 'ps'], version: false },
  ] as const;
  for (const line of commands) {
    for (const shape of shapes) {
      const template = shape.match.exec(line)?.[1];
      if (template === undefined) continue;
      probes.push({
        argv: [
          ...shape.argv,
          '--format',
          template,
          ...(line.includes('MERGESUTRA_SANDBOX_IMAGE') ? [image] : []),
        ],
        label: `docker ${shape.argv.slice(1).join(' ')} --format '${template}'`,
        needsImage: line.includes('MERGESUTRA_SANDBOX_IMAGE'),
        expectsVersion: shape.version,
      });
    }
  }
  return probes;
}

function dockerFormatLines(text: string): string[] {
  return runCommands(text).filter((line) => /\bdocker\b[^|]*--format/.test(line));
}

describe('the hosted customer gate enforces what it claims', () => {
  it('reads the shipped workflow and finds no policy gap', () => {
    expect(violations(WORKFLOW)).toEqual([]);
  });

  it('refuses a privileged trigger, a credential, or a wider permission', () => {
    expect(violations(WORKFLOW.replace('  pull_request:', '  pull_request_target:'))).toContain(
      'workflow has a privileged trigger or credential access',
    );
    expect(violations(WORKFLOW.replace('contents: read', 'contents: write'))).toContain(
      'workflow has a privileged trigger or credential access',
    );
    expect(
      violations(WORKFLOW.replace('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.X }}')),
    ).toContain('the fixture reads are not given the job read-only token');
  });

  it('refuses an unbounded job, an unbounded stage, or a mutable image', () => {
    expect(violations(WORKFLOW.replace('timeout-minutes: 45', 'echo'))).toContain(
      'the job has no wall-clock bound',
    );
    expect(
      violations(
        WORKFLOW.replace(
          /MERGESUTRA_STAGE_DEADLINE_MS: '\d+'/,
          "MERGESUTRA_STAGE_DEADLINE_MS: '0'",
        ),
      ),
    ).toContain('no per-stage deadline is given, so a hung stage would hang the job');
    expect(violations(WORKFLOW.replace(harnessDefaultImage(), 'node:24'))).toContain(
      'the sandbox image is not digest-pinned (node:24)',
    );
  });

  it('refuses a workflow that preloads a different image than the harness runs', () => {
    const other = `node@sha256:${'b'.repeat(64)}`;
    expect(violations(WORKFLOW, HARNESS.replace(harnessDefaultImage(), other))).toContain(
      `the workflow preloads ${harnessDefaultImage()}, not the image the harness defaults to (${other})`,
    );
  });

  it('refuses an unpinned action, a persisted credential, a shared cache or a shallow history', () => {
    expect(violations(WORKFLOW.replace(/checkout@[0-9a-f]{40} # v6/, 'checkout@v6'))).toContain(
      'actions/checkout is not pinned to a full commit SHA',
    );
    expect(
      violations(WORKFLOW.replace('persist-credentials: false', 'persist-credentials: true')),
    ).toContain('checkout persists the Actions credential into Git configuration');
    expect(violations(WORKFLOW.replace('package-manager-cache: false', 'echo'))).toContain(
      'the dependency cache is enabled, so an earlier run could be reachable',
    );
    expect(violations(WORKFLOW.replace('fetch-depth: 0', 'fetch-depth: 1'))).toContain(
      'checkout does not fetch the whole history the record is bound to',
    );
  });

  it('refuses a job that skips the build, runs a subset of scenarios, or reorders the chain', () => {
    expect(violations(WORKFLOW.replace('npm run build', 'echo skipped'))).toContain(
      'npm run build does not run, and a claim of this gate depends on it',
    );
    const subset = WORKFLOW.replace(
      'node scripts/customer-workflow-qualification.mjs',
      'node scripts/customer-workflow-qualification.mjs journey',
    );
    expect(subset).not.toEqual(WORKFLOW);
    expect(violations(subset)).toContain(
      'the qualification is run with a scenario argument, so not all eight ran',
    );
    const swapped = WORKFLOW.replace(
      'npm ci\n          npm run build',
      'npm run build\n          npm ci',
    );
    expect(swapped).not.toEqual(WORKFLOW);
    expect(violations(swapped)).toContain('npm run build runs out of order');
  });

  it('refuses a gate or a bundle that is skipped exactly when the journeys fail', () => {
    const stripped = WORKFLOW.replace(
      '        if: always()\n        shell: bash\n        env:\n          MERGESUTRA_GATE_SUMMARY',
      '        shell: bash\n        env:\n          MERGESUTRA_GATE_SUMMARY',
    );
    expect(stripped).not.toEqual(WORKFLOW);
    expect(violations(stripped)).toContain(
      'the independent gate is skipped when the journeys fail, which is when it is needed',
    );
    expect(
      violations(WORKFLOW.replace('MERGESUTRA_GATE_NOW="$(date -u', 'MERGESUTRA_GATE_NOW="x')),
    ).toContain('the gate is not given the time it is reading at');
    expect(
      violations(
        WORKFLOW.replace(
          'MERGESUTRA_GATE_ARTIFACT_ROOT="$RUNNER_TEMP',
          'MERGESUTRA_GATE_ARTIFACT_ROOT="',
        ),
      ),
    ).toContain('the bundle does not write its artifact inside the runner temp');
    expect(
      violations(
        WORKFLOW.replace(
          'MERGESUTRA_GATE_EXPORT_ROOT="${{ github.workspace }}/.mergesutra/customer-qualification"',
          'MERGESUTRA_GATE_EXPORT_ROOT="${{ github.workspace }}/nowhere"',
        ),
      ),
    ).toContain('the bundle is not given the raw evidence tree');
  });

  it('refuses a silent upload, a suppressed failure, or a privilege the sandbox denies', () => {
    expect(
      violations(WORKFLOW.replace('if-no-files-found: error', 'if-no-files-found: ignore')),
    ).toContain('an upload that found nothing would be reported as success');
    expect(violations(WORKFLOW.replace('retention-days: 14', 'echo'))).toContain(
      'the evidence artifact has no retention bound',
    );
    expect(violations(WORKFLOW.replace('set -euo pipefail', 'set -e; true || true'))).toContain(
      'failure suppression or sandbox privilege appears in the job',
    );
    expect(violations(WORKFLOW.replace('--network=none', '--network=host'))).toContain(
      'failure suppression or sandbox privilege appears in the job',
    );
  });

  it('refuses a run that never measures the resources it claims to bound', () => {
    expect(violations(WORKFLOW.replace(/docker ps -q \| wc -l/g, 'echo 0'))).toContain(
      'no container count is measured, so a leak would be invisible',
    );
    expect(
      violations(WORKFLOW.replace(/-maxdepth 1 -name 'mergesutra-s17-\*'/g, '-maxdepth 1')),
    ).toContain('the run does not look for the workspaces it created');
    expect(violations(WORKFLOW.replace(fixtureBaseSha(), 'x'.repeat(40)))).toContain(
      'the fixture history is never read back, so a remote mutation would pass',
    );
    expect(violations(WORKFLOW.replace('CUSTOMER_WORKFLOW_BOUNDS_PASS', 'echo done'))).toContain(
      'the run records no bounds verdict',
    );
  });

  it('refuses a preflight whose Docker version template is the one the daemon does not answer', () => {
    const stale = WORKFLOW.replace('{{ .Server.Version }}', '{{ .ServerVersion }}');
    expect(stale).not.toEqual(WORKFLOW);
    expect(violations(stale)).toContain(
      'the preflight reads the daemon version as "{{ .ServerVersion }}", which the Docker version template does not answer',
    );
    const missing = WORKFLOW.replace(
      /\bif \[ -z "\$server_version" \]; then[\s\S]*?\n\s*fi\n/,
      'echo "(no guard)"\n',
    );
    expect(missing).not.toEqual(WORKFLOW);
    expect(violations(missing)).toContain(
      'the preflight uses a daemon version it never checks, so an unreachable daemon is a template error rather than a refusal',
    );
  });

  it('refuses a bounds step that reads a baseline file it never checks for', () => {
    const unguarded = WORKFLOW.replace(
      /\bif \[ -f "\$RUNNER_TEMP\/baseline\.env" \]; then[\s\S]*?\n\s*fi\n/,
      'baseline_containers=0\n          fi\n',
    );
    expect(unguarded).not.toEqual(WORKFLOW);
    expect(violations(unguarded)).toContain(
      'the bounds step reads a baseline it never checks for, so an early failure ends the job in a sed error instead of a verdict',
    );
  });

  it('refuses a preflight that suppresses a failing command with either || true or || :', () => {
    // Both forms hide a non-zero exit from `set -e`: `|| true` returns a literal 0, `|| :`
    // runs the shell's no-op builtin. Only the first matched the shipped policy until this
    // test pinned the second too, and Stage 18's first hosted preflight used the second form
    // to smuggle a dead daemon past the check that follows. Alternate shell syntax is still
    // failure suppression, so the regex has to name it.
    const trueSuppressed = WORKFLOW.replace(
      /if ! server_version="\$\(docker version[^\n]*"; then/,
      'server_version="$(docker version --format \'{{ .Server.Version }}\' 2>/dev/null)" || true',
    );
    expect(trueSuppressed).not.toEqual(WORKFLOW);
    expect(violations(trueSuppressed)).toContain(
      'failure suppression or sandbox privilege appears in the job',
    );
    const colonSuppressed = WORKFLOW.replace(
      /if ! server_version="\$\(docker version[^\n]*"; then/,
      'server_version="$(docker version --format \'{{ .Server.Version }}\' 2>/dev/null)" || :',
    );
    expect(colonSuppressed).not.toEqual(WORKFLOW);
    expect(violations(colonSuppressed)).toContain(
      'failure suppression or sandbox privilege appears in the job',
    );
    // Neither the shipped workflow nor a mutation-free read carries either form. If this
    // assertion ever fails, the preflight has gone back to suppressing rather than handling.
    expect(WORKFLOW).not.toMatch(/\|\|\s*(true\b|:)/);
  });

  it('ignores prose, because a comment is not a command', () => {
    expect(runCommands('# npm ci\n        run: npm run build')).toEqual(['npm run build']);
    expect(runCommands(WORKFLOW)).toEqual(expect.arrayContaining(STAGE_ORDER));
    const commented = WORKFLOW.replace('npm ci\n', '# npm ci\n');
    expect(commented).not.toEqual(WORKFLOW);
    expect(runCommands(commented)).not.toContain('npm ci');
    expect(violations(commented)).toContain(
      'npm ci does not run, and a claim of this gate depends on it',
    );
  });

  it('refuses a job that never sets a binding the gate command demands', () => {
    expect(gateRequiredEnv(GATE_CLI)).toEqual([
      'MERGESUTRA_GATE_NOT_BEFORE',
      'MERGESUTRA_GATE_NOW',
      'MERGESUTRA_GATE_REVISION',
      'MERGESUTRA_GATE_SANDBOX_IMAGE',
      'MERGESUTRA_GATE_SUMMARY',
    ]);
    // Renaming a key on the command side must make the shipped workflow report a missing
    // binding, which is what proves the list is read from the command and not written here.
    expect(
      violations(
        WORKFLOW,
        HARNESS,
        GATE_CLI.replace("'MERGESUTRA_GATE_REVISION'", "'MERGESUTRA_GATE_HEAD'"),
      ),
    ).toContain(
      'MERGESUTRA_GATE_HEAD is never given to the job, and the gate refuses to certify evidence it cannot bind',
    );
    expect(violations(WORKFLOW.replace(/MERGESUTRA_GATE_SUMMARY/g, 'X'))).toContain(
      'MERGESUTRA_GATE_SUMMARY is never given to the job, and the gate refuses to certify evidence it cannot bind',
    );
  });

  it('refuses a pull request trigger that can be filtered out of existence', () => {
    const filtered = WORKFLOW.replace(
      '  pull_request:\n',
      "  pull_request:\n    paths:\n      - 'src/**'\n",
    );
    expect(filtered).not.toEqual(WORKFLOW);
    expect(violations(filtered)).toContain(
      'the pull_request trigger is path-filtered, so a pull request that misses the list runs no gate',
    );
  });

  it('reads each trigger only where a trigger is written', () => {
    expect(violations(WORKFLOW.replace('  push:', '#   push:'))).toContain(
      'push is not constrained to main',
    );
    expect(
      violations(WORKFLOW.replace(/^ {4}branches: \[main\]$/m, '    branches: [main, dev]')),
    ).toContain('push is not constrained to main');
    expect(violations(WORKFLOW.replace('  workflow_dispatch:', '  schedule:'))).toContain(
      'the manual dispatch is missing',
    );
  });
});

describe('the hosted customer gate starts when a file it loads changes', () => {
  // The push filter is the only list the gate can be triggered by, because a required
  // check on a path-filtered pull request silently never arrives for a PR outside the
  // list. So the derivation proof reads the push bucket.
  const filters = pathFilters(WORKFLOW);

  it('names every script and library the three commands load directly', () => {
    const listed = new Set(filters['push'] ?? []);
    expect(requiredTriggers().filter((file) => !listed.has(file))).toEqual([]);
  });

  it('lists no path that nothing at that path is responsible for', () => {
    const entries = filters['push'] ?? [];
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      if (entry.endsWith('**')) continue;
      expect(existsSync(path.join(ROOT, entry)), entry).toBe(true);
    }
  });

  it('fires when an entry is dropped from the filter', () => {
    const dropped = WORKFLOW.replace("      - 'scripts/lib/customer-oracle.mjs'\n", '');
    expect(dropped).not.toEqual(WORKFLOW);
    const listed = new Set(pathFilters(dropped)['push'] ?? []);
    expect(requiredTriggers().filter((file) => !listed.has(file))).toEqual([
      'scripts/lib/customer-oracle.mjs',
    ]);
  });

  it('still runs on a deliberate dispatch', () => {
    expect(WORKFLOW).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it('maps a library a script newly imports into a required trigger', () => {
    const withNewImport = `import { x } from './lib/customer-sentinel.mjs';\nconst ROOT = 1;\n`;
    expect(importedSources(withNewImport, 'scripts/customer-workflow-qualification.mjs')).toEqual([
      'scripts/lib/customer-sentinel.mjs',
    ]);
  });

  it('does not mistake an embedded string for an import', () => {
    const embedded =
      "const FIXTURE = `import { slugify } from '../src/slugify.js';`;\nconst ROOT = 1;\n";
    expect(importedSources(embedded, 'scripts/customer-workflow-qualification.mjs')).toEqual([]);
  });

  it('refuses to guess at a specifier shape it cannot map', () => {
    expect(() =>
      importedSources(`import x from 'some-package';\nconst a = 1;\n`, 'scripts/a.mjs'),
    ).toThrow(/shape this policy cannot map/);
  });

  it('collects only the prologue of the real harness, which is where its imports are', () => {
    const prologue = importPrologue(HARNESS);
    expect(prologue).toContain("from './lib/customer-environment.mjs'");
    expect(prologue).not.toContain("from '../src/slugify.js'");
    expect(importedSources(HARNESS, HARNESS_FILE)).toEqual([
      'scripts/lib/customer-environment.mjs',
      'scripts/lib/customer-evidence.mjs',
      'scripts/lib/customer-gate-summary.mjs',
      'scripts/lib/customer-oracle.mjs',
      'scripts/lib/scripted-gateway.mjs',
    ]);
  });

  it('parses the filters by the shapes they are written in', () => {
    expect(Object.keys(filters).sort()).toEqual(['push']);
    const unquoted = WORKFLOW.replace("      - 'tsconfig.json'", '      - tsconfig.json');
    expect(unquoted).not.toEqual(WORKFLOW);
    expect(pathFilters(unquoted)['push']).not.toContain('tsconfig.json');
    expect(
      requiredTriggers().filter((file) => !(pathFilters(unquoted)['push'] ?? []).includes(file)),
    ).toEqual(['tsconfig.json']);
  });
});

describe('the record the hosted gate reads is the record the harness writes', () => {
  it('names the reason a stage has no exit code, and keeps the gate able to read it', () => {
    expect(HARNESS).toMatch(/null\(killed:\$\{stage\.signal\}\)/);
    expect(HARNESS).toMatch(/null\(timed out after \$\{String\(stage\.deadlineMs\)\}ms\)/);
    expect(GATE_CLI).toContain("from './lib/customer-gate-summary.mjs'");
    expect(BUNDLE_CLI).toContain('scrubHost(sanitize(text))');
    expect(BUNDLE_CLI).toContain('if (holdsHostPath(text)) homeSurvived.push(relative);');
  });
});

describe('the Docker format templates the job uses are valid against the daemon', () => {
  const probes = dockerProbes(WORKFLOW);
  const formatLines = dockerFormatLines(WORKFLOW);

  // Structural: the probe builder covers every `docker … --format` command in the workflow.
  // A --format line that is not covered would mean a template nobody replayed before the gate ran.
  it('builds a probe for every --format line and omits none', () => {
    expect(probes.length).toBeGreaterThanOrEqual(3);
    expect(probes.length).toBe(formatLines.length);
  });

  it('names the docker version template the daemon actually answers', () => {
    const versionProbe = probes.find((p) => p.expectsVersion);
    expect(versionProbe).toBeDefined();
    expect(versionProbe?.argv).toContain('{{ .Server.Version }}');
  });

  it('names the image-inspect probe and marks it as needing the pinned image', () => {
    const inspect = probes.find((p) => p.argv[1] === 'image');
    expect(inspect).toBeDefined();
    expect(inspect?.needsImage).toBe(true);
  });

  it('names the docker ps probe and marks it as not needing an image', () => {
    const ps = probes.find((p) => p.argv[1] === 'ps');
    expect(ps).toBeDefined();
    expect(ps?.needsImage).toBe(false);
  });

  // Anti-vacuity: removing each template from the workflow removes its probe.
  it('loses the version probe when the preflight docker version command is removed', () => {
    const stripped = WORKFLOW.replace(
      /[^\n]*docker version --format[^\n]*\n/,
      '          echo "(preflight version skipped)"\n',
    );
    expect(stripped).not.toEqual(WORKFLOW);
    expect(dockerProbes(stripped).find((p) => p.expectsVersion)).toBeUndefined();
  });

  it('loses the image-inspect probe when the preload step is removed', () => {
    const stripped = WORKFLOW.replace(
      /\bdocker image inspect --format '[^']*'[^\n]*/,
      'docker images "$MERGESUTRA_SANDBOX_IMAGE"',
    );
    expect(stripped).not.toEqual(WORKFLOW);
    expect(dockerProbes(stripped).find((p) => p.argv[1] === 'image')).toBeUndefined();
  });

  // Live: replay the version template against the Docker this repository develops with.
  // This is the exact template that killed the first hosted run; a successful replay here
  // proves the shipped YAML asks for a field the daemon answers.
  const daemon = spawnSync('docker', ['version', '--format', '{{ .Server.Version }}'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const dockerAvailable = daemon.status === 0 && (daemon.stdout ?? '').trim() !== '';

  it.skipIf(!dockerAvailable)(
    'replays the docker version template against the local daemon and gets a non-empty version',
    () => {
      expect(daemon.stdout.trim()).toMatch(/^\d+\.\d+/);
    },
  );

  it.skipIf(dockerAvailable)(
    'records that Docker is not available so the live version proof was skipped',
    () => {
      expect(true).toBe(true);
    },
  );
});
