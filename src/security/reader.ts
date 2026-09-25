import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { sha256Hex } from './digest.js';
import { hasGitSegment, isInsideRoot, resolveInsideRoot } from './path-safety.js';
import { resolveExistingAncestor } from './realpath.js';

/**
 * The read half of the write boundary — Stage 6.
 *
 * Stage 5 proved that MergeSutra can put bytes somewhere safe. An agent that
 * can write also wants to look, and a reader with no policy is how a
 * model-authored path ends up fetching `~/.ssh/id_rsa` on the way to
 * "understanding the repository". So this is the same confinement as the writer —
 * relative paths, no `.git`, every existing ancestor resolved and proved inside
 * the root — plus the rules that only matter for reading: a named list of files
 * that are never context, no directory MergeSutra's own runtime creates, a byte
 * cap, and a refusal to pass binary bytes to a model as if they were text.
 *
 * Everything here is read-only. There is no write, delete or rename to reach for.
 */

export const MAX_READ_BYTES = 64 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_FILES = 200;
export const MAX_SEARCH_HITS = 40;
/** How deep a search walks. Past this the honest answer is "not found". */
const SEARCH_MAX_DEPTH = 8;

/** Directories no read, listing, walk or search ever descends into. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.mergesutra',
  '.venv',
  'build',
  'dist',
  'node_modules',
]);

/**
 * Names that are never repository context, whatever the run believes it needs.
 *
 * These are matched on the whole path, not the leaf, because a repository is
 * allowed to contain a file called `config.ts` and a credential store is not.
 */
const SECRET_BASENAMES = new Set([
  '.env',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);
const SECRET_DIRECTORY_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.azure', '.config/gcloud'];
const SECRET_SUFFIXES = ['.key', '.p12', '.pem', '.pfx', '.ttf', '.kdbx'];

export interface ReadReceipt {
  readonly relativePath: string;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  /**
   * Digest of every byte on disk, or `null` when this read was truncated.
   *
   * The writer's compare-before-write rule takes this value as its precondition,
   * so it must describe the whole file or say nothing. A digest over the first
   * 64 KiB would let a caller prove it had seen a prefix and then replace the
   * rest, which is the gap the rule exists to close.
   */
  readonly contentSha256: string | null;
}

export interface ListEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

export interface SearchHit {
  readonly relativePath: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface ConfinedReader {
  readonly root: string;
  /** Refuses (throws `validation`) rather than reading an escaped or secret path. */
  readText(relativePath: string, maxBytes?: number): Promise<ReadReceipt>;
  list(relativeDir?: string): Promise<ListEntry[]>;
  /** Repository-relative file paths, depth- and count-bounded, sorted. */
  walk(relativeDir: string, maxDepth: number, maxFiles: number): Promise<string[]>;
  search(query: string, scope?: string, maxFiles?: number): Promise<SearchResult>;
}

function refusal(relativePath: string, why: string, remediation?: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Refusing to read '${bound(relativePath)}': ${why}.`,
    remediation:
      remediation ?? 'Read only inside the workspace of this run, using repository-relative paths.',
    details: { path: bound(relativePath) },
  });
}

/**
 * Why this path is a credential rather than source, or `null` if it is not.
 *
 * `.env.local` and `.env.production` are the same secret with a suffix, and so
 * is `keys/deploy.pem`; matching a basename alone would let both through.
 */
export function secretReason(relativePath: string): string | null {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter((segment) => segment !== '');
  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('.env')) return 'it is an environment file';
  if (SECRET_BASENAMES.has(base)) return 'it is a credential store or private key';
  if (SECRET_SUFFIXES.some((suffix) => base.endsWith(suffix))) return 'it is a key material file';
  const joined = segments.join('/');
  if (SECRET_DIRECTORY_SEGMENTS.some((directory) => joined.startsWith(directory))) {
    return 'it lives inside a credential directory';
  }
  return null;
}

/**
 * Whether these bytes should be sent to a language model as text.
 *
 * A NUL byte in the first kilobyte is what a binary file looks like from the
 * inside; a UTF-8 decode error is what a non-text encoding looks like. Either
 * way the honest answer is "this file is not readable as source", and pasting
 * replacement characters into a prompt produces a confident wrong answer.
 */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, 1024);
  if (head.includes('\u0000')) return true;
  return (head.match(/\uFFFD/g) ?? []).length > 8;
}

export async function openConfinedReader(candidateRoot: string): Promise<ConfinedReader> {
  const requested = path.resolve(candidateRoot);
  const info = await stat(requested).catch(() => null);
  if (!info?.isDirectory()) {
    throw new AppError({
      kind: 'validation',
      message: `The workspace to read does not exist: ${bound(requested)}`,
      remediation: 'Create the run workspace before asking it for files.',
    });
  }
  const root = await realpath(requested);

  async function confine(relativePath: string, why: string): Promise<string> {
    // Throws its own refusal for traversal, absolute paths and NUL bytes.
    const absolute = resolveInsideRoot(root, relativePath, why);
    if (hasGitSegment(relativePath)) {
      throw refusal(relativePath, 'the path crosses .git', 'Read source files, not Git internals.');
    }
    const secret = secretReason(relativePath);
    if (secret) {
      throw refusal(
        relativePath,
        `credentials are not repository context because ${secret}`,
        'Ask the human for the value out of band; MergeSutra never reads a secret into a prompt.',
      );
    }
    const real = await resolveExistingAncestor(absolute);
    if (!isInsideRoot(root, real)) {
      throw refusal(relativePath, 'a link or directory on the way resolves outside the workspace');
    }
    return absolute;
  }

  async function readText(relativePath: string, maxBytes = MAX_READ_BYTES): Promise<ReadReceipt> {
    const absolute = await confine(relativePath, `read target '${relativePath}'`);
    const file = await stat(absolute).catch(() => null);
    if (!file?.isFile()) {
      throw refusal(
        relativePath,
        'there is no regular file there',
        'Read a file, not a directory.',
      );
    }
    const buffer = Buffer.alloc(Math.min(file.size, maxBytes));
    const truncated = file.size > maxBytes;
    const handle = await open(absolute, 'r');
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
    } finally {
      await handle.close();
    }
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (looksBinary(text)) {
      throw refusal(
        relativePath,
        'the content is binary, not source text',
        'Name a text file; binary content is never sent to the model.',
      );
    }
    return {
      relativePath: relativePath.replaceAll('\\', '/'),
      text,
      bytes: file.size,
      truncated,
      contentSha256: truncated ? null : sha256Hex(buffer.subarray(0, bytesRead)),
    };
  }

  async function list(relativeDir = '.'): Promise<ListEntry[]> {
    const absolute =
      relativeDir === '.' ? root : await confine(relativeDir, `directory '${relativeDir}'`);
    const names = await readdir(absolute).catch(() => [] as string[]);
    const entries: ListEntry[] = [];
    for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
      if (SKIPPED_DIRECTORIES.has(name)) continue;
      const child = await stat(path.join(absolute, name)).catch(() => null);
      entries.push({
        name,
        kind: child?.isDirectory() ? 'directory' : child?.isFile() ? 'file' : 'other',
      });
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async function walk(relativeDir: string, maxDepth: number, maxFiles: number): Promise<string[]> {
    const collected: string[] = [];
    await descend(relativeDir, 0);
    return collected.sort();

    async function descend(dir: string, depth: number): Promise<void> {
      if (depth >= maxDepth || collected.length >= maxFiles) return;
      const absolute = dir === '.' ? root : path.join(root, dir);
      const names = await readdir(absolute).catch(() => [] as string[]);
      for (const name of names.sort()) {
        if (collected.length >= maxFiles) return;
        if (SKIPPED_DIRECTORIES.has(name)) continue;
        const relative = dir === '.' ? name : `${dir}/${name}`;
        if (secretReason(relative)) continue;
        const child = await stat(path.join(root, relative)).catch(() => null);
        if (!child) continue;
        if (child.isDirectory()) await descend(relative, depth + 1);
        else if (child.isFile()) collected.push(relative);
      }
    }
  }

  /**
   * Literal, case-insensitive, and bounded three ways: files scanned, hits
   * returned, bytes read per file. A regex search would let a model-authored
   * query become code that this process executes.
   */
  async function search(
    query: string,
    scope?: string,
    maxFiles = MAX_SEARCH_FILES,
  ): Promise<SearchResult> {
    if (query.trim() === '') {
      throw new AppError({
        kind: 'validation',
        message: 'A search needs a non-empty query.',
        remediation: 'Ask for a literal string to look for.',
      });
    }
    if (scope !== undefined) await confine(scope, `search scope '${scope}'`);
    const needle = query.toLowerCase();
    const files = await walk(scope ?? '.', SEARCH_MAX_DEPTH, maxFiles);
    const hits: SearchHit[] = [];
    let scanned = 0;
    for (const file of files) {
      if (hits.length >= MAX_SEARCH_HITS) break;
      // A secret path is skipped rather than refused: searching the whole
      // repository should not fail because one credential file exists in it.
      if (secretReason(file)) continue;
      const receipt = await readText(file, MAX_READ_BYTES).catch(() => null);
      if (!receipt) continue;
      scanned += 1;
      const lines = receipt.text.split(/\r?\n/);
      for (let index = 0; index < lines.length && hits.length < MAX_SEARCH_HITS; index += 1) {
        const line = lines[index] ?? '';
        if (line.toLowerCase().includes(needle)) {
          hits.push({ relativePath: file, line: index + 1, text: bound(line.trim()) });
        }
      }
    }
    return { hits, filesScanned: scanned, truncated: hits.length >= MAX_SEARCH_HITS };
  }

  return { root, readText, list, walk, search };
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 100 ? oneLine : `${oneLine.slice(0, 97)}...`;
}
