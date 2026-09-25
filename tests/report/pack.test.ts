import { describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../../src/report/pack.js';
import type { RunRecord } from '../../src/state/run-record.js';
import { recordAt, verifiedRecord } from '../helpers/report.js';

/**
 * The evidence pack: three files a reviewer reads without running anything.
 *
 * Stage 8's discipline is that a report is a *rendering*. Every status,
 * sufficiency and exit code in here already sits in the run record, written
 * there by the stage that earned it, and the only judgement this module makes is
 * where to put it on the page. That is why the sharpest test is the first one: a
 * run that never verified must not be able to produce a pack that reads as
 * though it did.
 */

function packOf(record: RunRecord) {
  return buildEvidencePack(record);
}

describe('a pack for a run that never verified', () => {
  it('reports the criteria as they stand, with no verdict to over-read', () => {
    const pack = packOf(recordAt());

    expect(pack.files['report.md']).toContain('PENDING');
    expect(pack.files['report.md']).not.toMatch(/VERIFIED|\bPASS\b|contribution ready/i);
  });

  it('holds the absence of verification as a fact instead of an empty success', () => {
    const json = JSON.parse(packOf(recordAt()).files['report.json']) as Record<string, unknown>;

    expect(json.verification).toBeNull();
    expect(json.contributionReady).toBe(false);
  });

  it('attributes a criterion caveat to the contract that wrote it, not to a mapper that never ran', () => {
    // Before `verify` the rows are copied from the contract, so a qualifier
    // beside one of them is the contract's own words. Labelling it "from the
    // evidence mapper" would credit a document that has not run with a sentence
    // it never wrote — the same misattribution, one stage earlier.
    const record = recordAt();
    const caveat = record.acceptanceContract?.criteria[0]?.limitations[0] ?? '';
    expect(caveat).not.toBe('');

    const report = packOf(record).files['report.md'];
    const contractGroup = report.indexOf('Recorded with the Acceptance Contract');

    expect(report).not.toContain('From the evidence mapper');
    expect(contractGroup).toBeGreaterThan(-1);
    expect(report.indexOf(caveat)).toBeGreaterThan(contractGroup);
  });
});

describe('a pack for a run that verified', () => {
  it('carries the receipts as they were filed, one line per gate', async () => {
    const argv = ['node', '--test'];
    const pack = packOf(await verifiedRecord(argv));

    const lines = pack.files['commands.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      gateId: 'VG-001',
      argv,
      cwd: '.',
      result: 'PASS',
      exitCode: 0,
      termination: 'EXITED',
    });
  });

  it('quotes the recorded evidence instead of restating it in its own words', async () => {
    const argv = ['node', '--test'];
    const withRun = await verifiedRecord(argv);

    const json = JSON.parse(packOf(withRun).files['report.json']) as {
      evidence: unknown;
      verification: unknown;
      criteria: readonly { status: string; sufficiency: string; gateIds: readonly string[] }[];
    };

    expect(json.evidence).toEqual(withRun.evidence);
    expect(json.verification).toBe(withRun.verification?.result);
    expect(json.criteria).toEqual([
      {
        id: 'AC-1',
        statement: 'The suite passes.',
        status: 'PASS',
        sufficiency: 'VERIFIED',
        gateIds: ['VG-001'],
        limitations: withRun.evidence?.criteria[0]?.limitations ?? [],
      },
    ]);
  });

  it('shows the gate and the criterion it carried on the same page', async () => {
    const pack = packOf(await verifiedRecord(['node', '--test']));

    expect(pack.files['report.md']).toContain('node --test');
    expect(pack.files['report.md']).toContain('VG-001');
    expect(pack.files['report.md']).toContain('exit 0');
    expect(pack.files['report.md']).not.toMatch(/contribution ready/i);
  });

  it('carries the reason a green row is not trustworthy up to the table', async () => {
    // Implementation continued after the gates ran. The mapper marks the
    // receipts STALE; a pack that printed only the status would show green rows
    // for a patch those rows no longer describe.
    const moved = await verifiedRecord(['node', '--test'], {
      currentPatchIdentity: 'c'.repeat(64),
    });

    expect(moved.evidence?.notes.join(' ')).toMatch(/STALE/);
    expect(packOf(moved).files['report.md']).toMatch(/STALE/);
  });

  it('files what the model said as what the model said', async () => {
    // A reviewer is entitled to the loop's own account of its work, and a pack
    // that hides it is not more honest — it is just less checkable. So the claim
    // is printed, under a heading that says what it is, and never in the table.
    const claimed = await verifiedRecord(['node', '--test'], {
      claims: [{ source: 'FINISH', text: 'parseDate now rejects; the suite covers it.' }],
    });

    const report = packOf(claimed).files['report.md'];
    const criteriaSection = report.split('## Criteria')[1]?.split('\n## ')[0] ?? '';
    expect(criteriaSection).not.toContain('parseDate now rejects');
    expect(report).toMatch(/decided nothing/i);
    expect(report).toContain('the suite covers it');
  });

  it('says which document wrote each caveat, so a carried one is not re-asserted', async () => {
    // A run accumulates caveats: the contract stage writes one, the plan stage
    // carries it, the implement stage carries it again, and the verify record
    // holds all of them. Some of those lines were true of their own stage and
    // are simply false of a record whose rows now read VERIFIED. The pack may
    // not delete them — deciding which caveats a later stage answered is not a
    // renderer's job — but it must not reprint them as though this run said so.
    const carried = 'Nothing here is verified. No criterion changed status.';
    const withRun = await verifiedRecord(['node', '--test'], {
      currentPatchIdentity: 'c'.repeat(64),
      recordLimitations: [carried],
    });

    const report = packOf(withRun).files['report.md'];
    const at = (text: string) => report.indexOf(text);

    expect(at(carried)).toBeGreaterThan(-1);
    expect(at('Recorded by the stages of this run')).toBeGreaterThan(-1);
    expect(at(carried)).toBeGreaterThan(at('Recorded by the stages of this run'));
    // The mapper's own note about these receipts keeps its own attribution, so
    // the two kinds of caveat cannot be read as one undifferentiated list.
    expect(at('STALE')).toBeGreaterThan(-1);
    expect(at('STALE')).toBeLessThan(at('Recorded by the stages of this run'));
  });

  it('keeps the two provenances apart in the machine-readable file too', async () => {
    const carried = 'Nothing here is verified.';
    const withRun = await verifiedRecord(['node', '--test'], { recordLimitations: [carried] });

    const json = JSON.parse(packOf(withRun).files['report.json']) as {
      stageLimitations: readonly string[];
      contractLimitations: readonly string[];
    };

    expect(json.stageLimitations).toContain(carried);
    expect(json.contractLimitations).toEqual(withRun.acceptanceContract?.limitations ?? []);
  });
});
