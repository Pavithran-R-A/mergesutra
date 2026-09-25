import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Realpath the deepest existing ancestor and re-attach the rest.
 *
 * `realpath` fails on a path that does not exist yet, and both halves of Stage 6
 * ask about files that may not be there: a plan writes into a directory that has
 * not been created, and a read may name a file the repository never had. Walking
 * up until something resolves is enough to judge where a symlink or a Windows
 * junction along the way would lead — a link three directories above the target
 * cannot hide — without inventing a destination for a leaf that does not exist.
 */
export async function resolveExistingAncestor(absolute: string): Promise<string> {
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}
