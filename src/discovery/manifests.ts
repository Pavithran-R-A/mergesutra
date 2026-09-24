import type { RepoReader } from './repo-fs.js';

/**
 * What the repository's own manifest files say about how to build it.
 *
 * This is deliberately narrow: it answers "which runtime, which package
 * manager, which commands does this project define?" and nothing else. Each
 * fact keeps the file it came from attached, so a later stage can show a
 * reviewer `package.json:scripts.test` rather than "the tool decided this".
 *
 * A manifest is untrusted text. It is parsed as data and never executed, and an
 * unreadable or ambiguous value produces an explicit absence rather than a
 * guess.
 */

export interface SourceFact {
  readonly file: string;
  readonly detail: string;
}

export interface DeclaredScript {
  readonly name: string;
  /** The raw script text from the manifest. Never run by this module. */
  readonly command: string;
  readonly source: SourceFact;
}

export interface ManifestFacts {
  readonly ecosystem: 'node' | 'python' | 'rust' | 'go' | 'unknown';
  readonly ecosystemSources: readonly SourceFact[];
  readonly packageManager: { readonly name: string; readonly source: SourceFact } | null;
  readonly runtimeVersion: { readonly value: string; readonly source: SourceFact } | null;
  readonly scripts: readonly DeclaredScript[];
  readonly lockfiles: readonly string[];
  readonly unreadable: readonly { file: string; reason: string }[];
}

const MANIFEST_CANDIDATES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'] as const;

const LOCKFILE_HINTS: readonly { file: string; manager: string }[] = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'uv.lock', manager: 'uv' },
  { file: 'poetry.lock', manager: 'poetry' },
  { file: 'Cargo.lock', manager: 'cargo' },
  { file: 'go.sum', manager: 'go' },
];

/** Read the manifests that exist and report what each one declares. */
export async function detectManifests(reader: RepoReader): Promise<ManifestFacts> {
  const present = await reader.existsAny(MANIFEST_CANDIDATES);
  const lockfiles = await reader.existsAny(LOCKFILE_HINTS.map((l) => l.file));

  const sources: SourceFact[] = present.map((file) => ({
    file,
    detail: `${file} exists`,
  }));

  const unreadable: { file: string; reason: string }[] = [];
  let ecosystem: ManifestFacts['ecosystem'] = 'unknown';
  if (present.includes('package.json')) ecosystem = 'node';
  else if (present.includes('pyproject.toml')) ecosystem = 'python';
  else if (present.includes('Cargo.toml')) ecosystem = 'rust';
  else if (present.includes('go.mod')) ecosystem = 'go';

  let runtimeVersion: ManifestFacts['runtimeVersion'] = null;
  let scripts: DeclaredScript[] = [];

  // A lockfile names the toolchain for every ecosystem, so it is consulted
  // before the manifest-specific branches below.
  const packageManager = readPackageManager(lockfiles, present);

  if (present.includes('package.json')) {
    const file = await reader.readText('package.json');
    if (!file) {
      unreadable.push({ file: 'package.json', reason: 'listed but could not be read' });
    } else if (file.truncated) {
      // Half a manifest is not a manifest: reporting the fields that happened to
      // survive the cut would invent a project that nobody declared.
      unreadable.push({
        file: 'package.json',
        reason: `is ${file.bytesOnDisk} bytes, past the read limit, so it was not parsed`,
      });
    } else if (file.text.trim().startsWith('{')) {
      const parsed = safeJson(file.text);
      if (parsed) {
        scripts = readScripts(parsed, file.relativePath);
        runtimeVersion = readNodeVersion(parsed, file.relativePath);
      } else {
        unreadable.push({ file: 'package.json', reason: 'is not valid JSON' });
      }
    } else {
      unreadable.push({ file: 'package.json', reason: 'is not a JSON object' });
    }
  }

  if (!runtimeVersion) {
    const nvmrc = await reader.readText('.nvmrc', 256);
    if (nvmrc && !nvmrc.truncated) {
      const value = nvmrc.text.trim();
      if (/^[v\d][\w.-]*$/.test(value)) {
        runtimeVersion = { value, source: { file: nvmrc.relativePath, detail: '.nvmrc' } };
      }
    }
  }

  return {
    ecosystem,
    ecosystemSources: sources,
    packageManager,
    runtimeVersion,
    scripts,
    lockfiles,
    unreadable,
  };
}

function readScripts(parsed: Record<string, unknown>, file: string): DeclaredScript[] {
  const declared = parsed['scripts'];
  if (!isRecord(declared)) return [];
  const out: DeclaredScript[] = [];
  for (const [name, value] of Object.entries(declared)) {
    if (typeof value !== 'string') continue;
    out.push({
      name,
      command: value.slice(0, 500),
      source: { file, detail: `scripts.${name}` },
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function readNodeVersion(
  parsed: Record<string, unknown>,
  file: string,
): ManifestFacts['runtimeVersion'] {
  const engines = parsed['engines'];
  if (isRecord(engines) && typeof engines['node'] === 'string') {
    return { value: engines['node'], source: { file, detail: 'engines.node' } };
  }
  return null;
}

function readPackageManager(
  lockfiles: readonly string[],
  manifests: readonly string[],
): ManifestFacts['packageManager'] {
  const hinted = LOCKFILE_HINTS.find((l) => lockfiles.includes(l.file));
  if (hinted) return { name: hinted.manager, source: { file: hinted.file, detail: 'lockfile' } };
  if (manifests.includes('package.json')) {
    return { name: 'unknown', source: { file: 'package.json', detail: 'no lockfile found' } };
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
