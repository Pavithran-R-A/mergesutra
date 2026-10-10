// The live-qualification rules of the real-model validation, separated from the
// driver so a test can run them against planted workspaces instead of trusting a
// paid chain to exercise them. Nothing here reads a credential: the driver owns
// the environment, and this module only receives the runner and the files.
import path from 'node:path';
import process from 'node:process';

export const FIXTURE_ALLOWED_PATHS = Object.freeze([
  'fixtures/stage14-e2e/src/slugify.js',
  'fixtures/stage14-e2e/check.mjs',
  'fixtures/stage14-e2e/README.md',
]);

export const REQUIRED_SLUG_INPUTS = Object.freeze(['  Hello  World  ', 'a--b', '--x--']);

// Valid pre-existing fixture assertions must survive a model's edits. The 10 Oct
// paid run passed the new requirements but deleted the punctuation regression.
export const BASELINE_SLUG_INPUTS = Object.freeze(['Hello World', 'a--b', 'a.b,c']);

export const MAX_MODEL_COMPLETIONS = 12;

const FIXTURE_SUBDIR = path.join('fixtures', 'stage14-e2e');

export function changesOutsideAllowlist(changedPaths, allowedPaths = FIXTURE_ALLOWED_PATHS) {
  const permitted = new Set(allowedPaths);
  return changedPaths.filter((entry) => !permitted.has(entry));
}

export function isDependencyFree(fixturePkg) {
  return (
    Object.keys(fixturePkg.dependencies ?? {}).length === 0 &&
    Object.keys(fixturePkg.devDependencies ?? {}).length === 0
  );
}

const QUOTE_CHARS = new Set(["'", '"', '`']);

// Issue #8 criterion 4 asks for assertions in the check file, and the check file is
// authored by the model being qualified. A substring scan therefore credits a
// comment that quotes the requirement, or a value computed and then never asserted.
// So the source is tokenized first: comment text is dropped, string literals are
// kept whole (comment punctuation inside one cannot hide real code), and only the
// argument text of an `assert` call is allowed to credit an input.
function readQuoted(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function withoutComments(source) {
  let code = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (QUOTE_CHARS.has(char)) {
      const end = readQuoted(source, index);
      code += source.slice(index, end);
      index = end;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    code += char;
    index += 1;
  }
  return code;
}

function matchingParenthesis(code, open) {
  let depth = 0;
  let index = open;
  while (index < code.length) {
    const char = code[index];
    if (QUOTE_CHARS.has(char)) {
      index = readQuoted(code, index);
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

const ASSERTION_HEAD = /(?:^|[^.\w])assert(?!\w)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/g;

function assertionArgumentText(code) {
  const spans = [];
  for (const match of code.matchAll(ASSERTION_HEAD)) {
    const open = match.index + match[0].length - 1;
    const close = matchingParenthesis(code, open);
    if (close > open) spans.push(code.slice(open + 1, close));
  }
  return spans.join('\n');
}

export function missingAssertionInputs(checkSource, requiredInputs = REQUIRED_SLUG_INPUTS) {
  const asserted = assertionArgumentText(withoutComments(checkSource));
  return requiredInputs.filter(
    (input) =>
      !asserted.includes(`slugify('${input}')`) && !asserted.includes(`slugify("${input}")`),
  );
}

const DIRECT_BEHAVIOR_SCRIPT = [
  "import assert from 'node:assert/strict';",
  "import { slugify } from './fixtures/stage14-e2e/src/slugify.js';",
  "assert.equal(slugify('  Hello  World  '), 'hello-world');",
  "assert.equal(slugify('a--b'), 'a-b');",
  "assert.equal(slugify('--x--'), 'x');",
  "assert.equal(slugify('Hello World'), 'hello-world');",
  "assert.equal(slugify('a.b,c'), 'a-b-c');",
].join('\n');

export async function inspectFixtureAcceptance({ workspace, run, env, readFile, changedPaths }) {
  const checkSource = await readFile(path.join(workspace, FIXTURE_SUBDIR, 'check.mjs'), 'utf8');
  const fixturePkg = JSON.parse(
    await readFile(path.join(workspace, FIXTURE_SUBDIR, 'package.json'), 'utf8'),
  );
  const options = { cwd: workspace, env, timeoutMs: 15_000 };
  const independent = run(
    'fixture-independent-acceptance',
    process.execPath,
    ['--input-type=module', '-e', DIRECT_BEHAVIOR_SCRIPT],
    options,
  );
  const fixtureCheck = run(
    'fixture-check-file',
    process.execPath,
    [path.join(FIXTURE_SUBDIR, 'check.mjs')],
    options,
  );
  const missing = missingAssertionInputs(checkSource);
  const missingBaseline = missingAssertionInputs(checkSource, BASELINE_SLUG_INPUTS);
  return {
    directBehaviorsPass: independent.exitCode === 0,
    checkedScriptPass: fixtureCheck.exitCode === 0,
    // The boolean decides; the list is what an operator reads afterward to know
    // which of issue #8's inputs the check file lacked without re-running the scan.
    checkContainsAllThreeAssertions: missing.length === 0,
    missingAssertionInputs: missing,
    baselineAssertionsPreserved: missingBaseline.length === 0,
    missingBaselineAssertionInputs: missingBaseline,
    dependencyFree: isDependencyFree(fixturePkg),
    changesWithinFixture: changesOutsideAllowlist(changedPaths).length === 0,
    changedPaths,
  };
}

export function liveQualificationFailures({
  completionCount,
  elapsedMs,
  deadlineMs,
  verifyExit,
  implementation,
  fixtureProof,
  review,
  repairPlanPresent,
}) {
  const failures = [];
  if (completionCount > MAX_MODEL_COMPLETIONS) {
    failures.push('observed model requests exceeded the chain ceiling');
  }
  if (elapsedMs > deadlineMs) {
    failures.push('live chain exceeded the 25-minute wall-clock ceiling');
  }
  if (verifyExit !== 0) failures.push('deterministic verification did not pass');
  if (implementation?.status !== 'COMPLETED_BY_MODEL') {
    failures.push('the implementation loop did not finish the requested fixture task');
  }
  if (
    !fixtureProof?.directBehaviorsPass ||
    !fixtureProof?.checkedScriptPass ||
    !fixtureProof?.checkContainsAllThreeAssertions ||
    !fixtureProof?.baselineAssertionsPreserved ||
    !fixtureProof?.dependencyFree ||
    !fixtureProof?.changedPaths?.includes('fixtures/stage14-e2e/check.mjs') ||
    !fixtureProof?.changedPaths?.includes('fixtures/stage14-e2e/src/slugify.js')
  ) {
    failures.push('the independent fixture acceptance criteria were not all satisfied');
  }
  if (!review || review.findings.length > 0) {
    failures.push('the model review reported findings or could not be completed cleanly');
  }
  if (repairPlanPresent) {
    failures.push(
      'review produced a repair plan; human digest approval is required before any repair',
    );
  }
  return failures;
}
