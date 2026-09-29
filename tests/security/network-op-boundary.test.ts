import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decideTool, riskOf } from '../../src/process/tool-policy.js';
import { ACTION_KINDS, parseAction } from '../../src/implement/protocol.js';
import { decideExecution, type ExecutionInput } from '../../src/verify/consent.js';
import { parseVerificationPlan, type VerificationPlan } from '../../src/verify/plan.js';
import { code, reachFrom, SRC } from '../helpers/sourceShape.js';
import { consentFor, planOf, plannedGate, WORKSPACE } from '../helpers/verification.js';

/**
 * S12-14 — who is ever allowed to ask the policy for a network operation.
 *
 * `decideTool` has a branch that answers a network request with `allowed: true`,
 * no approval and no boundary of its own. Nothing in the source makes that branch
 * *wrong* for the request it names — MergeSutra does reach the network, through
 * two transports that never pass a request through this function — but the branch
 * is only safe while no untrusted path can mint the op. That is a claim about the
 * rest of the build, so it is checked here rather than asserted in a reason string.
 *
 * Three routes are measured, in the order a hostile input would try them:
 *
 * 1. **Another module writing the request out.** Every module the CLI can arrive
 *    at is read as data (nothing is executed — a test that minted a network op to
 *    prove the harm would be the incident), and every `op:` literal in it is
 *    reported. A future `FETCH_URL` action, a hook, or an `--allow-network` flag
 *    all have to spell an op somewhere, and the moment one spells `network` this
 *    case names the file.
 * 2. **The model, this turn.** The action protocol is a closed discriminated
 *    union of `.strict()` variants, so a forged `{ op: 'network' }` has to be both
 *    a known action *and* an accepted field. Both halves are tested, on payloads
 *    proved live by parsing them first.
 * 3. **A run file a human edited.** A planned gate carries a `risk` field that
 *    comes back off disk as data, so the case is: declare yourself harmless and
 *    see whether anything believes you.
 *
 * A fourth block is about the one thing a test over other people's code cannot
 * close: the reason string. It used to promise that use was "always disclosed" and
 * that "no credential crosses it" — two facts this function does not establish,
 * printed as if it had checked them. What it must state is what it enforces.
 */

/** Every module any `mergesutra` command can reach, imports followed. */
const cliEntries = (await readdir(path.join(SRC, 'cli'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => path.join(SRC, 'cli', entry.name));
const closure = await reachFrom(cliEntries);

/** An `op: '<name>'` literal and where it was written. */
interface OpSite {
  readonly file: string;
  readonly op: string;
  readonly line: number;
}

function opLiterals(sources: Map<string, string>): OpSite[] {
  const sites: OpSite[] = [];
  for (const [file, text] of sources) {
    const body = code(text);
    for (const match of body.matchAll(/\bop:\s*['"]([a-z-]+)['"]/g)) {
      const index = match.index ?? 0;
      sites.push({ file, op: match[1] ?? '?', line: body.slice(0, index).split('\n').length });
    }
  }
  return sites.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
}

/** The declaration of the union is not a request; everything else is. */
const DECLARATION = 'process/tool-policy.ts';

function mints(sites: readonly OpSite[], op: string): OpSite[] {
  return sites.filter((site) => site.op === op && site.file !== DECLARATION);
}

describe('the reachability closure the claim is made about', () => {
  it('is the whole product, and it reaches the policy', () => {
    const files = [...closure.keys()];
    // A scan over an empty or partial reach would "prove" the absence of anything.
    expect(files.length).toBeGreaterThan(40);
    for (const needed of [
      DECLARATION,
      'implement/loop.ts',
      'verify/consent.ts',
      'verify/engine.ts',
      'bharatcode/client.ts',
      'github/gh-client.ts',
    ]) {
      expect(files, `the closure lost ${needed}`).toContain(needed);
    }
  });

  it('reports an op literal it is shown, so a clean answer means something', () => {
    const synthetic = new Map([
      [
        'synthetic/stage.ts',
        [
          '// a comment mentioning op: "network" is not a request, and must not count',
          "const request = { op: 'network', target: url };",
          'decideTool(request, { workspace: root });',
        ].join('\n'),
      ],
    ]);
    const found = opLiterals(synthetic);
    expect(found).toEqual([{ file: 'synthetic/stage.ts', op: 'network', line: 2 }]);
  });
});

describe('no module mints a network request', () => {
  const sites = opLiterals(closure);

  it('writes only the two ops a run actually performs', () => {
    // Outside the union's own declaration, every op spelled in the product is a
    // file write or a command. `network` and `remote-mutation` are questions the
    // build never asks, which is what makes the branch that grants the first one
    // harmless. A new op literal here is a new capability arriving: say so in the
    // stage that adds it, and re-read what this branch then permits.
    const written = [
      ...new Set(sites.filter((site) => site.file !== DECLARATION).map((site) => site.op)),
    ].sort();
    expect(written).toEqual(['execute', 'write']);
  });

  it('never spells the one op that is allowed with no boundary', () => {
    expect(mints(sites, 'network').map((site) => `${site.file}:${site.line}`)).toEqual([]);
  });

  it('holds its own declaration to the union, not to a call site', () => {
    const inPolicy = [
      ...new Set(sites.filter((site) => site.file === DECLARATION).map((site) => site.op)),
    ].sort();
    expect(inPolicy).toEqual(['execute', 'network', 'read', 'remote-mutation', 'write']);
  });
});

describe('the model cannot ask for one either', () => {
  /**
   * One live payload per action kind.
   *
   * The table has to parse before the forged variant is interesting: a case that
   * passed every row by throwing for a missing `reason` would report a guard that
   * was never exercised.
   */
  const PAYLOADS: Record<string, Record<string, unknown>> = {
    READ_FILE: { action: 'READ_FILE', path: 'src/parse.ts', reason: 'see the parser' },
    LIST_FILES: { action: 'LIST_FILES', path: '.', reason: 'see the tree' },
    SEARCH: { action: 'SEARCH', query: 'parseDate', reason: 'find it' },
    WRITE_FILE: {
      action: 'WRITE_FILE',
      path: 'src/parse.ts',
      content: 'export const day = 1;\n',
      replaces: { expectedAbsent: true },
      reason: 'add it',
    },
    RUN_CHECK: { action: 'RUN_CHECK', argv: ['npm', 'test'], reason: 'prove it' },
    PROPOSE_CONTRACT_REVISION: {
      action: 'PROPOSE_CONTRACT_REVISION',
      criterionId: 'AC-1',
      previous: 'as written',
      proposed: 'as meant',
      reason: 'the criterion names a file that does not exist',
      sourceEvidence: 'ENOENT from the plan itself',
    },
    FINISH: { action: 'FINISH', summary: 'done', criteriaBelievedComplete: ['AC-1'] },
    BLOCKED: { action: 'BLOCKED', reason: 'the workspace has no test runner' },
  };

  it('covers every action the protocol offers', () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual([...ACTION_KINDS].sort());
    for (const kind of ACTION_KINDS) {
      expect(() => parseAction(PAYLOADS[kind])).not.toThrow();
    }
  });

  it('offers no action that could want the network', () => {
    const networkish = ACTION_KINDS.filter((kind) =>
      /url|fetch|http|net|request|download/i.test(kind),
    );
    expect(networkish).toEqual([]);
  });

  it('refuses a payload that carries one anyway, on every action', () => {
    for (const kind of ACTION_KINDS) {
      const forged = { ...PAYLOADS[kind], op: 'network', target: 'https://example.com' };
      expect(() => parseAction(forged), kind).toThrow();
    }
  });

  it('refuses a command that reaches the network through the action that can run one', () => {
    // This is the route that exists: `RUN_CHECK` carries an argv, and an argv can
    // name `curl`. The policy sees through it — the class comes from the command,
    // so it lands on the branch that refuses, not the one that grants.
    for (const argv of [
      ['curl', 'https://example.com'],
      ['npm', 'install', 'left-pad'],
      ['npx', 'some-package'],
    ]) {
      const request = { op: 'execute' as const, argv, cwd: WORKSPACE };
      expect(riskOf(request), argv.join(' ')).toBe('NETWORK');
      const decision = decideTool(request, { workspace: WORKSPACE });
      expect(decision.allowed, argv.join(' ')).toBe(false);
      // And no approval on offer either: this is a refusal, not a wait.
      expect(decision.requiresApproval, argv.join(' ')).toBe(false);
    }
  });
});

describe('a risk class read back off disk grants nothing', () => {
  /** A gate the operator supplied, so consent cannot be the reason for anything. */
  function curlPlan(): VerificationPlan {
    return planOf([
      plannedGate({
        id: 'VG-001',
        argv: ['curl', 'https://example.com'],
        provenance: {
          source: 'USER_SUPPLIED',
          file: null,
          detail: 'asked for by hand',
          line: null,
        },
      }),
    ]);
  }

  function decide(plan: VerificationPlan, gateId: string) {
    const gate = plan.gates.find((entry) => entry.id === gateId);
    if (!gate) throw new Error('the fixture lost its gate');
    const input: ExecutionInput = {
      plan,
      workspace: WORKSPACE,
      consent: consentFor(plan, [gateId]),
    };
    return decideExecution(gate, input);
  }

  it('accepts a plan whose stored risk lies, so the decision is what is measured', () => {
    const honest = curlPlan();
    expect(honest.gates[0]?.risk).toBe('NETWORK');

    const fromDisk = JSON.parse(JSON.stringify(honest)) as {
      gates: { id: string; risk: string }[];
    };
    const gate = fromDisk.gates.find((entry) => entry.id === 'VG-001');
    if (gate) gate.risk = 'READ';
    const parsed = parseVerificationPlan(fromDisk);
    // The schema takes the field as data: it is a report of a decision, not a
    // request for one, and this is the line that says so.
    expect(parsed.gates[0]?.risk).toBe('READ');

    const decision = decide(parsed, 'VG-001');
    expect(decision.allowed).toBe(false);
    expect(decision.requiresConsent).toBe(false);
    // The same command, honestly recorded, reaches the same refusal.
    expect(decide(honest, 'VG-001').allowed).toBe(false);
  });
});

describe('the reason for a permitted network request says what this function knows', () => {
  const decision = decideTool(
    { op: 'network', target: 'registry.npmjs.org' },
    { workspace: WORKSPACE },
  );

  it('still grants it, without an approval', () => {
    expect(decision.risk).toBe('NETWORK');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it('names the grant it is making', () => {
    expect(decision.reason).toMatch(/\ballow(ed|s)\b|permit/i);
    expect(decision.reason).toMatch(/without approval|no approval/i);
  });

  it('owns the limit instead of hoping past it', () => {
    expect(decision.reason.toLowerCase()).toMatch(
      /no boundary|not covered|cannot see|sees nothing/,
    );
  });

  it('makes no claim about another module', () => {
    // "always disclosed" and "no credential crosses it" are facts about whoever
    // sends the request. This function does not know them, so it may not print them.
    const reason = decision.reason.toLowerCase();
    expect(reason).not.toContain('credential');
    expect(reason).not.toContain('disclosed');
    expect(reason).not.toContain('secret');
  });
});
