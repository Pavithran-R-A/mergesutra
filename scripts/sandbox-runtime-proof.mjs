import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSandboxedRunner } from '../dist/security/sandbox.js';

// This intentionally uses a real Docker daemon, not a mocked Runner.
// The workflow preloads this *digest* independently; the product runner
// refuses missing images instead of pulling a mutable tag.
const IMAGE = 'node@sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8';
const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-real-sandbox-'));
const workspace = path.join(root, 'workspace');
const sibling = path.join(root, 'sibling');
const hostPrivate = path.join(root, 'host-only');
const sentinel = 'MERGESUTRA-HOST-ONLY-SENTINEL';
let connections = 0;
let server;

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(sibling, { recursive: true }),
    mkdir(hostPrivate, { recursive: true }),
  ]);
  await writeFile(path.join(hostPrivate, 'secret.txt'), sentinel);
  await writeFile(path.join(sibling, 'original.txt'), 'untouched');

  server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  const proof = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const out = { hostRead: false, siblingWrite: false, networkConnected: false, tokenInherited: false };",
    "try { fs.readFileSync(" + JSON.stringify(path.join(hostPrivate, 'secret.txt')) + "); out.hostRead = true; } catch {}",
    "try { fs.writeFileSync(" + JSON.stringify(path.join(sibling, 'escape.txt')) + ", 'escaped'); out.siblingWrite = true; } catch {}",
    "out.tokenInherited = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.BHARATCODE_API_KEY || process.env.NPM_TOKEN);",
    "fs.writeFileSync('/workspace/allowed.txt', 'sandbox-writable');",
    "const socket = net.connect({ host: '127.0.0.1', port: " + String(port) + " });",
    "const finish = () => { socket.destroy(); process.stdout.write(JSON.stringify(out)); };",
    "socket.once('connect', () => { out.networkConnected = true; finish(); });",
    "socket.once('error', finish);",
    "socket.setTimeout(2000, finish);",
  ].join('\n');
  await writeFile(path.join(workspace, 'probe.cjs'), proof);

  const run = createSandboxedRunner({
    workspace,
    image: IMAGE,
    dockerExecutable: '/usr/bin/docker',
    timeoutMs: 30_000,
    maxOutputBytes: 16_384,
  });
  const result = await run('node', ['probe.cjs']);
  assert.equal(result.code, 0, 'sandboxed fixture must execute successfully');
  const inside = JSON.parse(result.stdout.trim());
  assert.deepEqual(inside, {
    hostRead: false,
    siblingWrite: false,
    networkConnected: false,
    tokenInherited: false,
  });
  assert.equal(await readFile(path.join(workspace, 'allowed.txt'), 'utf8'), 'sandbox-writable');
  assert.equal(await readFile(path.join(hostPrivate, 'secret.txt'), 'utf8'), sentinel);
  assert.equal(await readFile(path.join(sibling, 'original.txt'), 'utf8'), 'untouched');
  assert.equal(existsSync(path.join(sibling, 'escape.txt')), false);
  assert.equal(connections, 0, 'host loopback listener must see no sandbox connection');
  console.log('SANDBOX_RUNTIME_PROOF: PASS (host private file, sibling write, host network, token env)');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
