import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summarizeAudit } from '../../scripts/lib/audit-summary.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

describe('full dependency audit qualification', () => {
  it('records moderate findings while requiring zero high or critical findings', () => {
    expect(
      summarizeAudit({
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 7, high: 0, critical: 0, total: 7 },
        },
      }),
    ).toEqual({ info: 0, low: 0, moderate: 7, high: 0, critical: 0, total: 7 });
  });

  it('rejects high, critical, malformed, or inconsistent reports', () => {
    for (const counts of [
      { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
      { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 },
      { info: 0, low: 0, moderate: -1, high: 0, critical: 0, total: 0 },
      { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: '0' },
      { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 0 },
    ]) {
      expect(() => summarizeAudit({ metadata: { vulnerabilities: counts } })).toThrow();
    }
  });

  it('runs the full JSON audit and checks its exit code', () => {
    const script = readFileSync(path.join(ROOT, 'scripts', 'full-audit-gate.mjs'), 'utf8');
    expect(script).toContain("['audit', '--json']");
    expect(script).toContain('result.status !== 0 && result.status !== 1');
    expect(script).toContain('summarizeAudit(report)');
    expect(script).toContain('(counts.total === 0) !== (result.status === 0)');
  });
});
