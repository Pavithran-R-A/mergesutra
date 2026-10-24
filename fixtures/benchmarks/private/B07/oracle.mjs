import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const { loadSettings } = await import(pathToFileURL(path.join(root, 'src', 'settings.js')).href);

assert.deepEqual(loadSettings({ env: {}, file: {} }), {
  url: 'https://api.example.com',
  retries: 2,
  token: '',
});

const overridden = loadSettings({
  env: { BENCH_RETRIES: '5', BENCH_TOKEN: 'env-token' },
  file: { retries: 4, token: 'file-token' },
});
assert.equal(overridden.retries, 5, 'the environment overrides the file');
assert.equal(overridden.token, 'env-token', 'the environment token overrides the file token');
assert.equal(
  loadSettings({
    env: { BENCH_URL: 'https://env.example.com' },
    file: { url: 'https://file.example.com' },
  }).url,
  'https://env.example.com',
);
assert.equal(loadSettings({ env: { BENCH_RETRIES: '0' }, file: {} }).retries, 0);
assert.equal(loadSettings({ env: { BENCH_RETRIES: '10' }, file: {} }).retries, 10);
assert.equal(loadSettings({ env: {}, file: { retries: '3' } }).retries, 3);

const savedToken = process.env.BENCH_TOKEN;
const savedRetries = process.env.BENCH_RETRIES;
process.env.BENCH_TOKEN = 'ambient-secret';
process.env.BENCH_RETRIES = '9';
try {
  const isolated = loadSettings({ env: {} });
  assert.equal(isolated.token, '', 'a supplied env object is the only environment read');
  assert.equal(isolated.retries, 2, 'ambient retries are not read when env is supplied');
  const fromProcess = loadSettings();
  assert.equal(fromProcess.token, 'ambient-secret', 'without an env object process.env is read');
  assert.equal(fromProcess.retries, 9);
} finally {
  if (savedToken === undefined) delete process.env.BENCH_TOKEN;
  else process.env.BENCH_TOKEN = savedToken;
  if (savedRetries === undefined) delete process.env.BENCH_RETRIES;
  else process.env.BENCH_RETRIES = savedRetries;
}

for (const value of ['11', '-1', '2.5', 'abc']) {
  assert.throws(
    () => loadSettings({ env: { BENCH_RETRIES: value }, file: {} }),
    (error) =>
      error instanceof RangeError &&
      error.message === 'retries must be an integer between 0 and 10',
    `retries ${value} is refused`,
  );
}

assert.throws(
  () => loadSettings({ env: {}, file: { retries: 2.5 } }),
  (error) =>
    error instanceof RangeError && error.message === 'retries must be an integer between 0 and 10',
  'a fractional file retries value is refused',
);

for (const url of ['http://example.com', 'ftp://example.com', 'example.com']) {
  assert.throws(
    () => loadSettings({ env: {}, file: { url } }),
    (error) => error instanceof TypeError && error.message === 'url must be an https URL',
    `url ${url} is refused`,
  );
}

assert.throws(
  () => loadSettings({ env: { BENCH_URL: 'http://env.example.com' }, file: {} }),
  (error) => error instanceof TypeError && error.message === 'url must be an https URL',
  'an environment url is validated too',
);

let errorMessage = '';
try {
  loadSettings({ env: { BENCH_RETRIES: '11', BENCH_TOKEN: 'top-secret-token' }, file: {} });
} catch (error) {
  errorMessage = error.message;
}
assert.equal(errorMessage, 'retries must be an integer between 0 and 10');
assert.ok(
  !errorMessage.includes('top-secret-token'),
  'the token value never appears in an error message',
);

process.stdout.write('PASS B07 configuration precedence\n');
