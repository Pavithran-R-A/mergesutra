import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOURCE_BRANCH_PREFIX } from '../../src/pr/branch.js';
import { RUN_STATE_DIRNAME } from '../../src/state/run-store.js';
import { WORKTREE_BASE_DIR } from '../../src/git/workspace.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

/**
 * MergeSutra never removes anything it created: `git worktree remove` and `worktree prune` are
 * never called, which `tests/git/workspace.test.ts` holds by watching the Git calls the workspace
 * module makes. That refusal is a promise with a consequence — a run leaves a worktree, a branch
 * and a record on the customer's disk — so the removal belongs to the customer, and the document
 * they installed is the only place they can read how. `docs/` is not in `package.json`'s `files`,
 * so an ADR cannot answer the question for an installed tool.
 *
 * The check is set-inclusion of command names and of the paths the code itself builds, inside the
 * one section that answers the question. It says nothing about the sentences around them.
 */
const cleanupSection = (): string => {
  const sections = readme.split(/^## /m).slice(1);
  const wanted = sections.find((section) =>
    /^(what a run )?(leaves|left behind|clean)/i.test(section.split('\n')[0] ?? ''),
  );
  return wanted ?? '';
};

describe('the shipped README tells a customer how to remove what a run leaves', () => {
  it('has a section for it', () => {
    expect(cleanupSection(), 'README has no section about run leftovers').not.toBe('');
  });

  it('names the two Git verbs the tool deliberately never calls', () => {
    const section = cleanupSection();
    for (const verb of ['git worktree remove', 'git worktree prune']) {
      expect(section, `README's leftovers section omits ${verb}`).toContain(verb);
    }
  });

  it('names each leftover by the path or prefix the code builds it from', () => {
    const section = cleanupSection();
    for (const leftover of [
      WORKTREE_BASE_DIR,
      `${RUN_STATE_DIRNAME}/runs`,
      `${SOURCE_BRANCH_PREFIX}/`,
    ]) {
      expect(section, `README's leftovers section omits ${leftover}`).toContain(leftover);
    }
  });

  it('names how the tool itself goes away', () => {
    const section = cleanupSection();
    expect(section, "README's leftovers section gives no uninstall route").toMatch(
      /npm (rm|uninstall) -g mergesutra/,
    );
  });
});
