import type { RunStore } from '../../src/state/run-store.js';

/**
 * The seams a test uses to stop a stage in the middle of its own filing.
 *
 * An interruption is not reproducible on a schedule, but the state it leaves behind
 * is: a stage that finished its work and never got to write it down. So the seam is
 * the store, and only its `save` — `load` still answers from disk. That distinction
 * is the whole point. A store that also refused to read would make the assertions
 * downstream of it claims about a stub; one that reads lets a test say "the record on
 * disk is still the one the previous stage wrote", which is a claim about persistence.
 */

/** A store that reads fine and cannot write. */
export function storeThatCannotSave(store: RunStore): RunStore {
  return {
    ...store,
    async save(): Promise<string> {
      throw new Error('the disk went away mid-write');
    },
  };
}
