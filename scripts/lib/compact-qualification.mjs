// A separate representative real-model fixture; the full-repository Stage-14
// adversarial qualification stays intact and retains all its required gates.
import path from 'node:path';
import process from 'node:process';
import {
  BASELINE_SLUG_INPUTS,
  changesOutsideAllowlist,
  isDependencyFree,
  missingAssertionInputs,
} from './live-qualification.mjs';

export const COMPACT_ALLOWED_PATHS = Object.freeze([
  'src/slugify.js',
  'test/slugify.test.js',
  'README.md',
]);

export async function inspectCompactAcceptance({ workspace, run, env, readFile, changedPaths }) {
  const testSource = await readFile(path.join(workspace, 'test', 'slugify.test.js'), 'utf8');
  const packageFile = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
  const options = { cwd: workspace, env, timeoutMs: 15_000 };
  const independent = run(
    'fixture-independent-acceptance',
    process.execPath,
    ['scripts/e2e-acceptance-check.mjs'],
    options,
  );
  const checked = run(
    'fixture-check-file',
    process.execPath,
    ['--test', 'test/slugify.test.js'],
    options,
  );
  const missing = missingAssertionInputs(testSource);
  const missingBaseline = missingAssertionInputs(testSource, BASELINE_SLUG_INPUTS);
  return {
    directBehaviorsPass: independent.exitCode === 0,
    checkedScriptPass: checked.exitCode === 0,
    checkContainsAllThreeAssertions: missing.length === 0,
    missingAssertionInputs: missing,
    baselineAssertionsPreserved: missingBaseline.length === 0,
    missingBaselineAssertionInputs: missingBaseline,
    dependencyFree: isDependencyFree(packageFile),
    changesWithinFixture: changesOutsideAllowlist(changedPaths, COMPACT_ALLOWED_PATHS).length === 0,
    changedPaths,
  };
}
