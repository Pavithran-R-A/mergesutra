// Trusted acceptance oracle for the public Stage-14 fixture in this repository.
// This file is outside issue #8's writable scope. Its checks run inside the same
// pinned, network-disabled Docker boundary as other repository verification gates.
// The model's own edited test file is separately executed, but not trusted to
// establish behavior: these independent assertions do that.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slugify } from '../fixtures/stage14-e2e/src/slugify.js';

const checks = [
  ['  Hello  World  ', 'hello-world'],
  ['a--b', 'a-b'],
  ['--x--', 'x'],
];
for (const [input, expected] of checks) {
  assert.equal(slugify(input), expected, `slugify(${JSON.stringify(input)})`);
}

const file = readFileSync(new URL('../fixtures/stage14-e2e/check.mjs', import.meta.url), 'utf8');
for (const marker of ['Hello', 'a--b', '--x--']) {
  assert.ok(file.includes(marker), `model-edited test file omits case ${marker}`);
}
assert.match(file, /assert\.(?:equal|deepEqual|strictEqual)\s*\(/);

const packageFile = JSON.parse(
  readFileSync(new URL('../fixtures/stage14-e2e/package.json', import.meta.url), 'utf8'),
);
assert.ok(!Object.hasOwn(packageFile, 'dependencies'), 'no runtime dependencies allowed');
assert.ok(!Object.hasOwn(packageFile, 'devDependencies'), 'no dev dependencies allowed');

// This command is run by Stage 7, which records its exit code against the
// pinned patch. The independent driver also runs its own behavior oracle.
