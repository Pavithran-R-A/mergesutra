import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/core/errors.js';
import {
  buildVerificationPlan,
  parseVerificationPlan,
  reviseVerificationPlan,
  type AdditionalGateSpec,
  type VerificationPlan,
} from '../../src/verify/plan.js';
import type { DiscoveredGate, DiscoveryOutcome } from '../../src/verify/gates.js';

/**
 * What will be run, written down before anything is run.
 *
 * These tests are mostly about two things the plan must never be able to do:
 * forget which patch it was written for, and hold a result. The first is what
 * makes a receipt worthless if it can be pointed at a different diff; the second
 * is the whole reason a verification engine is deterministic — a plan is a
 * promise, and a promise cannot be edited into evidence after the fact.
 */

const BASE_SHA = '3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const PATCH_IDENTITY = 'a'.repeat(64);
const AT = new Date('2026-09-25T10:00:00.000Z');
const now = () => AT;

const TEST_GATE: DiscoveredGate = {
  name: 'test',
  argv: ['npm', 'test'],
  cwd: '.',
  requirementLevel: 'REPOSITORY_REQUIRED',
  provenance: {
    source: 'CI_WORKFLOW',
    file: '.github/workflows/ci.yml',
    detail: 'runs `npm test`',
    line: 11,
  },
  corroboratedBy: [
    { source: 'PACKAGE_SCRIPT', file: 'package.json', detail: 'scripts.test', line: null },
  ],
  relevantCriteria: ['AC-1'],
  executionClass: 'READ_ONLY',
  risk: 'EXECUTE',
};

const LINT_GATE: DiscoveredGate = {
  name: 'lint',
  argv: ['npm', 'run', 'lint'],
  cwd: '.',
  requirementLevel: 'REPOSITORY_SUGGESTED',
  provenance: {
    source: 'PACKAGE_SCRIPT',
    file: 'package.json',
    detail: 'scripts.lint',
    line: null,
  },
  corroboratedBy: [],
  relevantCriteria: ['AC-2'],
  executionClass: 'READ_ONLY',
  risk: 'EXECUTE',
};

const BUILD_GATE: DiscoveredGate = {
  name: 'build',
  argv: ['npm', 'run', 'build'],
  cwd: '.',
  requirementLevel: 'REPOSITORY_REQUIRED',
  provenance: {
    source: 'CI_WORKFLOW',
    file: '.github/workflows/ci.yml',
    detail: 'runs `npm run build`',
    line: 12,
  },
  corroboratedBy: [],
  relevantCriteria: [],
  executionClass: 'MUTATION_CAPABLE',
  risk: 'EXECUTE',
};

function discovery(gates: readonly DiscoveredGate[]): DiscoveryOutcome {
  return {
    gates,
    refused: [
      {
        command: 'npm ci',
        provenance: {
          source: 'CI_WORKFLOW',
          file: '.github/workflows/ci.yml',
          detail: 'runs `npm ci`',
          line: 8,
        },
        risk: 'EXECUTE',
        reason: 'Refusing to treat this as a gate: it installs dependencies.',
      },
    ],
    missingPrerequisites: ['No node_modules directory.'],
    notes: ['ci.yml uses a matrix in YAML, which MergeSutra does not expand'],
  };
}

function build(over: Partial<Parameters<typeof buildVerificationPlan>[0]> = {}) {
  return buildVerificationPlan({
    runId: 'run_01',
    baseSha: BASE_SHA,
    patchIdentity: PATCH_IDENTITY,
    discovered: discovery([TEST_GATE, LINT_GATE]),
    now,
    ...over,
  });
}

const CI_SOURCE = {
  source: 'CI_WORKFLOW' as const,
  file: '.github/workflows/ci.yml',
  detail: 'runs `npm run build`',
  line: 12,
};

const DIFF_CHECK: AdditionalGateSpec = {
  name: 'diff-check',
  argv: ['git', 'diff', '--check'],
  reason: 'a patch that carries whitespace damage is not ready for a reviewer',
  relevantCriteria: ['AC-1'],
};

describe('a plan written before anything runs', () => {
  it('gives every gate an id, and every field a receipt will need', () => {
    const plan = build();

    expect(plan.gates.map((gate) => gate.id)).toEqual(['VG-001', 'VG-002']);
    expect(plan.gates[0]).toMatchObject({
      name: 'test',
      command: 'npm test',
      argv: ['npm', 'test'],
      cwd: '.',
      requirementLevel: 'REPOSITORY_REQUIRED',
      executionClass: 'READ_ONLY',
      risk: 'EXECUTE',
      relevantCriteria: ['AC-1'],
      provenance: { source: 'CI_WORKFLOW', line: 11 },
      corroboratedBy: [{ source: 'PACKAGE_SCRIPT', file: 'package.json' }],
    });
    expect(plan.gates[0]?.timeoutMs).toBeGreaterThan(0);
    expect(plan.revision).toBe(1);
    expect(plan.revisions).toEqual([]);
    expect(plan.createdAt).toBe(AT.toISOString());
  });

  it('names the run, the base and the patch it was written for', () => {
    const plan = build();
    expect(plan).toMatchObject({
      runId: 'run_01',
      baseSha: BASE_SHA,
      patchIdentity: PATCH_IDENTITY,
    });
    // A plan written for a patch whose identity is not a digest is not a plan:
    // it is a guess about which diff the receipts will describe.
    expect(() => build({ patchIdentity: 'uncommitted-changes' })).toThrow(/patch/i);
  });

  it('has nowhere to put a result', () => {
    const plan = build();
    const [first, ...rest] = (JSON.parse(JSON.stringify(plan)) as VerificationPlan).gates;
    const tampered = { ...plan, gates: [{ ...first, outcome: 'PASS' }, ...rest] };
    expect(() => parseVerificationPlan(tampered)).toThrow(/outcome|unrecognized/i);
  });

  it('round-trips through JSON and refuses a document it did not write', () => {
    const plan = build();
    expect(parseVerificationPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(() => parseVerificationPlan({ ...plan, schemaVersion: 99 })).toThrow(/version/i);
    expect(() =>
      parseVerificationPlan({ ...plan, gates: [{ ...plan.gates[0], id: 'G-1' }] }),
    ).toThrow(/VG-/);
    // A bare object off the wire is not a plan, and guessing the shape of one
    // would be the same invention as filling in a missing gate.
    expect(() => parseVerificationPlan({ runId: 'run_01' })).toThrow();
  });

  it('carries what discovery refused, so a report can say what was never checked', () => {
    const plan = build();
    expect(plan.refused.map((entry) => entry.command)).toEqual(['npm ci']);
    expect(plan.refused[0]?.provenance.file).toBe('.github/workflows/ci.yml');
    expect(plan.missingPrerequisites.join(' ')).toMatch(/node_modules/);
    expect(plan.notes.join(' ')).toMatch(/matrix/i);
  });

  it('labels MergeSutra’s own checks as MergeSutra’s own, whatever the caller meant', () => {
    const plan = build({ additional: [DIFF_CHECK] });
    const extra = plan.gates.at(-1);

    expect(extra).toMatchObject({
      id: 'VG-003',
      name: 'diff-check',
      command: 'git diff --check',
      requirementLevel: 'MERGESUTRA_ADDITIONAL',
      provenance: { source: 'MERGESUTRA_BUILTIN', file: null },
      executionClass: 'READ_ONLY',
      risk: 'READ',
    });
    // The reviewer is told both who added the check and why.
    expect(extra?.provenance.detail).toContain(DIFF_CHECK.reason);
    expect(extra?.provenance.detail).toMatch(/own authority/i);
    expect(extra?.relevantCriteria).toEqual(['AC-1']);

    // A caller cannot smuggle its own preference in as a repository requirement:
    // the level is derived here, exactly as risk is derived in the tool policy.
    const smuggled = {
      ...DIFF_CHECK,
      name: 'my-own-rule',
      requirementLevel: 'REPOSITORY_REQUIRED',
    } as unknown as AdditionalGateSpec;
    expect(build({ additional: [smuggled] }).gates.at(-1)?.requirementLevel).toBe(
      'MERGESUTRA_ADDITIONAL',
    );
  });

  it('honours a timeout a caller names, and defaults the rest by what they do', () => {
    const plan = build({
      additional: [
        { ...DIFF_CHECK, timeoutMs: 5_000 },
        { ...DIFF_CHECK, name: 'slow-check' },
      ],
    });
    const overridden = plan.gates.find((gate) => gate.name === 'diff-check');
    const defaulted = plan.gates.find((gate) => gate.name === 'slow-check');
    const suite = plan.gates.find((gate) => gate.name === 'test');

    expect(overridden?.timeoutMs).toBe(5_000);
    expect(defaulted?.timeoutMs).toBeGreaterThan(5_000);
    // A suite needs more room than a formatter, and saying so is better than a
    // timeout that turns a slow repository into an inconclusive run.
    expect(suite?.timeoutMs).toBeGreaterThan(defaulted?.timeoutMs ?? 0);
  });
});

describe('a plan revised after it was written', () => {
  function revised(gates: readonly DiscoveredGate[], reason = 'CI gained a build step') {
    return reviseVerificationPlan(build(), {
      discovered: discovery(gates),
      reason,
      source: CI_SOURCE,
      now: () => new Date('2026-09-25T11:00:00.000Z'),
    });
  }

  it('keeps an id pointing at the same gate, and gives the newcomer the next one', () => {
    const plan = revised([TEST_GATE, LINT_GATE, BUILD_GATE]);

    expect(plan.gates.map((gate) => `${gate.id}:${gate.command}`)).toEqual([
      'VG-001:npm test',
      'VG-002:npm run lint',
      'VG-003:npm run build',
    ]);
    expect(plan.revision).toBe(2);
  });

  it('does not move an id when discovery returns the same gates in another order', () => {
    const plan = revised([LINT_GATE, TEST_GATE]);
    expect(plan.gates.map((gate) => `${gate.id}:${gate.command}`)).toEqual([
      'VG-001:npm test',
      'VG-002:npm run lint',
    ]);
  });

  it('says what changed, why, and which file said so', () => {
    const before = build();
    const plan = revised([TEST_GATE, LINT_GATE, BUILD_GATE]);

    expect(plan.revisions).toHaveLength(1);
    const [entry] = plan.revisions;
    expect(entry).toMatchObject({
      revision: 2,
      reason: 'CI gained a build step',
      source: { file: '.github/workflows/ci.yml', line: 12 },
      added: ['VG-003'],
      removed: [],
    });
    expect(entry?.before.map((gate) => gate.id)).toEqual(['VG-001', 'VG-002']);
    expect(entry?.after.map((gate) => gate.id)).toEqual(['VG-001', 'VG-002', 'VG-003']);
    // The plan that was revised is untouched: history is not overwritten here.
    expect(before.gates).toHaveLength(2);
    expect(before.revisions).toEqual([]);
  });

  it('refuses a result that tries to redefine a required gate as optional', () => {
    const weakened: DiscoveredGate = {
      ...TEST_GATE,
      requirementLevel: 'REPOSITORY_SUGGESTED',
    };
    const attempt = () =>
      revised([weakened, LINT_GATE], 'the suite failed twice, treat it as advisory');

    expect(attempt).toThrow(/VG-001/);
    try {
      attempt();
    } catch (error) {
      expect(isAppError(error) && error.message).toMatch(/optional|weaken|requirement/i);
    }
    // Nothing about the original plan moved.
    const plan = build();
    expect(plan.gates[0]?.requirementLevel).toBe('REPOSITORY_REQUIRED');
  });

  it('refuses a revision in which a required gate has simply gone missing', () => {
    expect(() => revised([LINT_GATE], 'the CI file is not readable today')).toThrow(/VG-001/);
  });

  it('records a suggested gate the patch legitimately removed', () => {
    const plan = revised([TEST_GATE], 'the patch deletes the lint script');
    expect(plan.gates.map((gate) => gate.id)).toEqual(['VG-001']);
    expect(plan.revisions[0]).toMatchObject({ removed: ['VG-002'], added: [] });
  });

  it('requires a reason, because an unexplained plan change is the thing this guards', () => {
    expect(() =>
      reviseVerificationPlan(build(), {
        discovered: discovery([TEST_GATE, LINT_GATE, BUILD_GATE]),
        reason: '   ',
        source: CI_SOURCE,
        now,
      }),
    ).toThrow(/reason/i);
  });
});

export type PlanFixture = VerificationPlan;
