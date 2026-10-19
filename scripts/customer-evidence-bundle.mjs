#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  bundleProblems,
  holdsHostPath,
  leaked,
  redactionNote,
  relativePosix,
  sanitize,
  scrubHost,
} from './lib/customer-evidence.mjs';

/**
 * Turn the qualification's raw evidence tree into something safe to upload.
 *
 * `.mergesutra/customer-qualification/` is deliberately left unsanitized, because
 * the harness's own credential scan has to look at the bytes the product actually
 * printed — a scan of redacted text would prove nothing. The artifact is a different
 * thing: it leaves the machine, gets retained for two weeks, and is read by whoever
 * opens the run. So every file is scrubbed on the way out, and then the bundle is
 * scanned again, so the claim "this artifact is clean" is measured rather than
 * intended.
 *
 * A host path is scrubbed quietly because it is a nuisance. A credential shape found
 * in the raw tree is counted and named on the way out, because the bytes that let it
 * into the evidence tree are the qualification's problem and the harness already
 * refuses to certify a scenario whose scan found one — this step's job is to make the
 * upload safe either way, not to fail a second time for the same cause. What this
 * step does refuse is an artifact tree that still holds a credential shape or a host
 * path after redaction, a file it could not bundle, and an empty bundle: four ways a
 * job ends up uploading something that no longer shows what happened. The host-path
 * re-scan is not decoration — Stage 18 measured that the single-prefix scrub shipped
 * the same directory in five of six spellings while the verdict stayed green, because
 * nothing re-read the artifact for a path.
 */

const ENV = {
  source: 'MERGESUTRA_GATE_EXPORT_ROOT',
  destination: 'MERGESUTRA_GATE_ARTIFACT_ROOT',
  maxBytes: 'MERGESUTRA_GATE_ARTIFACT_MAX_BYTES',
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function named(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

const problems = [];
const source = named(ENV.source);
const destination = named(ENV.destination);
if (source === '')
  problems.push(`the bundle was not given ${ENV.source}, so no evidence was named`);
if (destination === '') {
  problems.push(`the bundle was not given ${ENV.destination}, so it has nowhere safe to write`);
}
const rawMax = named(ENV.maxBytes);
const maxBytes = rawMax === '' ? DEFAULT_MAX_BYTES : Number(rawMax);
if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
  problems.push(`${ENV.maxBytes} is not a positive byte count (${rawMax})`);
}

const redacted = [];
const survived = [];
const homeSurvived = [];
const skipped = [];
let written = 0;

if (problems.length === 0) {
  const listing = await readdir(source, { recursive: true }).catch(() => null);
  if (listing === null) {
    problems.push(`${source} could not be listed, so nothing was bundled`);
  } else {
    const files = [];
    for (const entry of listing.map(String).sort()) {
      const file = path.join(source, entry);
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) files.push({ file, relative: relativePosix(source, file) });
    }
    for (const { file, relative } of files) {
      const info = await stat(file).catch(() => null);
      if (info === null) {
        skipped.push(`${relative} (unreadable)`);
        continue;
      }
      if (info.size > maxBytes) {
        skipped.push(
          `${relative} (${String(info.size)} bytes over the ${String(maxBytes)} byte limit)`,
        );
        continue;
      }
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) {
        skipped.push(`${relative} (unreadable)`);
        continue;
      }
      if (leaked(text)) redacted.push(relative);
      const safe = scrubHost(sanitize(text));
      const target = path.join(destination, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, safe, 'utf8');
      written += 1;
    }
    for (const entry of await readdir(destination, { recursive: true }).catch(() => [])) {
      const file = path.join(destination, String(entry));
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      const text = await readFile(file, 'utf8').catch(() => '');
      const relative = relativePosix(destination, file);
      if (leaked(text)) survived.push(relative);
      if (holdsHostPath(text)) homeSurvived.push(relative);
    }
  }
  problems.push(...bundleProblems({ survived, homeSurvived, skipped, written }));
}

// The count of what had to be redacted is said before the verdict, so the log of a
// green artifact still tells a reader that the raw tree was not clean.
const note = redactionNote(redacted);
if (note !== null) process.stdout.write(`${note}\n`);

if (problems.length === 0) {
  process.stdout.write(`CUSTOMER_EVIDENCE_PASS files=${String(written)}\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(`CUSTOMER_EVIDENCE_FAIL ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exitCode = 1;
}
