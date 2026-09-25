import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import type { VerifyStageDeps } from '../../src/verify/stage.js';
import { cleanUp, hasGit, implementedRun, scriptedGates, NOW } from '../helpers/verifyRun.js';

/**
 * `mergesutra verify` — read as a human, not as a record.
 *
 * The stage suite proves the wiring; this one proves the *report*: that a
 * reader who never opens the JSON cannot walk away thinking an unconsented
 * run passed, that a blocked gate tells them the exact words to unblock it,
 * and that the model's own account of finishing sits under a heading that
 * says it is an account. Those are the ways a correct engine still gets
 * misread.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

/** The gate ids a run is waiting on, exactly as the report prints them. */
async function repositoryIdsOf(deps: Partial<VerifyStageDeps>, runId: string): Promise<string[]> {
  const stage = await runVerifyStage({ runId }, deps);
  return stage.plan.gates
    .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
    .map((gate) => gate.id);
}

async function allowFlags(deps: Partial<VerifyStageDeps>, runId: string): Promise<string[]> {
  return (await repositoryIdsOf(deps, runId)).flatMap((id) => ['--allow', id]);
}

describe.skipIf(!AVAILABLE)('mergesutra verify', () => {
  it('prints a blocked run as blocked, and says the exact words that unblock it', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const c = capture();

    const code = await run(['node', 'mergesutra', 'verify', source.runId], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
      verify: { store: prepared.store, now: () => NOW, ...scriptedGates() },
    });

    expect(code).toBe(EXIT.BLOCKED);
    expect(c.text()).toContain('BLOCKED');
    expect(c.text()).toContain('git diff --check');
    expect(c.text()).toContain('--allow VG-');
    expect(c.text()).toContain('Run record');
    // The hint describes two different bindings, and must not fold the patch into
    // the consent: the digest covers the commands, and the engine checks the patch.
    expect(c.text()).toMatch(/consents to[\s\S]*exact command/i);
    expect(c.text()).not.toMatch(/consent[^\n]*\bpatch\b/i);
    // The word this stage has no authority to print, printed nowhere.
    expect(c.text()).not.toContain('CONTRIBUTION_READY');
    expect(c.text()).not.toMatch(/all criteria (are )?complete —? (verified|confirmed)/);
  });

  it('exits 0 with a per-criterion table once the operator has named the gates', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const gates = scriptedGates();
    const deps: Partial<VerifyStageDeps> = { store: prepared.store, now: () => NOW, ...gates };
    const c = capture();

    const code = await run(
      ['node', 'mergesutra', 'verify', source.runId, ...(await allowFlags(deps, source.runId))],
      { write: c.write, writeErr: c.writeErr, env: { NO_COLOR: '1' }, verify: deps },
    );

    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain('PASS');
    expect(c.text()).toMatch(/AC-\d+/);
    // The loop's FINISH is on screen as a claim, under MergeSutra's own verdict.
    expect(c.text()).toMatch(/claim/i);
    expect(c.text()).toContain('REVIEW');
  });

  it('refuses a wildcard consent before a single repository command runs', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const gates = scriptedGates();
    const c = capture();

    const code = await run(['node', 'mergesutra', 'verify', source.runId, '--allow', 'all'], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
      verify: { store: prepared.store, now: () => NOW, ...gates },
    });

    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toMatch(/[Rr]efusing/);
    expect(gates.calls).toEqual([]);
  });

  it('keeps the JSON mode a record, not a narrative', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const gates = scriptedGates();
    const deps: Partial<VerifyStageDeps> = { store: prepared.store, now: () => NOW, ...gates };
    const c = capture();

    const code = await run(
      [
        'node',
        'mergesutra',
        '--json',
        'verify',
        source.runId,
        ...(await allowFlags(deps, source.runId)),
      ],
      { write: c.write, writeErr: c.writeErr, env: { NO_COLOR: '1' }, verify: deps },
    );

    const parsed = JSON.parse(c.text()) as {
      recordFile: string | null;
      record: { outcome: string; evidence: { verification: string } | null };
    };
    expect(code).toBe(EXIT.OK);
    expect(parsed.record.outcome).toBe('VERIFICATION_PASS');
    expect(parsed.record.evidence?.verification).toBe('PASS');
  });
});
