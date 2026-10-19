#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { CUSTOMER_SCENARIOS, customerGateFailures } from './lib/customer-gate-summary.mjs';

/**
 * The hosted release gate for the customer workflow.
 *
 * The Stage 17 harness already judges each scenario, so this command is not a
 * second opinion on the product — it is the check on the *record*. It answers one
 * question in GitHub Actions' vocabulary: does this `summary.json` prove that the
 * eight documented customer journeys ran, against this commit, in this container
 * image, during this run, with the independent oracle and the customer's checkout
 * intact? A green job that could not answer that is a gate that is not gating.
 *
 * Every value it needs is passed in from the surrounding job rather than inferred.
 * A missing one is a failure, not a skipped rule: a workflow that forgot to set
 * `MERGESUTRA_GATE_REVISION` would otherwise certify any summary lying around.
 */

const ENV = {
  summary: 'MERGESUTRA_GATE_SUMMARY',
  revision: 'MERGESUTRA_GATE_REVISION',
  sandboxImage: 'MERGESUTRA_GATE_SANDBOX_IMAGE',
  notBefore: 'MERGESUTRA_GATE_NOT_BEFORE',
  now: 'MERGESUTRA_GATE_NOW',
};

function given(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

const failures = [];
const problems = [];
let summary = null;

const summaryPath = given(ENV.summary);
if (summaryPath === '') {
  failures.push(`the gate was not given ${ENV.summary}, so no customer evidence was named`);
} else {
  let text;
  try {
    text = await readFile(summaryPath, 'utf8');
  } catch (error) {
    failures.push(
      `the summary named by ${ENV.summary} (${summaryPath}) could not be read: ${String(
        error instanceof Error ? (error.code ?? error.message) : error,
      )}`,
    );
  }
  if (text !== undefined) {
    try {
      summary = JSON.parse(text);
    } catch (error) {
      failures.push(
        `the summary at ${summaryPath} could not be parsed as JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

const expected = {
  revision: given(ENV.revision),
  sandboxImage: given(ENV.sandboxImage),
  notBefore: given(ENV.notBefore),
  now: given(ENV.now),
};
for (const [name, what] of [
  [ENV.revision, 'the commit this job checked out'],
  [ENV.sandboxImage, 'the sandbox image this job preloaded'],
  [ENV.notBefore, 'the moment this run began'],
  [ENV.now, 'the moment the gate is reading'],
]) {
  if (given(name) === '') {
    failures.push(`the gate was not given ${name}, so it cannot bind the evidence to ${what}`);
  }
}

if (failures.length === 0) problems.push(...customerGateFailures(summary, expected));

const all = [...failures, ...problems];
const certified = new Set(
  Array.isArray(summary?.scenarios)
    ? summary.scenarios
        .map((row) => (row && typeof row === 'object' ? String(row.scenario ?? '') : ''))
        .filter((name) => CUSTOMER_SCENARIOS.includes(name))
    : [],
);

if (all.length === 0) {
  process.stdout.write(`CUSTOMER_GATE_PASS scenarios=${String(certified.size)}\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(`CUSTOMER_GATE_FAIL ${String(all.length)} problem(s)\n`);
  for (const problem of all) process.stdout.write(`  - ${problem}\n`);
  process.exitCode = 1;
}
