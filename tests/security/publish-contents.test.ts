import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCliScript, requireNpmCli } from '../helpers/npmInvocation.js';

/**
 * S12-12 — what a package may contain, and whether it is the source it claims to be.
 *
 * Two properties, and the second is the one that turned out to be the defect.
 *
 * The first is the obvious one: `files` is an allowlist, so `src/`, `tests/`, `docs/`,
 * `.mergesutra/` and the operator's own scratch cannot ride into the artifact. That was
 * always a reading, and a reading is not a proof — so the inventory below is taken from npm
 * itself, which is the only thing that decides what a tarball holds. npm adds what it always
 * adds (`package.json`, a root README and a root LICENSE) and ignores project files by rule;
 * a root `.npmignore` does not override `files`, so nothing here asserts `.npmignore` is
 * absent. That would be an invariant about a file that cannot carry one.
 *
 * The second property is what the register did not name. `dist/` is build output, gitignored,
 * and nothing in the packaging path produced it or checked it: `npm pack` would pack whatever
 * bytes happened to be on disk. Measured on the baseline, a working tree whose `dist/` predated
 * two closed security items packed successfully, and a directory holding only `package.json`
 * packed successfully too — exit `0`, one file, `bin` pointing at a path that was not there.
 * So the artifact's security properties were not the source's, and no gate could say so.
 *
 * The fix is a lifecycle hook rather than a cleaner: `prepack` builds the current source and
 * then runs this file, and a refusal here makes `npm pack` exit non-zero without producing a
 * tarball. Nothing deletes a stale `dist/`; a stale `dist/` stops a package. Because this file
 * is what `prepack` runs, every inventory measurement here asks npm with lifecycle scripts
 * disabled, or the verifier would call the pack that calls the verifier.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SELF = readFileSync(fileURLToPath(import.meta.url), 'utf8');

interface CompilerOptions {
  readonly rootDir?: string;
  readonly outDir?: string;
  readonly declaration?: boolean;
  readonly declarationMap?: boolean;
  readonly sourceMap?: boolean;
}

interface ConfigFile {
  readonly compilerOptions: CompilerOptions;
}

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly files?: readonly string[];
  readonly bin?: readonly string[] | Record<string, string>;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly scripts?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
const buildConfig = JSON.parse(
  readFileSync(path.join(ROOT, 'tsconfig.build.json'), 'utf8'),
) as ConfigFile;
const baseConfig = JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')) as ConfigFile;

const DIST_NAME = buildConfig.compilerOptions.outDir ?? 'dist';
const SRC_DIR = path.join(ROOT, buildConfig.compilerOptions.rootDir ?? 'src');
const DIST_DIR = path.join(ROOT, DIST_NAME);

/** The roots this build intends to ship, and nothing else. */
const PACK_ALLOWLIST = ['dist', 'BharatCode.txt', 'README.md', 'LICENSE'];

/** Paths that exist for the people who build this tool, never for the people who install it. */
const REPOSITORY_ONLY = [
  'src',
  'tests',
  'docs',
  'coverage',
  'node_modules',
  '.mergesutra',
  '.qoder',
  '.github',
  'cd',
];

const BUILD_PRESENT = existsSync(DIST_DIR);

/** npm's own CLI, driven through this Node binary: an argv array, no shell, no registry. */
const NPM_CLI = npmCliScript();
const NPM_PRESENT = NPM_CLI !== null;

/** Regular files under a directory, posix-relative to it. A symlink is not build output. */
function walk(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function regularFiles(dir: string): string[] {
  return walk(dir, dir);
}

function nonRegularEntries(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...nonRegularEntries(full));
    else if (!entry.isFile()) found.push(path.relative(dir, full).split(path.sep).join('/'));
  }
  return found;
}

/**
 * What `tsc` emits for one module, read from the committed config rather than remembered.
 *
 * A build that stops emitting declarations, or starts inlining sources, changes this list and
 * the assertions change with it — which is why no total is hardcoded anywhere in this file.
 */
function emittedExtensions(): string[] {
  const options: CompilerOptions = {
    ...baseConfig.compilerOptions,
    ...buildConfig.compilerOptions,
  };
  const extensions = ['.js'];
  if (options.sourceMap) extensions.push('.js.map');
  if (options.declaration) extensions.push('.d.ts');
  if (options.declaration && options.declarationMap) extensions.push('.d.ts.map');
  return extensions;
}

/** Source modules, relative and posix, without their `.ts` suffix. */
function sourceModules(): string[] {
  return regularFiles(SRC_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.slice(0, -'.ts'.length));
}

/** Every path the manifest names as a way into the package. */
function entryPoints(): string[] {
  const found: string[] = [];
  const leaves = (node: unknown): void => {
    if (typeof node === 'string') found.push(node);
    else if (Array.isArray(node)) node.forEach(leaves);
    else if (node && typeof node === 'object') Object.values(node).forEach(leaves);
  };
  if (typeof manifest.bin === 'string') found.push(manifest.bin);
  else if (manifest.bin) Object.values(manifest.bin).forEach((value) => found.push(value));
  if (manifest.main) found.push(manifest.main);
  if (manifest.types) found.push(manifest.types);
  leaves(manifest.exports);
  return found.map((target) => target.replace(/^\.\//, '').split(path.sep).join('/'));
}

/**
 * The steps `npm run prepack` would execute, in execution order.
 *
 * `&&` is the sequencing npm itself obeys, so a step list read this way says when the build
 * happens rather than merely that a build is mentioned somewhere.
 */
function packagingSteps(scriptName: string, entered = new Set<string>()): string[] {
  const body = manifest.scripts?.[scriptName];
  if (body === undefined || entered.has(scriptName)) return [];
  entered.add(scriptName);
  const steps: string[] = [];
  for (const part of body.split(/&&|;/)) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const nested = /^npm run ([\w:.-]+)$/.exec(trimmed);
    steps.push(nested ? `npm run ${nested[1]}` : trimmed);
    if (nested?.[1]) steps.push(...packagingSteps(nested[1], entered));
  }
  return steps;
}

interface PackEntry {
  readonly path: string;
  readonly size: number;
}

interface PackReport {
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly entryCount: number;
  readonly files: readonly PackEntry[];
}

let measured: PackReport | undefined;

/** npm's own answer to "what would this package contain", with lifecycle scripts disabled. */
function inventory(): PackReport {
  if (measured) return measured;
  const argv = [requireNpmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'];
  const result = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(
    result.status,
    `npm pack --dry-run exited ${String(result.status)}: ${String(result.stderr).slice(0, 400)}`,
  ).toBe(0);
  const start = result.stdout.indexOf('[');
  const end = result.stdout.lastIndexOf(']');
  expect(
    start,
    `npm answered with no JSON inventory: ${result.stdout.slice(0, 200)}`,
  ).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const parsed = JSON.parse(result.stdout.slice(start, end + 1)) as readonly PackReport[];
  expect(parsed.length).toBe(1);
  measured = parsed[0] as PackReport;
  return measured;
}

/** Text of everything that would ship, keyed by its package-relative path. */
function shippedText(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const file of regularFiles(DIST_DIR)) {
    map.set(`${DIST_NAME}/${file}`, readFileSync(path.join(DIST_DIR, file), 'utf8'));
  }
  for (const rootFile of ['BharatCode.txt', 'README.md', 'LICENSE', 'package.json']) {
    const full = path.join(ROOT, rootFile);
    if (existsSync(full)) map.set(rootFile, readFileSync(full, 'utf8'));
  }
  return map;
}

const LOCAL_PATH_NEEDLES = [ROOT, ROOT.split(path.sep).join('/'), os.homedir()]
  .filter((value) => value.length > 0)
  .map((value) => value.toLowerCase());

describe('the package surface is an allowlist this build intends (S12-12)', () => {
  it('ships exactly the entries meant to ship', () => {
    expect(manifest.files).toEqual(PACK_ALLOWLIST);
  });

  it('names no repository-only directory among them', () => {
    const intruders = (manifest.files ?? []).filter((entry) =>
      REPOSITORY_ONLY.includes(entry.split('/')[0] ?? entry),
    );
    expect(intruders).toEqual([]);
  });

  it('lists only allowlist entries that exist as a file or a directory', () => {
    const missing = (manifest.files ?? [])
      .filter((entry) => entry !== DIST_NAME)
      .filter((entry) => !existsSync(path.join(ROOT, entry)));
    expect(missing).toEqual([]);
  });
});

describe('every entry point the manifest promises is reachable (S12-12)', () => {
  it('routes every declared entry point through the build output', () => {
    const outside = entryPoints().filter((target) => !target.startsWith(`${DIST_NAME}/`));
    expect(outside).toEqual([]);
  });

  it('exists for every declared entry point once the source has been built', () => {
    expect(BUILD_PRESENT, 'no build output: prepack builds before npm packs').toBe(true);
    const absent = entryPoints().filter((target) => !existsSync(path.join(ROOT, target)));
    expect(absent).toEqual([]);
  });
});

describe('the packaging lifecycle binds the artifact to the source (S12-12)', () => {
  const steps = packagingSteps('prepack');

  it('runs a prepack hook, so no pack or publish can reach npm without it', () => {
    expect(
      manifest.scripts?.prepack,
      'package.json has no prepack: npm packs whatever is on disk',
    ).toBeTruthy();
  });

  it('compiles the current source before it verifies the package contents', () => {
    const build = steps.findIndex((step) => /\btsc\b.*tsconfig\.build\.json/.test(step));
    const verify = steps.findIndex((step) => /publish-contents\.test\.ts/.test(step));
    expect(build, `the packaging path never compiles: ${steps.join(' | ')}`).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      verify,
      `the packaging path never verifies: ${steps.join(' | ')}`,
    ).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(build);
  });

  it('refuses rather than erases: no destructive cleanup in any script this package has', () => {
    const destructive =
      /rm\s+-rf|rimraf|git\s+clean|git\s+reset\s+--hard|rsync\s+--delete|xargs\s+rm/;
    const offenders = Object.entries(manifest.scripts ?? {})
      .filter(([, body]) => destructive.test(body))
      .map(([name]) => name);
    expect(offenders, 'a stale build must stop a package, not be deleted by it').toEqual([]);
  });

  it('asks npm for its inventory with lifecycle scripts disabled, so prepack cannot recur', () => {
    const body = /function inventory\(\): PackReport \{[\s\S]*?\n\}/.exec(SELF)?.[0] ?? '';
    expect(body, 'this file no longer defines the npm inventory measurement').toContain("'pack'");
    expect(body, 'a lifecycle-enabled pack would run prepack inside the verifier').toContain(
      '--ignore-scripts',
    );
    expect(body, 'a real pack would write a tarball into the checkout').toContain('--dry-run');
    const calls = SELF.split('\n').filter((line) => /\bspawnSync\(/.test(line));
    expect(calls, 'a second npm invocation must carry the same two flags').toHaveLength(1);
  });

  it('pins the gate order, with the build ahead of the suites that read it', () => {
    // Build before test is not a preference. Three release-boundary suites hash the
    // bytes under `dist/`, so a `check` that builds last proves only that some
    // build output happened to be on disk — which is how this checkout passed its
    // own gate on a developer's machine and failed on a runner's clean one.
    expect(manifest.scripts?.check).toBe(
      'npm run format:check && npm run lint && npm run typecheck && npm run build && npm run test',
    );
    expect(manifest.scripts?.prepublishOnly).toBe('npm run check');
  });
});

describe.skipIf(!BUILD_PRESENT || !NPM_PRESENT)(
  'the measured npm inventory carries nothing repository-only (S12-12)',
  () => {
    it('reports a package whose entry count matches its file list', () => {
      const report = inventory();
      expect(report.files.length).toBe(report.entryCount);
      expect(report.files.length).toBeGreaterThan(0);
    });

    it('carries the runtime entry point the manifest names', () => {
      expect(inventory().files.map((file) => file.path)).toContain(`${DIST_NAME}/index.js`);
    });

    it('carries every declared entry point', () => {
      const present = new Set(inventory().files.map((file) => file.path));
      const missing = entryPoints().filter((target) => !present.has(target));
      expect(missing).toEqual([]);
    });

    it('leaves no repository-only root inside the package', () => {
      const intruders = inventory()
        .files.map((file) => file.path)
        .filter((file) => REPOSITORY_ONLY.includes(file.split('/')[0] ?? file));
      expect(intruders).toEqual([]);
    });

    it('leaves no environment file, lockfile, log or scratch tarball inside the package', () => {
      const forbidden =
        /(^|\/)\.env(\.|$)|lock\.(json|yaml)$|\.log$|\.tgz$|(^|\/)\.npmrc$|(^|\/)id_rsa($|\/)|\.pem$/;
      const offenders = inventory()
        .files.map((file) => file.path)
        .filter((file) => forbidden.test(file));
      expect(offenders).toEqual([]);
    });

    it('has a top level that is the allowlist plus only what npm always adds', () => {
      const roots = [
        ...new Set(inventory().files.map((file) => file.path.split('/')[0] ?? file.path)),
      ];
      expect(roots.sort()).toEqual([
        'BharatCode.txt',
        'LICENSE',
        'README.md',
        DIST_NAME,
        'package.json',
      ]);
    });
  },
);

describe.skipIf(!BUILD_PRESENT)(
  'the build output is the current source and nothing else (S12-12)',
  () => {
    it('emits every artifact the config promises for every source module', () => {
      const extensions = emittedExtensions();
      const present = new Set(regularFiles(DIST_DIR));
      const missing = sourceModules().flatMap((module) =>
        extensions
          .map((extension) => `${module}${extension}`)
          .filter((expected) => !present.has(expected)),
      );
      expect(
        missing,
        'a compiled artifact this source requires is absent: the build is older than the tree',
      ).toEqual([]);
    });

    it('holds the number of artifacts derived from the source, not a remembered total', () => {
      const expected = sourceModules().length * emittedExtensions().length;
      expect(regularFiles(DIST_DIR).length).toBe(expected);
    });

    it('refuses output that belongs to no source module', () => {
      const modules = new Set(sourceModules());
      const knownExtensions = emittedExtensions();
      const orphans = regularFiles(DIST_DIR).filter((file) => {
        const extension = knownExtensions.find((candidate) => file.endsWith(candidate));
        if (extension === undefined) return true;
        return !modules.has(file.slice(0, -extension.length));
      });
      expect(orphans, 'build output for a module the source no longer has').toEqual([]);
    });

    it('holds only regular files and directories', () => {
      expect(nonRegularEntries(DIST_DIR)).toEqual([]);
    });
  },
);

describe.skipIf(!BUILD_PRESENT)(
  'what ships says nothing about the machine that built it (S12-12)',
  () => {
    it('has no packed text file carrying the absolute checkout or home path', () => {
      const offenders: string[] = [];
      for (const [file, text] of shippedText()) {
        const lowered = text.toLowerCase();
        if (LOCAL_PATH_NEEDLES.some((needle) => lowered.includes(needle))) offenders.push(file);
      }
      expect(offenders).toEqual([]);
    });

    it('ships source maps that embed no source text', () => {
      const withContent = [...shippedText().entries()]
        .filter(([file, text]) => file.endsWith('.map') && text.includes('"sourcesContent"'))
        .map(([file]) => file);
      expect(withContent, 'a map carrying sources carries the TypeScript source too').toEqual([]);
    });

    it('names only relative sources in every map', () => {
      const broken: string[] = [];
      const absolute = /^[A-Za-z]:[\\/]|^\//;
      for (const [file, text] of shippedText()) {
        if (!file.endsWith('.map')) continue;
        const map = JSON.parse(text) as {
          readonly sources?: readonly string[];
          readonly sourceRoot?: string;
        };
        if (absolute.test(map.sourceRoot ?? '')) broken.push(`${file} (sourceRoot)`);
        for (const source of map.sources ?? []) {
          if (absolute.test(source)) broken.push(`${file} (${source})`);
        }
      }
      expect(broken).toEqual([]);
    });

    it('maps every compiled file to a source file that exists in this checkout', () => {
      const unresolved: string[] = [];
      for (const [file, text] of shippedText()) {
        if (!file.endsWith('.js.map')) continue;
        const map = JSON.parse(text) as { readonly sources?: readonly string[] };
        const source = (map.sources ?? [])[0];
        if (source === undefined) {
          unresolved.push(`${file} names no source`);
          continue;
        }
        const from = path.join(ROOT, DIST_NAME, path.dirname(file.slice(`${DIST_NAME}/`.length)));
        const target = path.resolve(from, source);
        if (statSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
          unresolved.push(`${file} points at ${target}`);
        }
      }
      expect(unresolved).toEqual([]);
    });
  },
);
