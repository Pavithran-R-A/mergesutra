// Evidence-only reading of the budget ledger. Never prints the ledger path, credentials,
// marker bytes or model output. This does not reserve or refund completion requests.
import { readdir } from 'node:fs/promises';

/**
 * Return the number of previously reserved completion requests. A missing, unreadable
 * or malformed ledger is UNKNOWN (null), never zero. A real empty directory is zero.
 */
export async function countLedgerReservations({ mode, ledgerDirectory, readNames = readdir }) {
  if (mode !== 'live' || typeof ledgerDirectory !== 'string' || ledgerDirectory.length === 0) {
    return null;
  }
  let names;
  try {
    names = await readNames(ledgerDirectory);
  } catch {
    return null;
  }
  if (!Array.isArray(names)) return null;
  return names.filter((name) => typeof name === 'string' && /^completion-\d{4}$/.test(name)).length;
}
