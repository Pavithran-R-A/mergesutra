import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { summarizeAudit } from './lib/audit-summary.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  shell: process.platform === 'win32',
  timeout: 120_000,
  env: process.env,
});
if (result.error || (result.status !== 0 && result.status !== 1)) {
  throw new Error('The full npm audit did not complete successfully.');
}
let report;
try {
  report = JSON.parse(result.stdout ?? '');
} catch {
  throw new Error('The full npm audit returned invalid JSON.');
}
const counts = summarizeAudit(report);
if ((counts.total === 0) !== (result.status === 0)) {
  throw new Error('The full npm audit exit code disagrees with its report.');
}
process.stdout.write(`npm audit findings: ${JSON.stringify(counts)}\n`);
