import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The specialised Docker proof is the only hosted reading that says anything about the sandbox
 * boundary, and it starts only when a changed file is named in its `paths:` filter. This guard
 * derives that filter from what the two proof scripts actually load, so a new security helper —
 * or a new file a proof imports — cannot be committed without the proof that would exercise it.
 *
 * The rule is deliberately narrow: every module a proof loads *directly* must trigger the proof.
 * Transitive product reach is the ordinary CI matrix's job, and claiming more here would make the
 * filter unmaintainable and this test a rubber stamp.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = '.github/workflows/sandbox-runtime.yml';
const PROOFS = ['scripts/sandbox-runtime-proof.mjs', 'scripts/sandbox-stage-proof.mjs'];

/**
 * One hop from a proof's import specifier to the source file a pull request can change. A `dist/`
 * specifier names the compiled form of a `src/` file, so the filter has to name the source; the
 * mapping is only honest if the file it points at exists, which is checked rather than assumed.
 */
function sourceFor(specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return undefined;
  if (specifier.startsWith('../dist/')) {
    return `src/${specifier.slice('../dist/'.length).replace(/\.js$/, '.ts')}`;
  }
  if (specifier.startsWith('../tests/')) return specifier.slice('../'.length);
  if (specifier.startsWith('./')) return `scripts/${specifier.slice('./'.length)}`;
  throw new Error(`proof import ${specifier} is not a shape this policy knows how to map`);
}

function directSourcesOf(proof: string): string[] {
  const text = readFileSync(path.join(ROOT, proof), 'utf8');
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  const mapped: string[] = [];
  for (const specifier of specifiers) {
    const source = sourceFor(specifier);
    if (!source) continue;
    if (!existsSync(path.join(ROOT, source))) {
      throw new Error(`${proof} imports ${specifier}, which maps to ${source} — no such file`);
    }
    mapped.push(source);
  }
  return mapped.sort();
}

/**
 * Reads the two `paths:` blocks by indentation. A YAML parser is not a dependency here, so the
 * shapes this understands are pinned by the mutations recorded next to each expectation: an entry
 * that stops being a quoted list item is not silently dropped, it fails the test.
 */
function pathFilters(): Record<string, string[]> {
  const lines = readFileSync(path.join(ROOT, WORKFLOW), 'utf8').split(/\r?\n/);
  const filters = new Map<string, string[]>();
  let trigger: string | undefined;
  let collecting = false;
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const triggerMatch = /^ {2}([a-z_]+):\s*(.*)$/.exec(line);
    if (triggerMatch?.[1] !== undefined) {
      trigger = triggerMatch[1];
      collecting = false;
      continue;
    }
    if (/^ {4}paths:\s*$/.test(line)) {
      collecting = true;
      if (trigger !== undefined) filters.set(trigger, []);
      continue;
    }
    const entry = /^ {6}- '([^']+)'$/.exec(line);
    const bucket = collecting && trigger !== undefined ? filters.get(trigger) : undefined;
    if (bucket !== undefined && entry?.[1] !== undefined) bucket.push(entry[1]);
    else if (collecting && /^ {4}\S/.test(line)) collecting = false;
  }
  return Object.fromEntries(filters);
}

function matrixImages(): string[] {
  const lines = readFileSync(path.join(ROOT, WORKFLOW), 'utf8').split(/\r?\n/);
  const block = lines.findIndex((line) => /^\s+image:\s*$/.test(line));
  if (block < 0) return [];
  const images: string[] = [];
  for (const line of lines.slice(block + 1)) {
    const image = /^\s+- (\S+)\s*$/.exec(line)?.[1];
    if (image === undefined) break;
    images.push(image);
  }
  return images;
}

describe('the Docker proof starts when a file it loads changes', () => {
  const filters = pathFilters();
  const required = [
    ...new Set([...PROOFS, ...PROOFS.flatMap((proof) => directSourcesOf(proof))]),
  ].sort();

  it('names every file each proof imports, in the pull_request filter', () => {
    const listed = new Set(filters['pull_request'] ?? []);
    expect(required.filter((file) => !listed.has(file))).toEqual([]);
  });

  it('names the same files in the push filter, so main is covered like a PR', () => {
    expect([...(filters['push'] ?? [])].sort()).toEqual(
      [...(filters['pull_request'] ?? [])].sort(),
    );
  });

  it('keeps the trigger lists free of files nothing at those paths is responsible for', () => {
    for (const file of filters['pull_request'] ?? []) {
      expect(existsSync(path.join(ROOT, file))).toBe(true);
    }
  });

  it('still runs on a deliberate dispatch', () => {
    const text = readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
    expect(text).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it('qualifies exactly the digest-pinned images it claims to', () => {
    const images = matrixImages();
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image).toMatch(/^node@sha256:[0-9a-f]{64}$/);
    }
  });
});
