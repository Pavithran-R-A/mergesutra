import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DRIVER = path.join(ROOT, 'scripts', 'e2e-validation.mjs');
const HELPER = path.join(ROOT, 'scripts', 'lib', 'live-failure-budget.mjs');

describe('live failure artifact request accounting', () => {
  it('counts real ledger markers, and never turns unreadable evidence into zero', () => {
    // Use the shipped helper in an actual Node child so this works on Windows paths
    // containing spaces, without importing a runnable live driver or making API calls.
    const source = `
import { pathToFileURL } from 'node:url';
const { countLedgerReservations } = await import(pathToFileURL(process.argv[1]).href);
const mode = 'live';
const ledgerDirectory = '/private/ledger';
const input = { mode, ledgerDirectory };
const observed = await Promise.all([
  countLedgerReservations({ ...input, readNames: async () =>
    ['completion-0001', 'completion-0002', 'readme.txt', 'completion-12345'] }),
  countLedgerReservations({ ...input, readNames: async () => [] }),
  countLedgerReservations({ ...input, readNames: async () => {
    throw new Error('permission denied');
  } }),
  countLedgerReservations({ ...input, readNames: async () => null }),
  countLedgerReservations({ mode: 'no-key', ledgerDirectory, readNames: async () =>
    ['completion-0001'] }),
  countLedgerReservations({ mode, ledgerDirectory: undefined, readNames: async () =>
    ['completion-0001'] }),
]);
console.log(JSON.stringify(observed));
`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source, HELPER], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    expect(JSON.parse(output)).toEqual([2, 0, null, null, null, null]);
  });

  it('records budget evidence on failed live runs, not only successful runs', () => {
    const driver = readFileSync(DRIVER, 'utf8');
    const finalCatch = driver.slice(driver.lastIndexOf('try {\n  await main();'));
    expect(finalCatch).toContain('const reservationsWritten = await countReservations()');
    expect(finalCatch).toContain('ceilingEnforcedBeforeTransport: MAX_MODEL_COMPLETIONS');
    expect(finalCatch).toContain('reservationsWrittenToLedger: reservationsWritten');
    expect(finalCatch).toContain('workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT');
    expect(finalCatch).toContain("mode === 'live'");
    expect(finalCatch).not.toContain('ledgerDirectory:');
    expect(finalCatch).not.toContain('BHARATCODE_API_KEY');
  });
});
