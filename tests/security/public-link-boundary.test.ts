import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S13-1 — does every public link this project ships point somewhere real?
 *
 * A package manifest is a customer-facing document that happens to be JSON. Its
 * `homepage`, `repository.url` and `bugs.url` are what `npm view`, the npm package
 * page and every downstream dependant print as "where this project lives", so a
 * manifest that names a location which does not exist is not a cosmetic defect: it
 * is a shipped promise about an address nobody can go to. The gap register carried
 * exactly that as the unresolved half of S12-25 — three fields aimed at an
 * organisation this checkout had never evidenced — and named it a publisher's
 * decision rather than a wording fix. The repository now exists, so the decision
 * has been made and this file holds the project to it.
 *
 * Three rules, each with a different failure it exists to catch:
 *
 * 1. **The invented organisation may not appear at all, anywhere in the tracked
 *    tree.** Not just in the manifest: a published clone makes every tracked file
 *    browsable, so a stale pointer in a design note becomes a link a reader can
 *    click. The owner token is *composed* at runtime, which keeps this file from
 *    satisfying the very rule it enforces (proved by its own case below).
 * 2. **The manifest's three public links name one repository, and it is the
 *    canonical one.** Mutually consistent metadata aimed at a location nobody
 *    recognises would pass a same-as-each-other check, so the canonical identity is
 *    pinned here rather than derived. Pinning is deliberate: moving the project
 *    becomes an edit a person makes on purpose, in one place, instead of something
 *    a stray URL change achieves by accident.
 * 3. **The document customers actually read carries a source link.** `README.md` is
 *    one of the roots npm ships; a reader who wants the source, the issue tracker or
 *    the commit behind a released version should not have to guess an owner from a
 *    package name.
 *
 * What this file does **not** claim: it proves *identity*, not *reachability*.
 * Offline tests cannot resolve a URL, and a GitHub repository that is private
 * answers 404 to an unauthenticated request — so "the link works" is a measurement
 * recorded in `docs/SECURITY_GAP_REGISTER.md` (authenticated API now, an
 * unauthenticated fetch after the visibility flip), never an assertion here. A
 * green run means "the project names one real place consistently", not "I got a 200
 * for it".
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SELF = readFileSync(fileURLToPath(import.meta.url), 'utf8');

/** The repository this project publishes to. Both halves are load-bearing. */
const CANONICAL_OWNER = 'Pavithran-R-A';
const CANONICAL_REPO = 'mergesutra';
const CANONICAL_ID = `${CANONICAL_OWNER}/${CANONICAL_REPO}`;

/**
 * The organisation the manifest used to name, which no evidence ever supported.
 *
 * Assembled rather than written out: a file that spelled the stale address in a
 * string literal would contain the byte sequence rule 1 hunts for, and the gate
 * could then only be exercised by breaking it.
 */
const INVENTED_ORG = ['merges', 'utra'].join('');
const INVENTED_ID = `${INVENTED_ORG}/${CANONICAL_REPO}`;

/** Any `github.com/<owner>/<repo>` shape, with the two segments captured. */
const GITHUB_LINK = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g;

interface LinkFinding {
  readonly file: string;
  readonly line: number;
  readonly owner: string;
  readonly repo: string;
}

interface PackageManifest {
  readonly homepage?: string;
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly bugs?: { readonly url?: string };
  readonly files?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
}

function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageManifest;
}

function git(args: readonly string[]): { readonly out: string; readonly ok: boolean } {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 << 28,
  });
  return { out: result.stdout ?? '', ok: result.status === 0 };
}

/** Binary payloads are not prose a reader follows; the sibling gates skip them too. */
function isText(text: string): boolean {
  return !text.includes('\u0000');
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Fresh RegExp per call: a shared `/g` literal carries `lastIndex` between scans. */
function linkPattern(): RegExp {
  return new RegExp(GITHUB_LINK.source, GITHUB_LINK.flags);
}

/**
 * Every `github.com/<owner>/<repo>` in one file, owners and repos intact.
 *
 * Deliberately returns *all* links, not only the bad ones: a scan that filters
 * before reporting cannot tell "the tree holds no stale pointer" apart from "the
 * scan looked at nothing".
 */
function githubLinks(file: string, text: string): LinkFinding[] {
  const found: LinkFinding[] = [];
  const pattern = linkPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const owner = match[1];
    const repo = match[2];
    if (owner === undefined || repo === undefined) continue;
    found.push({ file, line: lineOf(text, match.index), owner, repo });
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return found;
}

/** `<owner>/<repo>` for a manifest URL, npm's `.git` suffix removed. */
function identityOf(url: string): string {
  const match = linkPattern().exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) return `<no github link in ${url}>`;
  return `${owner}/${repo.replace(/\.git$/, '')}`;
}

function trackedText(): Map<string, string> {
  const map = new Map<string, string>();
  const listing = git(['ls-files']);
  expect(listing.ok, 'git ls-files failed, so no tracked tree could be scanned').toBe(true);
  for (const file of listing.out.split('\n').filter(Boolean)) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    if (isText(text)) map.set(file, text);
  }
  return map;
}

/** Walk one shipped root, which may be a single file or a directory tree. */
function filesUnder(relative: string): string[] {
  const full = path.join(ROOT, relative);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [relative];
  const out: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    out.push(...(entry.isDirectory() ? filesUnder(child) : [child]));
  }
  return out;
}

/**
 * The bytes a customer installs, taken from the manifest's own `files` list rather
 * than from an `npm pack` run, so the boundary stays checkable without a build.
 * `dist/` is scanned when present and skipped when not; the artifact-identity gate
 * owns the packed-bytes question.
 *
 * `package.json` is added to the declared roots because npm packs it whatever the
 * list says — `publish-contents.test.ts:17` records that behaviour, and the manifest
 * is the single shipped file whose *entire purpose* is naming a public location.
 */
function shippedSurface(): Map<string, string> {
  const declared = readManifest().files ?? [];
  const roots = declared.includes('package.json') ? declared : ['package.json', ...declared];
  expect(
    roots.length,
    'package.json ships nothing, so there is no surface to guard',
  ).toBeGreaterThan(0);
  const map = new Map<string, string>();
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      if (isText(text)) map.set(file, text);
    }
  }
  return map;
}

describe('public link detector', () => {
  it('reads a canonical repository URL as an owner/repo identity', () => {
    expect(identityOf(`https://github.com/${CANONICAL_OWNER}/${CANONICAL_REPO}`)).toBe(
      CANONICAL_ID,
    );
  });

  it('strips the git suffix npm writes into repository.url', () => {
    expect(identityOf(`git+https://github.com/${CANONICAL_OWNER}/${CANONICAL_REPO}.git`)).toBe(
      CANONICAL_ID,
    );
  });

  it('sees an invented-organisation address as a link, not as prose', () => {
    const links = githubLinks('sample.md', `see https://github.com/${INVENTED_ID}`);
    expect(links).toHaveLength(1);
    expect(links[0]?.owner).toBe(INVENTED_ORG);
  });

  it('leaves a fixture link to somebody else real repository alone', () => {
    const links = githubLinks('sample.ts', 'https://github.com/someone/else/issues/12');
    expect(links).toHaveLength(1);
    expect(links[0]?.owner).toBe('someone');
  });

  it('reports several links in one file with their lines', () => {
    const text = 'a https://github.com/x/y\nb https://github.com/p/q\n';
    expect(githubLinks('multi.md', text).map((l) => `${l.line}:${l.owner}/${l.repo}`)).toEqual([
      '1:x/y',
      '2:p/q',
    ]);
  });

  it('carries no `owner/repo` pair twice in one run', () => {
    // Catches a stale lastIndex reuse, which would silently drop the first link.
    expect(githubLinks('m.md', `https://github.com/${CANONICAL_ID}`).length).toBe(1);
    expect(githubLinks('m.md', `https://github.com/${CANONICAL_ID}`).length).toBe(1);
  });

  it('does not contain the stale location it exists to forbid', () => {
    // Rule 1 would be worthless if this file satisfied it only by escaping itself.
    expect(githubLinks('SELF', SELF).some((link) => link.owner === INVENTED_ORG)).toBe(false);
    expect(SELF).not.toContain(INVENTED_ID);
  });
});

describe('tracked tree', () => {
  it('holds far more linked files than the roots npm ships', () => {
    const files = trackedText();
    expect(files.size).toBeGreaterThan(100);
    const underTests = [...files.keys()].filter((name) => name.startsWith('tests/'));
    expect(underTests.length).toBeGreaterThan(20);
  });

  it('advertises the invented organisation at no address at all', () => {
    const findings: LinkFinding[] = [];
    for (const [file, text] of trackedText()) {
      for (const link of githubLinks(file, text)) {
        if (link.owner === INVENTED_ORG) findings.push(link);
      }
    }
    expect(
      findings,
      `tracked files still advertise a repository nobody owns: ${findings
        .map((f) => `${f.file}:${f.line} github.com/${f.owner}/${f.repo}`)
        .join(', ')}`,
    ).toEqual([]);
  });

  it('names the stale owner/repo pair in no tracked file, linked or not', () => {
    // Wider than the case above: the dead pair also appears in prose with no scheme
    // in front of it, which is still an address a reader will try.
    const stalePair = new RegExp(INVENTED_ORG + '/' + CANONICAL_REPO, 'g');
    const offenders: string[] = [];
    for (const [file, text] of trackedText()) {
      const pattern = new RegExp(stalePair.source, stalePair.flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        offenders.push(`${file}:${lineOf(text, match.index)}`);
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      }
    }
    expect(
      offenders,
      `stale repository address still written into tracked files: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

describe('package manifest', () => {
  it('points homepage, repository.url and bugs.url at the canonical repository', () => {
    const fields = readManifest();
    const homepage = fields.homepage ?? '';
    const repository = fields.repository?.url ?? '';
    const bugs = fields.bugs?.url ?? '';
    expect(homepage, 'package.json has no homepage to hold to a promise').not.toBe('');
    expect(repository, 'package.json has no repository.url').not.toBe('');
    expect(bugs, 'package.json has no bugs.url').not.toBe('');
    expect(identityOf(homepage)).toBe(CANONICAL_ID);
    expect(identityOf(repository)).toBe(CANONICAL_ID);
    expect(identityOf(bugs)).toBe(CANONICAL_ID);
  });

  it('keeps the npm forms of each link intact', () => {
    const fields = readManifest();
    expect(fields.homepage).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/#]+(#readme)?$/);
    expect(fields.repository?.type).toBe('git');
    expect(fields.repository?.url).toMatch(/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
    expect(fields.bugs?.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues$/);
  });

  it('agrees with the remote this checkout publishes to', () => {
    const remote = git(['remote', 'get-url', 'origin']);
    if (!remote.ok) return;
    const url = remote.out.trim();
    if (!url.includes('github.com')) return;
    expect(identityOf(url)).toBe(CANONICAL_ID);
  });
});

describe('shipped surface', () => {
  it('ships a README that tells a reader where the source is', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const canonical = githubLinks('README.md', readme).filter(
      (link) => `${link.owner}/${link.repo}` === CANONICAL_ID,
    );
    expect(
      canonical.length,
      'README.md names no link to the repository it describes, so a reader on the package page has no source to follow',
    ).toBeGreaterThan(0);
  });

  it('carries no address for a mergesutra-named repository except the canonical one', () => {
    const offenders: string[] = [];
    for (const [file, text] of shippedSurface()) {
      for (const link of githubLinks(file, text)) {
        if (link.repo === CANONICAL_REPO && link.owner !== CANONICAL_OWNER) {
          offenders.push(`${file}:${link.line} github.com/${link.owner}/${link.repo}`);
        }
      }
    }
    expect(
      offenders,
      `shipped files point at a same-named repository under a different owner: ${offenders.join(
        ', ',
      )}`,
    ).toEqual([]);
  });

  it('reads the release wiring this gate lives behind', () => {
    const script = readManifest().scripts?.['verify:package'] ?? '';
    expect(script).toContain('public-link-boundary.test.ts');
  });
});
