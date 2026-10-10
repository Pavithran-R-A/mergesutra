import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { missingExistingAssertions } from '../../src/implement/assertion-preservation.js';
import {
  cleanUp,
  digestOf,
  finishAction,
  runLoop,
  writeAction,
  WORKSPACE_FILES,
} from '../helpers/implement.js';

describe('model test rewrites preserve baseline assertions', () => {
  const baseline = [
    "assert.equal(slugify('Hello World'), 'hello-world');",
    "assert.equal(slugify('a--b'), 'a-b');",
    "assert.equal(slugify('a.b,c'), 'a-b-c');",
  ].join('\n');

  it('detects the precise regression in the October live run', () => {
    const output = [
      "assert.equal(slugify('  Hello  World  '), 'hello-world');",
      "assert.equal(slugify('a--b'), 'a-b');",
      "assert.equal(slugify('--x--'), 'x');",
    ].join('\n');
    expect(missingExistingAssertions(baseline, output)).toBe(2);
    expect(missingExistingAssertions(baseline, baseline + '\n' + output)).toBe(0);
  });

  it('does not credit an assertion that exists only inside a comment or a string', () => {
    const old = "assert.equal(slugify('a.b,c'), 'a-b-c');";
    const fake = '/* ' + old + ' */\nconst fake = ' + JSON.stringify(old) + ';';
    expect(missingExistingAssertions(old, fake)).toBe(1);
    expect(missingExistingAssertions(fake, '')).toBe(0);
  });

  it('keeps exact string inputs distinct, including internal whitespace', () => {
    expect(
      missingExistingAssertions(
        "assert.equal(slugify('Hello World'), 'hello-world');",
        "assert.equal(slugify('Hello  World'), 'hello-world');",
      ),
    ).toBe(1);
  });

  it('keeps matchers and repeated assertions, but ignores formatting differences', () => {
    expect(missingExistingAssertions('expect(x).toEqual(1);', 'expect(x).toBe(1);')).toBe(1);
    expect(
      missingExistingAssertions('assert.equal(x, 1);\nassert.equal(x, 1);', 'assert.equal(x, 1);'),
    ).toBe(1);
    expect(
      missingExistingAssertions(
        "assert.equal(slugify('a.b,c'), 'a-b-c');",
        "assert.equal( slugify('a.b,c') , 'a-b-c' );",
      ),
    ).toBe(0);
  });
});

describe('the live model write boundary', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await cleanUp(tempDirs);
    tempDirs.length = 0;
  });

  it('refuses deletion of an existing test assertion BEFORE touching the file', async () => {
    const baseline = WORKSPACE_FILES['test/parse.test.ts'];
    if (baseline === undefined) throw new Error('missing test fixture');
    const discarded = 'import { expect, it } from "vitest";\nit("new", () => expect(2).toBe(2));\n';
    const harness = await runLoop(tempDirs, [
      writeAction('test/parse.test.ts', discarded, [], digestOf(baseline)),
      finishAction(),
    ]);
    expect(harness.implementation.summary.writes).toBe(0);
    expect(harness.implementation.actions[0]?.outcome).toBe('REFUSED');
    expect(harness.implementation.actions[0]?.detail).toContain('PRESERVE_ASSERTIONS');
    expect(await readFile(path.join(harness.root, 'test/parse.test.ts'), 'utf8')).toBe(baseline);
  });

  it('explains the refusal and accepts a corrected write without extra privileges', async () => {
    const baseline = WORKSPACE_FILES['test/parse.test.ts'];
    if (baseline === undefined) throw new Error('missing test fixture');
    const discarded = 'import { expect, it } from "vitest";\nit("new", () => expect(2).toBe(2));\n';
    const corrected = baseline + '\nit("new", () => expect(2).toBe(2));\n';
    const harness = await runLoop(tempDirs, [
      writeAction('test/parse.test.ts', discarded, [], digestOf(baseline)),
      writeAction('test/parse.test.ts', corrected, [], digestOf(baseline)),
      finishAction(),
    ]);
    expect(harness.client.calls[1]?.messages.at(-1)?.content).toContain('PRESERVE_ASSERTIONS');
    expect(harness.implementation.summary.writes).toBe(1);
    expect(harness.implementation.actions.map((a) => a.outcome)).toEqual([
      'REFUSED',
      'APPLIED',
      'CLAIMED',
    ]);
    expect(await readFile(path.join(harness.root, 'test/parse.test.ts'), 'utf8')).toBe(corrected);
  });

  it('does not block ordinary source writes that are not test files', async () => {
    const baseline = WORKSPACE_FILES['src/parse.ts'];
    if (baseline === undefined) throw new Error('missing source fixture');
    const harness = await runLoop(tempDirs, [
      writeAction('src/parse.ts', 'export const updated = true;\n', [], digestOf(baseline)),
      finishAction(),
    ]);
    expect(harness.implementation.summary.writes).toBe(1);
  });
});
