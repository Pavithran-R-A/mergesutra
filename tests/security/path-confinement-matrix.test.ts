import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { isCaseInsensitivePlatform, isInsideRoot } from '../../src/security/path-safety.js';
import {
  MAX_WRITE_BYTES,
  openConfinedWriter,
  type ConfinedWriter,
} from '../../src/security/writer.js';
import { CAN_SYMLINK, makeLink, snapshotTree } from '../helpers/fixture.js';

/**
 * The path-confinement matrix (S12-10).
 *
 * SECURITY_MODEL says the writer confines writes to the workspace of this run. A
 * claim tested against one spelling of one attack is a claim about that spelling,
 * so this file attempts a great many of them and records, for each one, **which
 * check stopped it** — or that it was never an escape, and that the bytes it
 * wrote stayed inside anyway.
 *
 * The layers, in the order `src/security/writer.ts` applies them:
 *
 * 1. `resolveInsideRoot` — lexical: empty, NUL, absolute, drive-letter, a leading
 *    `\`, a literal `..` segment; then containment re-proved after `path.resolve`;
 * 2. `hasGitSegment` — no path crossing `.git`, in any case spelling;
 * 3. `resolveExistingAncestor` + `isInsideRoot` — the deepest existing component
 *    is realpath'd and must still be inside;
 * 4. the content — NUL, `MAX_WRITE_BYTES`;
 * 5. `lstat` on the target — an existing symlink or directory is refused;
 * 6. the precondition — `STALE_FILE` before the only replacing operation.
 *
 * What this file deliberately does not claim is that the writer is proof against
 * symlinks in a wide sense. Several rows below end in a write rather than
 * a refusal (`...`, `.. `, a trailing dot, an 8.3 short name, a hard link): each
 * is confined, none is refused, and the assertions say exactly that. The window
 * between layer 3 and the rename has its own file — `toctou-window.test.ts` —
 * because a matrix of fixed inputs cannot reach it.
 */

const TEXT = 'written-by-the-matrix\n';
const CASE_INSENSITIVE = isCaseInsensitivePlatform();

/** Message fingerprints, one per check, so a row reports who refused it. */
const REFUSAL = {
  traversal: /contains a parent traversal segment/,
  relative: /must be relative to the authorized root/,
  nul: /contains a NUL byte/,
  empty: /was empty/,
  git: /the path crosses \.git/,
  ancestorLink: /a link or directory on the way resolves outside the workspace/,
  targetSymlink: /the target is a symlink/,
  targetDir: /the target is a directory/,
  precondition: /STALE_FILE/,
  tooLarge: /over the \d+-byte single-write cap/,
} as const;

type Layer = keyof typeof REFUSAL | 'inside';

/** `null` for a row that is not a refusal, which is the point of the split. */
function fingerprint(expect: Layer): RegExp | null {
  return expect === 'inside' ? null : REFUSAL[expect];
}

interface Row {
  /** The attack, as it has a name outside this file. */
  readonly attack: string;
  /** The hostile spelling handed to `writeText`. */
  readonly target: string;
  /** `inside`: not refused, and confined — proved below. */
  readonly expect: Layer;
  readonly content?: string;
  /** Needs a link to exist; skips by name when the platform would not make one. */
  readonly needsLink?: boolean;
  /** Needs a case-insensitive filesystem to be an attack at all. */
  readonly needsCaseFold?: boolean;
  /** Send the digest of other bytes, so the precondition is the thing tested. */
  readonly wrongDigest?: boolean;
}

const LEXICAL_ROWS: Row[] = [
  { attack: 'parent traversal, plain', target: '../escaped.ts', expect: 'traversal' },
  { attack: 'parent traversal, deeper', target: 'src/../../escaped.ts', expect: 'traversal' },
  { attack: 'parent traversal, backslash', target: '..\\escaped.ts', expect: 'traversal' },
  { attack: 'bare dot-dot', target: '..', expect: 'traversal' },
  {
    attack: 'traversal behind a git name, so the lexical layer answers first',
    target: 'src/.git/../x.ts',
    expect: 'traversal',
  },
  { attack: 'POSIX absolute', target: '/etc/absolute-escape.ts', expect: 'relative' },
  { attack: 'Windows drive-letter absolute', target: 'C:\\Windows\\x.ts', expect: 'relative' },
  { attack: 'UNC share', target: '\\\\server\\share\\x.ts', expect: 'relative' },
  { attack: 'extended-length prefix', target: '\\\\?\\C:\\Windows\\x.ts', expect: 'relative' },
  {
    attack: 'device namespace (named pipe)',
    target: '\\\\.\\pipe\\mergesutra',
    expect: 'relative',
  },
  { attack: 'NUL byte in the name', target: 'with\0nul.ts', expect: 'nul' },
  { attack: 'empty name', target: '', expect: 'empty' },
  { attack: 'the root itself', target: '.', expect: 'targetDir' },
];

const GIT_ROWS: Row[] = [
  { attack: 'git admin file', target: '.git/config', expect: 'git' },
  { attack: 'git admin file, upper case', target: '.GIT/HEAD', expect: 'git' },
  { attack: 'git admin file, mixed case', target: '.Git/hooks/pre-commit', expect: 'git' },
  { attack: 'git admin file, backslash', target: 'sub\\.git\\HEAD', expect: 'git' },
  { attack: 'git admin file, deeper', target: 'src/main/.git/objects/x', expect: 'git' },
  { attack: 'the name on its own', target: '.git', expect: 'git' },
  { attack: 'two-dot git, which is not the git directory', target: '..git/x.ts', expect: 'inside' },
  { attack: 'git without the dot', target: 'git/x.ts', expect: 'inside' },
];

const LOOKALIKE_ROWS: Row[] = [
  { attack: 'three dots, which is not dot-dot', target: '.../x.ts', expect: 'inside' },
  { attack: 'four dots as a file name', target: '....ts', expect: 'inside' },
  { attack: 'dot-dot with a trailing space', target: '.. /x.ts', expect: 'inside' },
  { attack: 'trailing dot on a directory name', target: 'x./leaf.ts', expect: 'inside' },
  { attack: 'URL-encoded dot-dot', target: '%2e%2e/escaped.ts', expect: 'inside' },
  { attack: 'URL-encoded slash', target: '..%2fescaped.ts', expect: 'inside' },
  { attack: 'single dot segment', target: 'src/./inside.ts', expect: 'inside' },
  { attack: 'empty segment', target: 'src//empty-segment.ts', expect: 'inside' },
  { attack: 'dot-dot-dot in the middle', target: 'src/.../x.ts', expect: 'inside' },
  { attack: 'git spelled with a trailing space', target: '.git /config', expect: 'inside' },
  { attack: 'dot-dot-dot with a trailing space', target: 'src/... /x.ts', expect: 'inside' },
];

const CASE_ROWS: Row[] = [
  {
    attack: 'case collision against a file that exists',
    target: 'EXISTING.TS',
    expect: 'precondition',
    needsCaseFold: true,
  },
  {
    attack: 'case collision against a file inside a directory',
    target: 'SRC/HELD.TS',
    expect: 'precondition',
    needsCaseFold: true,
  },
  {
    attack: 'the same directory spelled with another case',
    target: 'SRC/other-case.ts',
    expect: 'inside',
  },
];

const LINK_ROWS: Row[] = [
  {
    attack: 'a link or junction ancestor pointing outside',
    target: 'outlink/deep/x.ts',
    expect: 'ancestorLink',
    needsLink: true,
  },
  {
    attack: 'a link to a directory that is inside',
    target: 'innerlink/via-link.ts',
    expect: 'inside',
    needsLink: true,
  },
  {
    attack: 'a link to the workspace itself',
    target: 'selfdir/x.ts',
    expect: 'inside',
    needsLink: true,
  },
  {
    attack: 'two links deep, the second pointing outside',
    target: 'chain1/chain2/x.ts',
    expect: 'ancestorLink',
    needsLink: true,
  },
  {
    attack: 'an inside link hiding an outside link',
    target: 'nest/escape/x.ts',
    expect: 'ancestorLink',
    needsLink: true,
  },
  {
    attack: 'a file link whose target is inside',
    target: 'syminside.ts',
    expect: 'targetSymlink',
    needsLink: true,
  },
  {
    attack: 'a file link whose target is outside',
    target: 'symoutside.ts',
    expect: 'ancestorLink',
    needsLink: true,
  },
  {
    attack: 'a dangling link, whose target does not exist yet',
    target: 'dangling.ts',
    expect: 'targetSymlink',
    needsLink: true,
  },
];

const PRECONDITION_ROWS: Row[] = [
  {
    attack: 'a file whose bytes are not what the caller believes',
    target: 'existing.ts',
    expect: 'precondition',
    wrongDigest: true,
  },
  {
    attack: 'a file the caller believes is new',
    target: 'src/held.ts',
    expect: 'precondition',
  },
];

const CONTENT_ROWS: Row[] = [
  {
    attack: 'content over the single-write cap',
    target: 'huge.ts',
    expect: 'tooLarge',
    content: 'a'.repeat(MAX_WRITE_BYTES + 1),
  },
  {
    attack: 'a NUL byte in the content',
    target: 'nul-content.ts',
    expect: 'nul',
    content: 'a\0b',
  },
];

const SCRATCH = await mkdtemp(path.join(tmpdir(), 'mergesutra-matrix-'));
const OUTSIDE = path.join(SCRATCH, 'outside');
const STAGING = path.join(SCRATCH, 'staging');
const WORKSPACE = path.join(SCRATCH, 'workspace');

/** Every path under the scratch directory that is not inside the workspace. */
async function outsideTree(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(SCRATCH, { withFileTypes: true })) {
    if (entry.name === 'workspace') continue;
    if (entry.isDirectory()) out.push(...(await snapshotTree(SCRATCH, entry.name)));
    else out.push(entry.name);
  }
  return out.sort();
}

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

let linksMade = false;
let hardLinksMade = false;
let outsideBefore: string[] = [];
let writer: ConfinedWriter;

beforeAll(async () => {
  await mkdir(path.join(OUTSIDE, 'keep'), { recursive: true });
  await writeFile(path.join(OUTSIDE, 'secret.txt'), 'outside the workspace\n', 'utf8');
  await mkdir(WORKSPACE, { recursive: true });
  await writeFile(path.join(WORKSPACE, 'existing.ts'), 'const a = 1;\n', 'utf8');
  await mkdir(path.join(WORKSPACE, 'src'), { recursive: true });
  await writeFile(path.join(WORKSPACE, 'src', 'held.ts'), 'held\n', 'utf8');

  const links: Array<readonly [string, string, 'file' | 'directory']> = [
    [OUTSIDE, path.join(WORKSPACE, 'outlink'), 'directory'],
    [path.join(WORKSPACE, 'src'), path.join(WORKSPACE, 'innerlink'), 'directory'],
    [WORKSPACE, path.join(WORKSPACE, 'selfdir'), 'directory'],
    [STAGING, path.join(WORKSPACE, 'chain1'), 'directory'],
    [OUTSIDE, path.join(STAGING, 'chain2'), 'directory'],
    [OUTSIDE, path.join(WORKSPACE, 'nest', 'escape'), 'directory'],
    [path.join(WORKSPACE, 'existing.ts'), path.join(WORKSPACE, 'syminside.ts'), 'file'],
    [path.join(OUTSIDE, 'secret.txt'), path.join(WORKSPACE, 'symoutside.ts'), 'file'],
    [path.join(WORKSPACE, 'nope.ts'), path.join(WORKSPACE, 'dangling.ts'), 'file'],
  ];
  const made = await Promise.all(links.map(([target, at, kind]) => makeLink(target, at, kind)));
  linksMade = made.every(Boolean);

  try {
    await link(path.join(OUTSIDE, 'secret.txt'), path.join(WORKSPACE, 'probe-hardlink.txt'));
    hardLinksMade = true;
  } catch {
    hardLinksMade = false;
  }

  writer = await openConfinedWriter(WORKSPACE);
  outsideBefore = await outsideTree();
});

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * One row, one honest assertion.
 *
 * A refused row is checked against the fingerprint of the check that refused it,
 * so the table cannot quietly degrade into "something threw". A row that is *not*
 * refused is checked for the thing that actually matters: the bytes are inside
 * the root both as spelled and as the filesystem resolves them, and nothing
 * appeared outside.
 */
function testRow(row: Row): void {
  const skip =
    (row.needsLink === true && !CAN_SYMLINK) || (row.needsCaseFold === true && !CASE_INSENSITIVE);
  const run = skip ? it.skip : it;
  run(row.attack, async (ctx) => {
    if (row.needsLink === true && !linksMade) ctx.skip();
    const precondition =
      row.wrongDigest === true
        ? { expectedSha256: digestOf('bytes the caller never read\n') }
        : { expectedAbsent: true as const };
    const content = row.content ?? TEXT;

    const marker = fingerprint(row.expect);
    if (marker === null) {
      const receipt = await writer.writeText(row.target, content, precondition);
      expect(receipt.created, row.attack).toBe(true);
      const spelled = path.resolve(writer.root, ...row.target.split(/[\\/]+/).filter(Boolean));
      expect(isInsideRoot(writer.root, spelled), row.attack).toBe(true);
      expect(readFileSync(spelled, 'utf8'), row.attack).toBe(content);
      // Where the bytes actually are, as the filesystem sees it.
      expect(isInsideRoot(writer.root, await realpath(spelled)), row.attack).toBe(true);
    } else {
      const failure = await writer.writeText(row.target, content, precondition).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, row.attack).toBeInstanceOf(AppError);
      expect((failure as Error).message, row.attack).toMatch(marker);
    }

    // The invariant every row carries, refused or not: nothing reached outside.
    expect(await outsideTree(), row.attack).toEqual(outsideBefore);
    expect(await readFile(path.join(OUTSIDE, 'secret.txt'), 'utf8')).toContain('outside');
  });
}

describe('layer 1 — the lexical check', () => {
  for (const row of LEXICAL_ROWS) testRow(row);
});

describe('layer 2 — no path that crosses .git', () => {
  for (const row of GIT_ROWS) testRow(row);
});

describe('names that look hostile and are not', () => {
  for (const row of LOOKALIKE_ROWS) testRow(row);

  it('does not let a trailing dot overwrite the file it resembles', async () => {
    // Some Windows builds strip a trailing dot, some keep it as part of the name.
    // Either answer is safe here, and this asserts the safe invariant rather than
    // the spelling: `name.` may become a second entry, or it may collide with
    // `name` — but it may not silently replace bytes the caller never read.
    const original = path.join(WORKSPACE, 'collide.ts');
    await writeFile(original, 'the version on disk\n', 'utf8');
    const outcome = await writer
      .writeText('collide.ts.', 'the version proposed\n', { expectedAbsent: true })
      .then(
        () => 'written as a second entry',
        () => 'refused as stale',
      );
    expect(readFileSync(original, 'utf8'), `the write was ${outcome}`).toBe(
      'the version on disk\n',
    );
  });

  it('treats an empty segment as the directory it normalizes to, and notices', async () => {
    // The point of the row above is not that `src//x.ts` is allowed; it is that it
    // is the *same file* as `src/x.ts`. A caller cannot use the extra slash to get
    // a second copy of a file it never read, because the precondition resolves the
    // same way the filesystem does.
    await writer.writeText('src/normalized.ts', TEXT, { expectedAbsent: true });
    await expect(
      writer.writeText('src//normalized.ts', 'other\n', { expectedAbsent: true }),
    ).rejects.toThrow(REFUSAL.precondition);
    expect(readFileSync(path.join(WORKSPACE, 'src', 'normalized.ts'), 'utf8')).toBe(TEXT);
  });
});

describe('case-colliding names', () => {
  for (const row of CASE_ROWS) testRow(row);
});

describe('layers 3 and 5 — links, junctions and what they hide', () => {
  for (const row of LINK_ROWS) testRow(row);
});

describe('layer 6 — the precondition is the last line of defence', () => {
  for (const row of PRECONDITION_ROWS) testRow(row);
});

describe('layer 4 — the content, not the name', () => {
  for (const row of CONTENT_ROWS) testRow(row);
});

describe('the two cases no check can see, and what still holds', () => {
  it('refuses a blind overwrite of a hard link, because only the precondition notices it', async (ctx) => {
    if (!hardLinksMade) ctx.skip();
    const target = path.join(WORKSPACE, 'probe-hardlink.txt');
    // A hard link is a regular file with two names. No layer of the confinement
    // check can tell it from an ordinary file, so a caller that claims the path is
    // new is stopped by the precondition alone — which is a narrower guarantee
    // than "links are detected", and is stated here as the narrower thing.
    await expect(
      writer.writeText('probe-hardlink.txt', TEXT, { expectedAbsent: true }),
    ).rejects.toThrow(REFUSAL.precondition);
    expect(readFileSync(target, 'utf8')).toBe('outside the workspace\n');
    expect(readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8')).toBe('outside the workspace\n');
  });

  it('replaces a hard-linked name by rename and leaves the other name untouched', async (ctx) => {
    if (!hardLinksMade) ctx.skip();
    const outside = path.join(OUTSIDE, 'secret.txt');
    const target = path.join(WORKSPACE, 'probe-hardlink.txt');
    await writer.writeText('probe-hardlink.txt', 'replaced inside\n', {
      expectedSha256: digestOf('outside the workspace\n'),
    });
    // The workspace name holds new bytes; the outside name still holds the ones it
    // has always held, because the writer never writes into an inode — it puts a
    // new file at a name and renames over the entry. That is why a link the check
    // cannot see still cannot carry bytes out of the workspace.
    expect(readFileSync(target, 'utf8')).toBe('replaced inside\n');
    expect(readFileSync(outside, 'utf8')).toBe('outside the workspace\n');
    expect(await outsideTree()).toEqual(outsideBefore);
  });
});

describe('what the whole matrix leaves behind', () => {
  it('writes nothing outside the workspace, in any row', async () => {
    expect(await outsideTree()).toEqual(outsideBefore);
    for (const name of ['escaped.ts', 'absolute-escape.ts', 'nul-content.ts', 'huge.ts', 'x.ts']) {
      expect(existsSync(path.join(SCRATCH, name)), name).toBe(false);
    }
  });

  it('leaves no temp artefact anywhere in the workspace', async () => {
    const strays: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const name = `${prefix}/${entry.name}`;
        if (entry.name.includes('mergesutra-tmp')) strays.push(name);
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), name);
      }
    };
    await walk(WORKSPACE, '.');
    expect(strays).toEqual([]);
  });

  it('gives every row a place of its own to write to', () => {
    const rows = [
      ...LEXICAL_ROWS,
      ...GIT_ROWS,
      ...LOOKALIKE_ROWS,
      ...CASE_ROWS,
      ...LINK_ROWS,
      ...PRECONDITION_ROWS,
      ...CONTENT_ROWS,
    ];
    expect(new Set(rows.map((row) => row.target)).size).toBe(rows.length);

    // Two rows whose spellings differ but whose resolved file is the same make the
    // second answer depend on the first: it would then be refused by the
    // precondition rather than by the check it claims to be exercising. This
    // caught `src/./inside.ts` and `src//inside.ts` while the table was written.
    const resolved = rows
      .filter((row) => row.expect === 'inside')
      .map((row) =>
        row.target
          .split(/[\\/]+/)
          .filter(Boolean)
          .join('/'),
      );
    expect(new Set(resolved).size, 'two rows resolve to the same file').toBe(resolved.length);
    expect(rows.length).toBeGreaterThanOrEqual(45);
  });
});

describeIfPlatform(process.platform === 'win32', '8.3 short names (Windows only)', () => {
  it('a short name that aliases a directory inside stays inside', async () => {
    const longName = 'MERGESUTRALONGDIRNAME';
    await mkdir(path.join(WORKSPACE, longName), { recursive: true });
    // A short name is an alias for an entry of a directory the check has already
    // walked through, so it cannot invent an escape on its own. What it does do is
    // resolve to a *different spelling* than the one compared, which is the reason
    // the assertion below is about where the bytes came to rest, not about a path
    // that was refused.
    const receipt = await writer.writeText('MERGES~1/short.ts', TEXT, { expectedAbsent: true });
    expect(receipt.created).toBe(true);
    const viaAlias = existsSync(path.join(WORKSPACE, longName, 'short.ts'));
    const viaLiteralName = existsSync(path.join(WORKSPACE, 'MERGES~1', 'short.ts'));
    expect(viaAlias || viaLiteralName).toBe(true);
    expect(await outsideTree()).toEqual(outsideBefore);
  });
});

function describeIfPlatform(applicable: boolean, name: string, fn: () => void): void {
  if (applicable) describe(name, fn);
  else describe.skip(name, fn);
}
