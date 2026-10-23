#!/usr/bin/env node
/**
 * Benchmark oracle controls (offline).
 *
 * Each fixture is materialised three times and checked with two commands:
 *
 *   copy        baseline suite     independent oracle
 *   base        must pass          must fail
 *   reference   must pass          must pass
 *   wrong       must pass          must fail
 *
 * A pass here means the oracle can tell a complete fix from the base defect and
 * from a plausible incomplete fix. It says nothing about a model's ability to
 * produce the fix: the ten real benchmark rows stay OPEN until a real run records
 * its own evidence.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'benchmarks');
const PRIVATE = path.join(FIXTURES, 'private');
const REPOS = path.join(FIXTURES, 'repos');
const SPAWN_TIMEOUT_MS = 60_000;

function runNode(args, cwd) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
}

function tail(text) {
  return String(text ?? '')
    .trim()
    .slice(-400);
}

function describe(result) {
  const error = result.error ? ` (${result.error.code ?? result.error.message})` : '';
  return `exit ${String(result.status)}${error}`;
}

function overlay(caseDir, variant, target) {
  const caseData = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
  for (const relative of caseData[variant]) {
    const from = path.join(caseDir, variant, relative);
    const to = path.join(target, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function expectedZero(name, result) {
  return {
    name,
    ok: result.status === 0,
    detail:
      result.status === 0
        ? ''
        : `${name} must exit 0: ${describe(result)} ${tail(result.stderr) || tail(result.stdout)}`,
  };
}

function expectedNonZero(name, result) {
  return {
    name,
    ok: typeof result.status === 'number' && result.status !== 0,
    detail:
      typeof result.status === 'number' && result.status !== 0
        ? ''
        : `${name} must exit non-zero: ${describe(result)} ${tail(result.stderr) || tail(result.stdout)}`,
  };
}

function evaluate(id) {
  const caseDir = path.join(PRIVATE, id);
  const caseData = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
  if (caseData.id !== id) throw new Error(`${id}: case.json names ${caseData.id}`);

  const oracle = path.join(caseDir, 'oracle.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `mergesutra-bench-${id}-`));
  try {
    const base = path.join(scratch, 'base');
    fs.cpSync(path.join(REPOS, id), base, { recursive: true });

    const reference = path.join(scratch, 'reference');
    fs.cpSync(base, reference, { recursive: true });
    overlay(caseDir, 'reference', reference);

    const wrong = path.join(scratch, 'wrong');
    fs.cpSync(base, wrong, { recursive: true });
    overlay(caseDir, 'wrong', wrong);

    return {
      id,
      title: caseData.title,
      checks: [
        expectedZero('base baseline', runNode(caseData.baseline, base)),
        expectedNonZero('base oracle', runNode([oracle, base, base], base)),
        expectedZero('reference baseline', runNode(caseData.baseline, reference)),
        expectedZero('reference oracle', runNode([oracle, reference, base], reference)),
        expectedZero('wrong baseline', runNode(caseData.baseline, wrong)),
        expectedNonZero('wrong oracle', runNode([oracle, wrong, base], wrong)),
      ],
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const filter = process.argv[2];
const ids = fs
  .readdirSync(PRIVATE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^B\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .filter((id) => filter === undefined || id === filter);

if (ids.length === 0) {
  process.stderr.write(`no benchmark case matched ${String(filter)}\n`);
  process.exit(1);
}

process.stdout.write('Benchmark oracle controls (offline)\n');
process.stdout.write(
  `fixtures/benchmarks · node ${process.versions.node} · ${ids.length} case(s)\n\n`,
);

let passed = 0;
const details = [];
for (const id of ids) {
  let outcome;
  try {
    outcome = evaluate(id);
  } catch (error) {
    details.push(`${id} could not be evaluated: ${error instanceof Error ? error.message : error}`);
    outcome = { id, title: '(unreadable)', checks: [] };
  }
  const failures = outcome.checks.filter((check) => !check.ok);
  if (outcome.checks.length === 6 && failures.length === 0) passed += 1;
  process.stdout.write(`${outcome.id} ${outcome.title}\n`);
  for (const check of outcome.checks) {
    process.stdout.write(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}\n`);
  }
  for (const failure of failures) details.push(`${outcome.id} ${failure.detail}`);
  process.stdout.write('\n');
}

for (const detail of details) process.stdout.write(`FAILURE ${detail}\n`);
const summary =
  passed === ids.length
    ? `BENCHMARK ORACLE CONTROLS: ${passed}/${ids.length} PASS`
    : `BENCHMARK ORACLE CONTROLS: ${passed}/${ids.length} FAILED`;
process.stdout.write(`${summary}\n`);
process.exit(passed === ids.length ? 0 : 1);
