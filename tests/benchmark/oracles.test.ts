import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * B01–B10 are the ten classes in `docs/REAL_TASK_BENCHMARK.md`. This suite proves the
 * fixtures can discriminate; it does not run the benchmark. Each oracle is exercised
 * against the unmodified base (must reject), a complete fix (must accept) and a
 * plausible incomplete fix (must reject). No model is called, so every row in the
 * benchmark document remains OPEN.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'benchmarks');
const PRIVATE = path.join(FIXTURES, 'private');
const REPOS = path.join(FIXTURES, 'repos');
const RUNNER = path.join(ROOT, 'scripts', 'benchmark-oracles.mjs');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

const caseIds = readdirSync(PRIVATE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('the ten benchmark fixtures prepare a runnable, unrun benchmark', () => {
  it('covers exactly the ten planned classes', () => {
    expect(caseIds).toEqual(['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10']);
  });

  it('keeps every oracle, reference fix and control outside the model-visible repository', () => {
    const leaked: string[] = [];
    for (const id of caseIds) {
      for (const file of walk(path.join(REPOS, id))) {
        const relative = path.relative(path.join(REPOS, id), file).split(path.sep).join('/');
        const isOracle = relative.endsWith('oracle.mjs') || relative === 'case.json';
        const isControl = /(^|\/)(reference|wrong)\//.test(relative);
        if (isOracle || isControl) leaked.push(`${id}/${relative}`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it('proves every oracle rejects the base, accepts the complete fix and rejects an incomplete fix', () => {
    const result = spawnSync(process.execPath, [RUNNER], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, output.slice(-3000)).toBe(0);
    expect(output).toContain('BENCHMARK ORACLE CONTROLS: 10/10 PASS');
    for (const id of caseIds) expect(output).toContain(`${id} `);
  }, 180_000);
});
