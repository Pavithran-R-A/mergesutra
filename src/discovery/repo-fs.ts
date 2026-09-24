import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { isInsideRoot, resolveInsideRoot } from '../security/path-safety.js';

/**
 * The only way Stage 2 looks at a repository: read-only, bounded, confined.
 *
 * A repository is untrusted input, and it is also enormous. Both facts shape
 * this module. Every path is proved to resolve inside the repository root
 * *after* symlinks and Windows junctions are followed, so a link named
 * `package.json` cannot point at `~/.ssh/config`. Every read is capped, and a
 * truncated read says so instead of quietly returning half a file — half a
 * manifest is how a tool ends up asserting something the repository never said.
 *
 * Nothing here executes, writes or deletes.
 */

export const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
export const MAX_DIR_ENTRIES = 200;

/** Names that are never worth reading, whatever the repository claims. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.mergesutra', 'dist', 'build', '.venv']);

export interface FileText {
  readonly relativePath: string;
  readonly text: string;
  readonly bytesOnDisk: number;
  readonly truncated: boolean;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

export interface RepoReader {
  /** The realpath'd root everything below is confined to. */
  readonly root: string;
  readText(relativePath: string, maxBytes?: number): Promise<FileText | null>;
  existsAny(relativePaths: readonly string[]): Promise<string[]>;
  listDirectory(relativeDir?: string): Promise<DirectoryEntry[]>;
  /** Relative paths of files under `relativeDir`, depth-bounded and sorted. */
  walk(relativeDir: string, maxDepth: number, maxFiles: number): Promise<string[]>;
}

export async function openRepoReader(candidateRoot: string): Promise<RepoReader> {
  if (candidateRoot.includes('\0')) {
    throw new AppError({
      kind: 'validation',
      message: 'Refusing to read a repository path containing a NUL byte.',
    });
  }
  const requested = path.resolve(candidateRoot);
  let info;
  try {
    info = await stat(requested);
  } catch {
    throw new AppError({
      kind: 'validation',
      message: `Repository path does not exist: ${requested}`,
      remediation: 'Pass --repo pointing at a directory inside a Git working tree.',
    });
  }
  if (!info.isDirectory()) {
    throw new AppError({
      kind: 'validation',
      message: `Repository path is not a directory: ${requested}`,
    });
  }
  const root = await realpath(requested);
  return buildReader(root);
}

function buildReader(root: string): RepoReader {
  async function confine(relativePath: string): Promise<string> {
    const resolved = resolveInsideRoot(root, relativePath, `repository path '${relativePath}'`);
    // A link can point out of the repository even when its name looks safe.
    const real = await realpathParent(resolved);
    if (!isInsideRoot(root, real)) {
      throw new AppError({
        kind: 'validation',
        message: `Refusing to read '${relativePath}': it resolves outside the repository.`,
        remediation: 'Repository links must stay inside the working tree being inspected.',
        details: { relativePath },
      });
    }
    return resolved;
  }

  return {
    root,

    async readText(relativePath, maxBytes = DEFAULT_MAX_FILE_BYTES) {
      const absolute = await confine(relativePath);
      let fileStat;
      try {
        fileStat = await lstat(absolute);
      } catch {
        return null;
      }
      if (!fileStat.isFile()) return null;
      const buffer = Buffer.alloc(Math.min(fileStat.size, maxBytes));
      const fh = await open(absolute, 'r');
      let bytesRead: number;
      try {
        ({ bytesRead } = await fh.read(buffer, 0, buffer.length, 0));
      } finally {
        await fh.close();
      }
      return {
        relativePath: relativePath.replaceAll('\\', '/'),
        text: buffer.subarray(0, bytesRead).toString('utf8'),
        bytesOnDisk: fileStat.size,
        truncated: fileStat.size > maxBytes,
      };
    },

    async existsAny(relativePaths) {
      const found: string[] = [];
      for (const relative of relativePaths) {
        try {
          const absolute = await confine(relative);
          const info = await stat(absolute);
          if (info.isFile()) found.push(relative.replaceAll('\\', '/'));
        } catch {
          // Absent or escaping: either way it is not a file we will read.
        }
      }
      return found;
    },

    async listDirectory(relativeDir = '.') {
      const absolute = relativeDir === '.' ? root : await confine(relativeDir);
      let names: string[];
      try {
        names = await readdir(absolute);
      } catch {
        return [];
      }
      const entries: DirectoryEntry[] = [];
      for (const name of names.slice(0, MAX_DIR_ENTRIES)) {
        const kind = await lstat(path.join(absolute, name))
          .then((info) => (info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'))
          .catch(() => 'other' as const);
        entries.push({ name, kind });
      }
      return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    async walk(relativeDir, maxDepth, maxFiles) {
      const collected: string[] = [];
      await descend(relativeDir, 0);
      return collected.sort();

      async function descend(dir: string, depth: number): Promise<void> {
        if (depth >= maxDepth || collected.length >= maxFiles) return;
        const absolute = dir === '.' ? root : path.join(root, dir);
        let entries: string[];
        try {
          entries = await readdir(absolute);
        } catch {
          return;
        }
        for (const name of entries.sort()) {
          if (collected.length >= maxFiles) return;
          if (SKIP_DIRECTORIES.has(name) || name.startsWith('.')) continue;
          const relative = dir === '.' ? name : `${dir}/${name}`;
          const info = await lstat(path.join(root, relative)).catch(() => null);
          if (!info) continue;
          if (info.isDirectory()) await descend(relative, depth + 1);
          else if (info.isFile()) collected.push(relative);
        }
      }
    },
  };
}

/**
 * Realpath the nearest existing ancestor.
 *
 * `realpath` fails on paths that do not exist yet, and discovery asks about
 * files a repository may not have; resolving the parent is enough to judge
 * where a link would lead.
 */
async function realpathParent(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch {
    const parent = path.dirname(absolute);
    try {
      return path.join(await realpath(parent), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}
