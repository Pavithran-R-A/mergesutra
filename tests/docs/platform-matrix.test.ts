import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The platform claim is derived from the gates that run, not remembered.
 *
 * `README.md` told a customer the hosted gate ran Windows and Linux and that
 * nothing was claimed about macOS. `ci.yml` had been running two macOS cells for
 * months. Both halves of that sentence were checkable and neither had been
 * checked, so the fix is a matrix in `docs/SANDBOX_EXECUTION.md` plus this guard:
 * the OS and Node lists come from CI, the digest list comes from the container
 * workflow, and a row that says "NOT MEASURED" cannot be edited into a
 * qualification without deleting the sentence this test reads.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const README = read('README.md');
const CI = read('.github/workflows/ci.yml');
const SANDBOX_WORKFLOW = read('.github/workflows/sandbox-runtime.yml');
const SANDBOX_DOC = read('docs/SANDBOX_EXECUTION.md');

const HOST_WORD: Readonly<Record<string, string>> = {
  'ubuntu-latest': 'Linux',
  'windows-latest': 'Windows',
  'macos-latest': 'macOS',
};

function matrixList(text: string, key: string): string[] {
  const match = new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`).exec(text);
  return (match?.[1] ?? '')
    .split(',')
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
    .filter((value) => value !== '');
}

const hosts = matrixList(CI, 'os');
const nodeVersions = matrixList(CI, 'node');

interface HostRow {
  readonly host: string;
  readonly cells: readonly string[];
}

function platformMatrix(): HostRow[] {
  const section =
    SANDBOX_DOC.split(/^## /m).find((part) => part.startsWith('Supported platform matrix')) ?? '';
  const rows = section.split('\n').filter((line) => line.startsWith('| '));
  return rows.slice(2).map((row) => {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    return { host: cells[0] ?? '', cells };
  });
}

describe('the documented platform matrix matches the gates that run', () => {
  it('reads the CI matrix the documents are speaking about', () => {
    expect(hosts).toEqual(['ubuntu-latest', 'windows-latest', 'macos-latest']);
    expect(nodeVersions).toEqual(['22.x', '24.x']);
  });

  it('tells a customer every OS and Node version the hosted gate actually runs', () => {
    const section =
      README.split(/^## /m).find((part) => part.startsWith('Supported repositories')) ?? '';
    expect(section, 'README has no Supported repositories section').not.toBe('');
    for (const host of hosts) {
      const word = HOST_WORD[host] ?? host;
      expect(section, `README omits ${word}, which the CI matrix runs`).toContain(word);
    }
    for (const version of nodeVersions) {
      const major = version.split('.')[0] ?? version;
      expect(section, `README omits Node ${major}, which the CI matrix runs`).toContain(
        `Node ${major}`,
      );
    }
    expect(section, 'README claims macOS is untested while CI runs two macOS cells').not.toContain(
      'Nothing is claimed about macOS',
    );
  });

  it('gives every hosted host a row, and qualifies only what a container proof covered', () => {
    const rows = platformMatrix();
    expect(rows.map((row) => row.host).sort()).toEqual(
      hosts.map((host) => HOST_WORD[host] ?? host).sort(),
    );
    const macos = rows.find((row) => row.host === 'macOS');
    expect(macos?.cells[2], 'macOS must name no measured Docker host').toBe('**none**');
    expect(macos?.cells.slice(3).every((cell) => cell.includes('NOT MEASURED'))).toBe(true);
    const windows = rows.find((row) => row.host === 'Windows');
    expect(
      windows?.cells[2],
      'the Windows container readings are local readings, not hosted ones',
    ).toContain('local only');
  });

  it('names every digest the hosted container workflow pins', () => {
    const digests = [...SANDBOX_WORKFLOW.matchAll(/node@sha256:([0-9a-f]{64})/g)].map(
      (match) => match[1] ?? '',
    );
    expect(new Set(digests).size, 'the sandbox workflow should pin distinct images').toBe(3);
    for (const digest of digests) {
      expect(SANDBOX_DOC, `the platform matrix omits sha256:${digest.slice(0, 12)}`).toContain(
        `sha256:${digest.slice(0, 12)}`,
      );
    }
  });

  it('keeps every hosted container leg on Linux, so a new OS cannot outgrow the matrix', () => {
    const legs = [...SANDBOX_WORKFLOW.matchAll(/runs-on:\s*(\S+)/g)].map((match) => match[1] ?? '');
    expect(legs.length, 'the sandbox workflow declares no job').toBeGreaterThan(0);
    expect(new Set(legs)).toEqual(new Set(['ubuntu-latest']));
  });
});
