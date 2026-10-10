import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Cross-platform opt-in live test launcher.
 * Tests are never started during ordinary CI or `npm test`; this command
 * deliberately enables only the three credential-gated BharatCode suites.
 * `--help` is safe to smoke-test without an API key or model request.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const child = spawnSync(process.execPath, [vitestCli, 'run', '--all', ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, MERGESUTRA_LIVE_BHARATCODE: '1' },
  stdio: 'inherit',
  shell: false,
});

if (child.error) {
  process.stderr.write(`Unable to launch live tests: ${child.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = child.status ?? (child.signal === 'SIGINT' ? 130 : 1);
}
