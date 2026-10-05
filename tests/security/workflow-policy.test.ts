import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * S13-3 — what the hosted workflow is allowed to be (roadmap 13.3 and 13.4).
 *
 * `.github/workflows/ci.yml` is the only place where this repository's claims about
 * its own gates are *enforced* rather than merely written down, and the only place
 * where a change runs on someone else's compute, with someone else's token, and —
 * once Stage 15 lands — with publish rights attached. Two failure modes belong to
 * that position and to no other suite here:
 *
 * - **Silent shrinkage.** Deleting a step does not make a test red; it makes that
 *   test not run. All four matrix entries would report success while the
 *   packaged-artifact gate quietly stopped existing.
 * - **Silent widening.** A permission, a trigger, or a floating version reference
 *   added in a routine edit grants something on every future run, including runs
 *   over untrusted pull-request code.
 *
 * The file is therefore read as data. The policy is a pure function, and the control
 * tests feed it the exact mutations the guard exists to catch — which is what makes
 * the assertion against the real file mean "this passes because the policy holds",
 * not "this passes because nobody edited the file".
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const REAL = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/** A full commit SHA is the only thing an external action may be pinned to. */
const SHA = /^[0-9a-f]{40}$/;

/** The gates the runner must execute, in the order it must execute them in. */
const REQUIRED_STEPS = [
  'npm ci',
  'npm audit --omit=dev --audit-level=high',
  'npm run check',
  'npm run qualify:path-shapes',
  'npm run verify:package',
  'npm run test:artifact',
];

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

/** The lines indented under a column-0 key, stopping at the next column-0 key. */
function topLevelBlock(text: string, key: string): string[] {
  const block: string[] = [];
  let inside = false;
  for (const line of lines(text)) {
    if (/^\S/.test(line)) {
      if (inside) break;
      inside = new RegExp(`^${key}:\\s*(#.*)?$`).test(line);
      continue;
    }
    if (inside) block.push(line);
  }
  return block;
}

/** `owner/repo@ref` for every `uses:` line, plus the comment beside it. */
function usedActions(text: string): { ref: string; label: string }[] {
  return lines(text).flatMap((line) => {
    const match = /^\s*(?:-\s*)?uses:\s*['"]?([^'"\s]+)['"]?\s*(.*)$/.exec(line);
    return match ? [{ ref: match[1] ?? '', label: (match[2] ?? '').trim() }] : [];
  });
}

/** The `run:` commands, in file order, which is the order the runner obeys. */
function runCommands(text: string): string[] {
  return lines(text).flatMap((line) => {
    const match = /^\s*run:\s*(.+?)\s*$/.exec(line);
    return match ? [match[1] ?? ''] : [];
  });
}

/**
 * The step that uses `owner/repo`, from the dash that opens it to the end of that
 * step: everything more indented than the dash, which is where `with:` lives.
 *
 * A step may put its `uses:` on the dash line or under a `- name:` line, so the dash
 * is found by walking back from the reference rather than assumed.
 */
function stepBlock(text: string, owner: string): string | null {
  const all = lines(text);
  for (let i = 0; i < all.length; i += 1) {
    if (!all[i]?.includes(`uses: ${owner}@`)) continue;
    let dash = i;
    while (dash > 0 && !/^\s*-\s/.test(all[dash] ?? '')) dash -= 1;
    const base = indentOf(all[dash] ?? '');
    const block: string[] = [];
    for (let j = dash; j < all.length; j += 1) {
      const line = all[j] ?? '';
      if (j > dash && line.trim() !== '' && indentOf(line) <= base) break;
      block.push(line);
    }
    return block.join('\n');
  }
  return null;
}

/**
 * Every event name the workflow triggers on, in either shape YAML allows.
 *
 * Reading only the indented block under `on:` lets `on: [push, pull_request_target]` — a
 * flow sequence on the key's own line — carry a trigger the policy never sees. Both
 * shapes are therefore parsed, and neither is trusted to be the only one.
 */
function triggerNames(text: string): string[] {
  const names = new Set<string>();
  let inside = false;
  for (const line of lines(text)) {
    const key = /^on:\s*(.*)$/.exec(line);
    if (key) {
      inside = true;
      const inline = (key[1] ?? '').split('#')[0] ?? '';
      for (const token of inline.replace(/[\][]/g, ' ').split(/[\s,]+/)) {
        if (/^[\w-]+$/.test(token)) names.add(token);
      }
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break;
    const child = /^ {2}([\w-]+):/.exec(line);
    if (child) names.add(child[1] ?? '');
    const item = /^ {2,}-\s*([\w-]+)\s*$/.exec(line);
    if (item) names.add(item[1] ?? '');
  }
  return [...names];
}

/**
 * Reasons this workflow text must not run as written.
 *
 * Each rule is a sentence a reviewer can act on; every rule is made to fire by a
 * control test below.
 */
function workflowViolations(text: string): string[] {
  const problems: string[] = [];

  if (triggerNames(text).includes('pull_request_target')) {
    problems.push("`pull_request_target` runs PR code with the base repository's token");
  }

  const permissions = topLevelBlock(text, 'permissions');
  if (permissions.length === 0) {
    problems.push('the workflow declares no `permissions:` block, so it inherits the default');
  }
  for (const line of permissions) {
    const match = /^\s*([\w-]+):\s*(\S+)/.exec(line);
    if (!match) continue;
    const scope = match[1] ?? '';
    const level = match[2] ?? '';
    if (scope !== 'contents') problems.push(`\`${scope}\` is not a scope this workflow needs`);
    if (level !== 'read') problems.push(`\`${scope}: ${level}\` is not read-only`);
  }

  for (const line of lines(text)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (/secrets\./.test(trimmed)) {
      problems.push(`a job is handed a repository secret: ${trimmed}`);
      break;
    }
  }
  for (const line of lines(text)) {
    const trimmed = line.trim();
    if (/continue-on-error/.test(trimmed) || /\|\|\s*true/.test(trimmed)) {
      problems.push(`a failure is swallowed: ${trimmed}`);
      break;
    }
    if (/^timeout-minutes:/.test(trimmed)) {
      problems.push(`a timeout is set for a slow runner rather than a hung one: ${trimmed}`);
      break;
    }
  }

  for (const action of usedActions(text)) {
    if (!SHA.test(action.ref.split('@')[1] ?? '')) {
      problems.push(`\`${action.ref}\` is not pinned to a full commit SHA`);
    } else if (!/^#\s*v\d+(\.\d+\.\d+)?$/.test(action.label)) {
      problems.push(`\`${action.ref}\` does not name the tag its SHA came from`);
    }
  }

  const checkout = stepBlock(text, 'actions/checkout');
  if (checkout === null) {
    problems.push('no checkout step was found, so the history rule cannot be read');
  } else {
    if (!/fetch-depth:\s*0\b/.test(checkout)) {
      problems.push('checkout does not fetch the whole history the release-boundary suites read');
    }
    if (!/persist-credentials:\s*false\b/.test(checkout)) {
      problems.push('checkout persists the Actions credential into Git configuration');
    }
  }

  return problems;
}

describe('the hosted workflow obeys the Actions security policy', () => {
  it('reports no violation at all against the file that really runs', () => {
    expect(workflowViolations(REAL), workflowViolations(REAL).join('\n')).toEqual([]);
  });

  it('grants exactly one scope, read-only, at the top level', () => {
    const granted = topLevelBlock(REAL, 'permissions').flatMap((line) => {
      const match = /^\s*([\w-]+):\s*(\S+)/.exec(line);
      return match ? [`${match[1]}: ${match[2]}`] : [];
    });
    expect(granted).toEqual(['contents: read']);
  });

  it('triggers only on a push to main and on ordinary pull requests', () => {
    expect(
      topLevelBlock(REAL, 'on')
        .flatMap((line) => {
          const match = /^ {2}([\w-]+):/.exec(line);
          return match ? [match[1]] : [];
        })
        .sort(),
    ).toEqual(['pull_request', 'push']);
    expect(REAL).not.toContain('workflow_run');
    expect(REAL).not.toContain('schedule:');
  });

  it('says in the file itself that nothing here reaches a live model', () => {
    expect(REAL).toMatch(/BharatCode/);
    expect(REAL).toMatch(/offline/i);
  });

  it('pins each external action to a verified commit and names the tag beside it', () => {
    const used = usedActions(REAL);
    expect(used.map((a) => a.ref.split('@')[0]).sort()).toEqual([
      'actions/checkout',
      'actions/setup-node',
    ]);
    for (const action of used) {
      expect(SHA.test(action.ref.split('@')[1] ?? ''), action.ref).toBe(true);
      expect(action.label, action.ref).toMatch(/^#\s*v\d/);
    }
  });

  it('reads the whole history without persisting the Actions credential', () => {
    const checkout = stepBlock(REAL, 'actions/checkout') ?? '';
    expect(/fetch-depth:\s*0\b/.test(checkout), 'the checkout step must fetch every commit').toBe(
      true,
    );
    expect(
      /persist-credentials:\s*false\b/.test(checkout),
      'repository commands must not inherit the Actions token through Git configuration',
    ).toBe(true);
  });

  it('runs every authoritative gate, in order, with nothing swallowed', () => {
    expect(runCommands(REAL)).toEqual(REQUIRED_STEPS);
    expect(REAL).not.toMatch(/continue-on-error/);
    expect(REAL).not.toMatch(/timeout-minutes/);
  });

  it('covers both operating systems and both supported Node lines', () => {
    expect(/os:\s*\[ubuntu-latest,\s*windows-latest\]/.test(REAL)).toBe(true);
    expect(/node:\s*\['22\.x',\s*'24\.x'\]/.test(REAL)).toBe(true);
    expect(/fail-fast:\s*false/.test(REAL), 'one platform must not hide another failure').toBe(
      true,
    );
  });
});

describe('the policy fires on the mutations it exists for', () => {
  const CHECKOUT = [
    '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
    '        with:',
    '          fetch-depth: 0',
    '          persist-credentials: false',
  ].join('\n');

  function skeleton(runLine: string): string {
    return [
      'name: CI',
      'on:',
      '  push:',
      '    branches: [main]',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  check:',
      '    steps:',
      CHECKOUT,
      runLine,
    ].join('\n');
  }

  it('accepts the clean skeleton, so the mutations below are the only difference', () => {
    expect(workflowViolations(skeleton('      - run: npm ci'))).toEqual([]);
  });

  it('rejects a dangerous trigger written as a flow sequence rather than a block map', () => {
    const flow = skeleton('      - run: npm ci').replace(
      ['on:', '  push:', '    branches: [main]'].join('\n'),
      'on: [push, pull_request_target]',
    );
    expect(workflowViolations(flow)).toContain(
      "`pull_request_target` runs PR code with the base repository's token",
    );
  });

  it('rejects a dangerous trigger written as a block sequence', () => {
    const block = skeleton('      - run: npm ci').replace(
      ['on:', '  push:', '    branches: [main]'].join('\n'),
      ['on:', '  - push', '  - pull_request_target'].join('\n'),
    );
    expect(workflowViolations(block)).toContain(
      "`pull_request_target` runs PR code with the base repository's token",
    );
  });

  it('does not invent a trigger out of a comment on the `on:` line', () => {
    const commented = skeleton('      - run: npm ci').replace(
      ['on:', '  push:', '    branches: [main]'].join('\n'),
      'on: [push] # ordinary pull requests are reviewed by the same job',
    );
    expect(triggerNames(commented)).toEqual(['push']);
  });

  it('rejects a floating version reference', () => {
    const floating = skeleton('      - run: npm ci').replace(
      '@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
      '@v4 # v4',
    );
    expect(workflowViolations(floating)).toEqual([
      '`actions/checkout@v4` is not pinned to a full commit SHA',
    ]);
  });

  it('rejects a pinned SHA that does not say which tag it is', () => {
    expect(workflowViolations(skeleton('      - run: npm ci').replace(' # v6', ''))).toEqual([
      '`actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803` does not name the tag its SHA came from',
    ]);
  });

  it('rejects a widened permission and a missing grant entirely', () => {
    expect(workflowViolations(skeleton('      - run: npm ci').replace('read', 'write'))).toEqual([
      '`contents: write` is not read-only',
    ]);
    const ungranted = skeleton('      - run: npm ci').replace(
      'permissions:\n  contents: read\n',
      '',
    );
    expect(workflowViolations(ungranted)).toContain(
      'the workflow declares no `permissions:` block, so it inherits the default',
    );
  });

  it('rejects a scope nobody here needs, such as one that mints an OIDC token', () => {
    const oidc = skeleton('      - run: npm ci').replace(
      '  contents: read',
      '  contents: read\n  id-token: write',
    );
    expect(workflowViolations(oidc)).toContain('`id-token` is not a scope this workflow needs');
  });

  it('rejects the trigger that turns a pull request into a credential hunt', () => {
    const target = skeleton('      - run: npm ci').replace('  push:', '  pull_request_target:');
    expect(workflowViolations(target)).toContain(
      "`pull_request_target` runs PR code with the base repository's token",
    );
  });

  it('rejects a secret reaching a job, and a failure being swallowed', () => {
    const leaked = skeleton(
      '        env:\n          KEY: ${{ secrets.BHARATCODE_API_KEY }}\n      - run: npm ci',
    );
    expect(workflowViolations(leaked).join(' ')).toContain('handed a repository secret');
    expect(workflowViolations(skeleton('      - run: npm ci || true')).join(' ')).toContain(
      'a failure is swallowed',
    );
    const padded = skeleton('      - run: npm ci').replace(
      'name: CI',
      'timeout-minutes: 90\nname: CI',
    );
    expect(workflowViolations(padded).join(' ')).toContain('set for a slow runner');
  });

  it('rejects a checkout that starves history or persists its credential', () => {
    const shallow = skeleton('      - run: npm ci').replace('fetch-depth: 0', 'fetch-depth: 1');
    expect(workflowViolations(shallow)).toContain(
      'checkout does not fetch the whole history the release-boundary suites read',
    );
    const persisted = skeleton('      - run: npm ci').replace(
      'persist-credentials: false',
      'persist-credentials: true',
    );
    expect(workflowViolations(persisted)).toContain(
      'checkout persists the Actions credential into Git configuration',
    );
  });
});

/**
 * Completeness, which the pure function cannot express: a step deleted from the
 * workflow is a gate that stopped running, and nothing else in this repository
 * would notice.
 */
describe('the gate set is complete, not merely valid', () => {
  const runs = lines(REAL)
    .map((raw, index) => ({ line: index + 1, raw }))
    .filter(({ raw }) => /^\s*run:\s*\S/.test(raw));

  it('names each required gate exactly once', () => {
    for (const command of REQUIRED_STEPS) {
      expect(
        runs.filter((r) => r.raw.includes(command)),
        command,
      ).toHaveLength(1);
    }
  });

  it('orders them install, runtime audit, source gates, path qualification, then artifact gates', () => {
    expect(runs.map((r) => r.raw.replace(/^\s*run:\s*/, '').trim())).toEqual(REQUIRED_STEPS);
  });
});

/**
 * The same silent-shrinkage argument applies one level up. This policy can only hold for
 * the files it actually reads, and a workflow added in a new file — Stage 15's publish job
 * is the likely one — would run on every future push with rights nothing had reviewed.
 * So the set of files on disk is compared against the set this file has rules for, and a
 * new file makes the suite red until someone writes its policy.
 */
const GUARDED_WORKFLOWS = ['ci.yml', 'live-validation.yml', 'publish.yml'];

function workflowFiles(): string[] {
  return readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();
}

function uncoveredWorkflows(present: readonly string[], guarded: readonly string[]): string[] {
  return present.filter((file) => !guarded.includes(file)).sort();
}

describe('no hosted workflow escapes this policy', () => {
  const present = workflowFiles();

  it('reads every workflow file the repository ships', () => {
    expect(
      uncoveredWorkflows(present, GUARDED_WORKFLOWS),
      'a workflow file exists that this suite has no rules for: give it a policy, then add its ' +
        'name to GUARDED_WORKFLOWS in tests/security/workflow-policy.test.ts',
    ).toEqual([]);
  });

  it('fires when a file appears beside the guarded set', () => {
    expect(uncoveredWorkflows(['ci.yml', 'release.yml'], ['ci.yml'])).toEqual(['release.yml']);
  });

  it('fires when the guarded set is emptied rather than widened', () => {
    expect(uncoveredWorkflows(['ci.yml'], [])).toEqual(['ci.yml']);
  });
});
