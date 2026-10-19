/**
 * The customer's own acceptance oracle, kept outside the workspace a model can write.
 *
 * This is the second pair of eyes Stage 17 qualifies against. It is maintained
 * here, in MergeSutra's repository, from the text of the customer's issue — and it
 * is deliberately NOT inside the run worktree, because a patch that could edit the
 * thing that judges it would make every green result below worthless. Stage 9's
 * reviewer can also be wrong; the oracle is the part of this qualification that
 * cannot be talked into agreement by either the model or the product.
 *
 * Criteria are transcribed from `Pavithran-R-A/mergesutra-e2e-fixture#1` as written
 * by whoever filed it. Each one is decided by running or reading the workspace's
 * own bytes, never by reading MergeSutra's records.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const ORACLE_CRITERIA = [
  { id: 'ORACLE-AC-1', statement: "slugify('  Hello  World  ') returns exactly 'hello-world'" },
  { id: 'ORACLE-AC-2', statement: "slugify('a--b') still returns exactly 'a-b'" },
  { id: 'ORACLE-AC-3', statement: "slugify('--x--') returns exactly 'x'" },
  {
    id: 'ORACLE-AC-4',
    statement: '`npm test` exits 0, and the test file contains a test for each of criteria 1-3',
  },
  {
    id: 'ORACLE-AC-5',
    statement: 'package.json still declares no dependencies and no devDependencies',
  },
];

const REQUIRED_TEST_INPUTS = [
  { id: 'ORACLE-AC-1', literal: "'  Hello  World  '" },
  { id: 'ORACLE-AC-2', literal: "'a--b'" },
  { id: 'ORACLE-AC-3', literal: "'--x--'" },
];

export async function runCustomerOracle({ workspace, npmCache }) {
  const results = [];
  const record = (id, ok, detail) =>
    results.push({ id, verdict: ok ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 400) });

  const slugModule = path.join(workspace, 'src', 'slugify.js');
  let slugify;
  try {
    const imported = await import(pathToFileURL(slugModule).href);
    if (typeof imported.slugify !== 'function') throw new Error('no exported slugify function');
    slugify = imported.slugify;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const id of ['ORACLE-AC-1', 'ORACLE-AC-2', 'ORACLE-AC-3']) record(id, false, detail);
    results.push({ id: 'ORACLE-AC-4', verdict: 'FAIL', detail: 'module did not load' });
    results.push({ id: 'ORACLE-AC-5', verdict: 'FAIL', detail: 'module did not load' });
    return { results, passed: false };
  }

  const behaviour = [
    ['ORACLE-AC-1', '  Hello  World  ', 'hello-world'],
    ['ORACLE-AC-2', 'a--b', 'a-b'],
    ['ORACLE-AC-3', '--x--', 'x'],
  ];
  for (const [id, input, expected] of behaviour) {
    let actual;
    try {
      actual = slugify(input);
    } catch (error) {
      actual = `threw ${error instanceof Error ? error.message : String(error)}`;
    }
    record(
      id,
      actual === expected,
      `slugify(${JSON.stringify(input)}) = ${JSON.stringify(actual)}`,
    );
  }

  const testFile = await readFile(path.join(workspace, 'test', 'slugify.test.js'), 'utf8').catch(
    () => '',
  );
  const covered = REQUIRED_TEST_INPUTS.filter((entry) => hasAssertionFor(testFile, entry.literal));
  // `npm` on Windows is a batch file, which Node will not spawn without a shell.
  // The command is one fixed literal with no interpolated value, so the shell
  // adds no exposure here; the workspace path travels in `cwd`, not in the string.
  const checks = spawnSync('npm test', {
    cwd: workspace,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1', npm_config_cache: npmCache },
  });
  record(
    'ORACLE-AC-4',
    checks.status === 0 && covered.length === REQUIRED_TEST_INPUTS.length,
    `npm test exit=${String(checks.status)}; required inputs asserted for ${covered
      .map((entry) => entry.id)
      .join(', ')}`,
  );

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
  } catch (error) {
    manifest = null;
    record('ORACLE-AC-5', false, `package.json unreadable: ${String(error)}`);
  }
  if (manifest) {
    const declared = ['dependencies', 'devDependencies'].filter(
      (key) => manifest[key] && Object.keys(manifest[key]).length > 0,
    );
    record(
      'ORACLE-AC-5',
      declared.length === 0,
      declared.length === 0
        ? 'no dependencies or devDependencies declared'
        : `declared: ${declared.join(', ')}`,
    );
  }

  return { results, passed: results.every((entry) => entry.verdict === 'PASS') };
}

/**
 * A test block that both names this input and asserts on it.
 *
 * The issue asks for "a test for each of criteria 1-3", which cannot be satisfied
 * by a file that merely contains the string. So the unit here is one `test(...)`
 * call, and it has to mention the literal input and carry an assertion.
 */
function hasAssertionFor(source, literal) {
  const blocks = source.split(/\ntest\(/);
  for (const block of blocks) {
    if (!block.includes(literal)) continue;
    if (/assert\./.test(block)) return true;
  }
  return false;
}
