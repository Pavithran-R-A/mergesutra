import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runVerification } from '../dist/verify/engine.js';
import { scopeDigest } from '../dist/verify/consent.js';
import { riskOf } from '../dist/process/tool-policy.js';
import { runLoop, checkAction, finishAction } from '../tests/helpers/implement.ts';
import { cleanUp } from '../tests/helpers/plan.ts';

// This proof drives production command routing; only the AI model and the
// patch-identity oracle are deterministic fixtures. It is NOT a full
// Git-worktree customer release acceptance or a container escape audit.
const fixtureDirs = [];
const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-stage-container-'));
const sibling = path.join(root, 'sibling');
const privateDir = path.join(root, 'host-only');
const sentinel = 'STAGE-ENGINE-PRIVATE-SENTINEL';
let server;
let connections = 0;

try {
  await Promise.all([
    mkdir(sibling, { recursive: true }),
    mkdir(privateDir, { recursive: true }),
  ]);
  await writeFile(path.join(privateDir, 'secret'), sentinel);

  // Poison host Docker redirects. Docker CLI must use the local daemon only.
  process.env.DOCKER_HOST = 'tcp://127.0.0.1:1';
  process.env.DOCKER_CONTEXT = 'not-a-real-context';
  process.env.GH_TOKEN = 'host-only-canary';
  process.env.BHARATCODE_API_KEY = 'host-only-canary';

  const implementation = await runLoop(
    fixtureDirs,
    [checkAction(['node', '--version']), finishAction()],
    { deps: { run: undefined } },
  );
  assert.equal(
    implementation.implementation.actions[0]?.outcome,
    'CHECK_PASSED',
    'Stage 6 RUN_CHECK must really execute inside Docker',
  );
  assert.equal(implementation.implementation.summary.commands, 1);

  server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const workspace = implementation.root;

  const attacker = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const report = { hostRead: false, siblingWrite: false, connected: false, tokenInherited: false };",
    "try { fs.readFileSync(" + JSON.stringify(path.join(privateDir, 'secret')) + "); report.hostRead = true; } catch {}",
    "try { fs.writeFileSync(" + JSON.stringify(path.join(sibling, 'escaped')) + ", 'escaped'); report.siblingWrite = true; } catch {}",
    "report.tokenInherited = Boolean(process.env.GH_TOKEN || process.env.BHARATCODE_API_KEY || process.env.GITHUB_TOKEN || process.env.NPM_TOKEN);",
    "const socket = net.connect({ host: '127.0.0.1', port: " + String(port) + " });",
    "const done = () => { fs.writeFileSync('/workspace/stage-proof.json', JSON.stringify(report)); socket.destroy(); };",
    "socket.once('connect', () => { report.connected = true; done(); });",
    "socket.once('error', done);",
    "socket.setTimeout(1200, done);",
  ].join('\n');
  await writeFile(path.join(workspace, 'stage-probe.cjs'), attacker);

  const argv = ['node', 'stage-probe.cjs'];
  const gate = {
    id: 'VG-001',
    name: 'test',
    command: argv.join(' '),
    argv,
    cwd: '.',
    commandForms: [argv.join(' ')],
    requirementLevel: 'REPOSITORY_REQUIRED',
    corroboratedBy: [],
    relevantCriteria: ['AC-1'],
    timeoutMs: 30_000,
    provenance: {
      source: 'CI_WORKFLOW',
      file: '.github/workflows/ci.yml',
      detail: 'stage sandbox real runtime',
      line: 1,
    },
    executionClass: 'READ_ONLY',
    risk: riskOf({ op: 'execute', argv, cwd: workspace }),
  };
  const plan = {
    schemaVersion: 1,
    mergeSutraVersion: '0.1.0',
    runId: 'run-stage-proof',
    baseSha: 'a'.repeat(40),
    patchIdentity: 'b'.repeat(64),
    createdAt: '2026-10-12T00:00:00.000Z',
    revision: 1,
    gates: [gate],
    revisions: [],
    refused: [],
    missingPrerequisites: [],
    notes: [],
  };
  const consent = {
    planDigest: scopeDigest(plan),
    gateIds: ['VG-001'],
    grantedAt: '2026-10-12T00:00:00.000Z',
  };
  const round = await runVerification(
    { plan, workspace, consent },
    // The byte-identity oracle is controlled in this transport-level test;
    // independently measured Git patch identity is a separate release gate.
    { currentPatchIdentity: async () => plan.patchIdentity },
  );
  assert.equal(round.result, 'PASS', 'Stage 7 must execute the actual Docker runner');
  assert.equal(round.gates[0]?.receipt.termination, 'EXITED');
  assert.equal(round.gates[0]?.receipt.exitCode, 0);

  const observed = JSON.parse(await readFile(path.join(workspace, 'stage-proof.json'), 'utf8'));
  assert.deepEqual(observed, {
    hostRead: false,
    siblingWrite: false,
    connected: false,
    tokenInherited: false,
  });
  assert.equal(await readFile(path.join(privateDir, 'secret'), 'utf8'), sentinel);
  assert.equal(existsSync(path.join(sibling, 'escaped')), false);
  assert.equal(connections, 0, 'host listener was never reached');
  process.stdout.write('STAGE_6_AND_7_DOCKER_PROOF: PASS\n');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanUp(fixtureDirs);
  await rm(root, { recursive: true, force: true });
}
