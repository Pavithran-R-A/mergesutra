import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createSandboxedRunner, dockerClientEnvironment } from '../dist/security/sandbox.js';
import {
  containerBoundaryViolations,
  escapeCanaryHits,
  escapeLandingViolations,
  sameHostPath,
  splitLanding,
} from './lib/container-boundary.mjs';

const names = async (dir) => (await readdir(dir)).sort();

// This intentionally uses a real Docker daemon, not a mocked Runner.
// The workflow preloads each *digest* independently; the product runner
// refuses missing images instead of pulling a mutable tag. The matrix leg names
// the image under proof, so one harness measures every qualified image; the
// default stays the repository's own pin so a bare `node scripts/…` run proves it.
const DEFAULT_IMAGE =
  'node@sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8';
const IMAGE = process.env.MERGESUTRA_RUNTIME_PROOF_IMAGE ?? DEFAULT_IMAGE;
const DOCKER = process.env.MERGESUTRA_RUNTIME_PROOF_DOCKER ?? '/usr/bin/docker';
process.stdout.write(`SANDBOX_RUNTIME_PROOF_IMAGE: ${IMAGE}\n`);
const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-real-sandbox-'));
const workspace = path.join(root, 'workspace');
const sibling = path.join(root, 'sibling');
const hostPrivate = path.join(root, 'host-only');
const clientConfig = await mkdtemp(path.join(tmpdir(), 'mergesutra-boundary-client-'));
const sentinel = 'MERGESUTRA-HOST-ONLY-SENTINEL';
// A credential the *host* carries while the container starts. The sandbox builds
// its own environment, so neither this value nor its name may reach the
// container; the daemon's own record is what decides that, not the guest's word.
const CANARY = `MERGESUTRA-CANARY-${randomUUID()}`;
const CANARY_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
  'NPM_TOKEN',
  'BHARATCODE_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
];
for (const name of CANARY_NAMES) process.env[name] = CANARY;
let connections = 0;
let server;
const runChild = promisify(execFile);

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

  const escapeCanary = `MERGESUTRA-ESCAPE-${randomUUID()}`;
  // The fixture reports what it can see from inside, then blocks until the host
  // has finished reading the daemon's record for its own container. Without the
  // handshake every outside claim would rest on the guest's self-report.
  const proof = `
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const out = {
  hostRead: false,
  hostPathWrite: false,
  systemWrite: false,
  rootWrite: false,
  networkConnected: false,
  tokenInherited: false,
  paused: false,
};
const ESCAPE = ${JSON.stringify(escapeCanary)};
function pause() {
  let failure = null;
  try {
    const { SharedMemory } = require('node:worker_threads');
    Atomics.wait(new Int32Array(new SharedMemory(4)), 0, 0, 250);
    return 'atomics';
  } catch (error) {
    failure = String((error && error.message) || error);
  }
  try {
    require('node:child_process').execFileSync('/bin/sleep', ['0.25']);
    return 'sleep';
  } catch (error) {
    failure = String((error && error.message) || error);
  }
  out.pauseError = failure;
  const stop = Date.now() + 250;
  while (Date.now() < stop) {
    /* no blocking primitive was available in this image */
  }
  return 'spin';
}
try { fs.readFileSync(${JSON.stringify(path.join(hostPrivate, 'secret.txt'))}); out.hostRead = true; } catch {}
try { fs.writeFileSync(${JSON.stringify(path.join(sibling, 'escape.txt'))}, ESCAPE); out.hostPathWrite = true; } catch {}
try { fs.writeFileSync('/etc/mergesutra-escape.txt', ESCAPE); out.systemWrite = true; } catch {}
try { fs.writeFileSync('/mergesutra-escape.txt', ESCAPE); out.rootWrite = true; } catch {}
out.tokenInherited = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.BHARATCODE_API_KEY || process.env.NPM_TOKEN);
fs.writeFileSync('/workspace/allowed.txt', 'sandbox-writable');
const socket = net.connect({ host: '127.0.0.1', port: ${port} });
const finish = () => {
  socket.destroy();
  fs.writeFileSync('/workspace/ready.json', JSON.stringify(out));
  const deadline = Date.now() + 75000;
  let mode = 'none';
  while (!fs.existsSync('/workspace/release')) {
    if (Date.now() > deadline) {
      fs.writeFileSync('/workspace/timeout.json', JSON.stringify(out));
      process.exit(7);
    }
    mode = pause();
  }
  out.pauseMode = mode;
  out.paused = true;
  process.stdout.write(JSON.stringify(out));
};
socket.once('connect', () => { out.networkConnected = true; finish(); });
socket.once('error', finish);
socket.setTimeout(2000, finish);
`;

  await writeFile(path.join(workspace, 'probe.cjs'), proof);

  // Prove that inherited Docker daemon/context settings cannot redirect execution.
  process.env.DOCKER_HOST = 'tcp://127.0.0.1:1';
  process.env.DOCKER_CONTEXT = 'mergesutra-deliberately-invalid';

  const run = createSandboxedRunner({
    workspace,
    image: IMAGE,
    dockerExecutable: DOCKER,
    timeoutMs: 150_000,
    maxOutputBytes: 16_384,
  });

  // The same scrubbed client environment the product runner uses, so this read
  // describes the daemon the product actually started the container on.
  const docker = async (args) => {
    const result = await runChild(DOCKER, args, {
      env: dockerClientEnvironment(clientConfig),
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  };
  const workspaceReal = realpathSync(workspace);
  const expectation = {
    image: IMAGE,
    imageDigest: IMAGE.split('@')[1],
    workspace: workspaceReal,
    sandboxRoot: '/workspace',
    file: 'node',
    args: ['probe.cjs'],
    memoryBytes: 536_870_912,
    pidsLimit: 64,
    nanoCpus: 1_000_000_000,
    canaryValues: [CANARY],
  };

  const running = run('node', ['probe.cjs']);
  let boundary = ['RECORD_UNREADABLE: the outside phase never completed'];
  let containerId = null;
  let inspected = 0;
  let handshakeError = null;
  try {
    const readyPath = path.join(workspace, 'ready.json');
    const started = Date.now();
    while (!existsSync(readyPath)) {
      if (Date.now() - started > 90_000)
        throw new Error('the sandboxed fixture never reported ready');
      await sleep(100);
    }
    // A shared host may carry other containers, and the daemon only names the
    // bind target, so select on the workspace the run itself owns.
    const listing = await docker([
      'ps',
      '--no-trunc',
      '--filter',
      `ancestor=${IMAGE}`,
      '--format',
      '{{.ID}}',
    ]);
    const ids = listing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const matches = [];
    for (const id of ids) {
      inspected += 1;
      for (const record of JSON.parse(await docker(['inspect', id]))) {
        const ownsWorkspace = (record.Mounts ?? []).some(
          (mount) =>
            mount.Destination === '/workspace' && sameHostPath(String(mount.Source), workspaceReal),
        );
        if (ownsWorkspace) matches.push(record);
      }
    }
    assert.equal(
      matches.length,
      1,
      `exactly one live container must carry this run's workspace mount; found ${matches.length} of ${ids.length}`,
    );
    const violations = containerBoundaryViolations(matches[0], expectation);
    containerId = String(matches[0].Id).slice(0, 12);
    const envNames = (matches[0].Config?.Env ?? []).map((entry) => entry.split('=')[0]).sort();
    process.stdout.write(
      [
        `SANDBOX_BOUNDARY_CONTAINER_ID: ${containerId}`,
        `SANDBOX_BOUNDARY_RECORDS: inspected=${inspected} matched=1`,
        `SANDBOX_BOUNDARY_ENV_NAMES: ${envNames.join(',')}`,
        `SANDBOX_BOUNDARY_VIOLATIONS: ${violations.length === 0 ? 'none' : violations.join(' | ')}`,
      ].join('\n') + '\n',
    );
    boundary = violations;
  } catch (error) {
    handshakeError = error;
  } finally {
    // Always release the fixture, including when the outside read itself failed.
    await writeFile(path.join(workspace, 'release'), 'release').catch(() => undefined);
  }
  const result = await running;
  if (handshakeError) throw handshakeError;
  assert.deepEqual(boundary, [], 'the daemon record must corroborate the sandbox boundary');
  assert.equal(result.code, 0, 'sandboxed fixture must execute successfully');
  const inside = JSON.parse(result.stdout.trim());
  // `pauseMode` names the blocking primitive the image offered and `hostPathWrite`
  // says only whether one call returned. Both are read apart from the boundary
  // report so the match below stays exact and free of self-comparison.
  const pauseMode = inside.pauseMode;
  const hostPathWrite = inside.hostPathWrite;
  delete inside.pauseMode;
  delete inside.hostPathWrite;
  assert.deepEqual(inside, {
    hostRead: false,
    systemWrite: false,
    rootWrite: false,
    networkConnected: false,
    tokenInherited: false,
    paused: true,
  });
  assert.match(String(pauseMode), /^(atomics|sleep|spin)$/);
  assert.equal(await readFile(path.join(workspace, 'allowed.txt'), 'utf8'), 'sandbox-writable');
  assert.equal(await readFile(path.join(hostPrivate, 'secret.txt'), 'utf8'), sentinel);
  assert.equal(await readFile(path.join(sibling, 'original.txt'), 'utf8'), 'untouched');
  assert.deepEqual(await names(sibling), ['original.txt']);
  assert.deepEqual(await names(hostPrivate), ['secret.txt']);

  // Whether the escape bytes reached the host is decided here, by walking the
  // directory this run owns — not by the guest's boolean. A Windows host gives
  // that boolean a different meaning: `C:…\sibling\escape.txt` is not an absolute
  // path inside a Linux guest, so the write lands as a *file named* after it in
  // the container's own mount, which confinement permits and the listings above
  // already prove did not touch the sibling directory. `probe.cjs` quotes the
  // canary as source text, so a hit is an exact whole-file match.
  const landed = await escapeCanaryHits(root, escapeCanary);
  const { insideMount, outsideMount } = splitLanding(landed, { root, mount: workspace });
  const landing = escapeLandingViolations({ hostPathWrite, insideMount, outsideMount });
  process.stdout.write(
    [
      `SANDBOX_ESCAPE_LANDING: hostPathWrite=${hostPathWrite} insideMount=${insideMount.length} outsideMount=${outsideMount.length}`,
      `SANDBOX_ESCAPE_LANDING_VERDICT: ${landing.length === 0 ? 'accounted' : landing.join(' | ')}`,
    ].join('\n') + '\n',
  );
  assert.deepEqual(
    landing,
    [],
    'the bytes used for the escape attempt must stay inside the container’s own mount',
  );
  assert.equal(connections, 0, 'host loopback listener must see no sandbox connection');
  process.stdout.write('SANDBOX_RUNTIME_PROOF: PASS\n');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(clientConfig, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
