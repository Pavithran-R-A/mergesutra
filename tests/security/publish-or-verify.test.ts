import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'publish-or-verify.mjs');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

const HOOK = `
const cp = require('node:child_process');
const fs = require('node:fs');
const scenario = process.env.STUB_SCENARIO;
const logPath = process.env.STUB_LOG;
let published = false;
let reads = 0;
function record(kind, args) {
  fs.appendFileSync(logPath, JSON.stringify({ kind, args }) + '\\n');
}
const realSpawn = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  if (command !== 'npm') return realSpawn(command, args, options);
  if (args[0] === 'publish') {
    record('publish', args);
    published = true;
    return { status: 0, stdout: '', stderr: '' };
  }
  record('view', args);
  const version = process.env.STUB_VERSION;
  const head = process.env.STUB_HEAD;
  const ok = (meta) => ({ status: 0, stdout: JSON.stringify(meta), stderr: '' });
  switch (scenario) {
    case 'read-error':
      return { status: 1, stdout: '', stderr: 'npm error code EAI_AGAIN\\nnpm error network request failed\\n' };
    case 'e404-token':
      return {
        status: 1,
        stdout: '',
        stderr: 'npm error code EAI_AGAIN\\nnpm error request to https://registry.npmjs.org/E404-pkg failed\\n',
      };
    case 'missing-githead':
      return ok({ version });
    case 'null-metadata':
      return { status: 0, stdout: 'null', stderr: '' };
    case 'matching':
      return ok({ version, gitHead: head });
    case 'mismatched':
      return ok({ version, gitHead: 'f'.repeat(40) });
    case 'wrong-version':
      return ok({ version: '999.999.999', gitHead: head });
    case 'non-json':
      return { status: 0, stdout: 'not json', stderr: '' };
    case 'absent-then-published':
      return published
        ? ok({ version, gitHead: head })
        : { status: 1, stdout: '', stderr: 'npm error code E404\\n' };
    case 'absent-then-unreadable-then-published':
      if (!published) return { status: 1, stdout: '', stderr: 'npm error code E404\\n' };
      reads += 1;
      return reads === 1
        ? { status: 1, stdout: '', stderr: 'npm error code EAI_AGAIN\\n' }
        : ok({ version, gitHead: head });
    case 'absent-then-unreadable':
      return published
        ? { status: 1, stdout: '', stderr: 'npm error code EAI_AGAIN\\n' }
        : { status: 1, stdout: '', stderr: 'npm error code E404\\n' };
    default:
      throw new Error('unknown scenario ' + scenario);
  }
};
require('node:module').syncBuiltinESMExports();
`;

let scratch = '';
let hookPath = '';

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'mergesutra-publish-or-verify-'));
  hookPath = path.join(scratch, 'npm-stub.cjs');
  writeFileSync(hookPath, HOOK, 'utf8');
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(scenario: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: { kind: string; args: string[] }[];
} {
  const logPath = path.join(scratch, `calls-${scenario}.jsonl`);
  writeFileSync(logPath, '', 'utf8');
  const result = spawnSync(process.execPath, ['--require', hookPath, SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 25_000,
    env: {
      ...process.env,
      // If the preload ever stops intercepting, npm must fail to connect rather
      // than read the real registry and republish this machine's credentials.
      npm_config_registry: 'http://127.0.0.1:9/',
      npm_config_cache: path.join(scratch, 'npm-cache'),
      STUB_SCENARIO: scenario,
      STUB_LOG: logPath,
      STUB_VERSION: PKG.version,
      STUB_HEAD: HEAD,
    },
  });
  const calls = readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; args: string[] });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls,
  };
}

describe('the publish-or-verify helper does not invent registry facts', () => {
  it('refuses to publish when the registry could not be read', () => {
    const result = run('read-error');
    expect(result.calls.filter((call) => call.kind === 'publish')).toEqual([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EAI_AGAIN');
    expect(result.stdout).not.toContain('Publishing');
  });

  it('does not call registry metadata without gitHead verified', () => {
    const result = run('missing-githead');
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('Registry verified');
    expect(result.stderr).toContain('names no gitHead');
  });

  it('refuses metadata whose gitHead names another commit', () => {
    const result = run('mismatched');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match release commit');
  });

  it('refuses metadata whose version is not the package version', () => {
    const result = run('wrong-version');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Registry version mismatch');
  });

  it('accepts the release commit when the registry names it', () => {
    const result = run('matching');
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.kind === 'publish')).toEqual([]);
    expect(result.stdout).toContain(`Registry verified: ${PKG.name}@${PKG.version} at ${HEAD}.`);
    expect(result.stdout).toContain('refusing to republish it');
  });

  it('publishes only a version the registry reports as absent (404), then verifies it', () => {
    const result = run('absent-then-published');
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.kind === 'publish')).toHaveLength(1);
    expect(result.stdout).toContain(`Publishing ${PKG.name}@${PKG.version}`);
    expect(result.stdout).toContain(`Registry verified: ${PKG.name}@${PKG.version} at ${HEAD}.`);
  });

  it('refuses a non-JSON registry answer without publishing', () => {
    const result = run('non-json');
    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.kind === 'publish')).toEqual([]);
    expect(result.stderr).toContain('non-JSON metadata');
  });

  it('does not read a null metadata body as version absence', () => {
    const result = run('null-metadata');
    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.kind === 'publish')).toEqual([]);
    expect(result.stderr).toContain('Registry version mismatch');
  });

  it('does not authorize a write from an incidental E404 token in a read error', () => {
    const result = run('e404-token');
    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.kind === 'publish')).toEqual([]);
    expect(result.stderr).toMatch(/could not read/i);
  });

  it('keeps retrying a registry it cannot read after a publish, then verifies', () => {
    const result = run('absent-then-unreadable-then-published');
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.kind === 'publish')).toHaveLength(1);
    expect(result.stdout).toContain(`Registry verified: ${PKG.name}@${PKG.version} at ${HEAD}.`);
  });

  it('says a version it published may be live when no verification read succeeds', () => {
    const result = run('absent-then-unreadable');
    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.kind === 'publish')).toHaveLength(1);
    expect(result.stdout).not.toContain('Registry verified');
    expect(result.stderr).toContain('was published');
    expect(result.stderr).toContain('may already be live');
    expect(result.stderr).toMatch(/re-run this helper/i);
  });
});
