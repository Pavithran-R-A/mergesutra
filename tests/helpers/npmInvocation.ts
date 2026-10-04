import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the npm that came with *this* Node lives, in every layout it ships in.
 *
 * The release-boundary tests ask npm what it would pack, so they need its entry
 * script. Taking it as `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js`
 * is a Windows-shaped guess: a POSIX install puts the binary in `<prefix>/bin` and
 * its own modules in `<prefix>/lib`, so on every Linux runner — and under nvm, apt
 * and Homebrew — that path does not exist, and the gate that proves the artifact
 * carries no credential fails for a reason that has nothing to do with credentials.
 * A globally linked Node is a symlink away from the tree holding npm too, so both
 * the recorded directory and the directory it resolves to are searched.
 *
 * Nothing here invokes npm: resolution is separate from the call so each test keeps
 * its own guard over the flags the call carries.
 */
const NPM_CLI_PARTS = ['node_modules', 'npm', 'bin', 'npm-cli.js'] as const;

/** Absolute path to npm's entry script, or `null` when this install cannot be found. */
export function npmCliScript(): string | null {
  for (const prefix of nodePrefixes()) {
    for (const layout of [[...NPM_CLI_PARTS], ['lib', ...NPM_CLI_PARTS]]) {
      const candidate = path.join(prefix, ...layout);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** The script path for a call that has already established npm is reachable. */
export function requireNpmCli(): string {
  const found = npmCliScript();
  if (found !== null) return found;
  throw new Error(
    'npm is not reachable from this Node install: looked beside the executable and one ' +
      'level up under lib, at both the recorded path and the one it resolves to.',
  );
}

function nodePrefixes(): string[] {
  const found: string[] = [];
  const recorded = path.dirname(process.execPath);
  found.push(recorded, path.join(recorded, '..'));
  const resolved = realDirname(process.execPath);
  if (resolved !== null) found.push(resolved, path.join(resolved, '..'));
  return [...new Set(found)];
}

function realDirname(target: string): string | null {
  try {
    return path.dirname(realpathSync(target));
  } catch {
    return null;
  }
}
