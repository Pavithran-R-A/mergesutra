import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * The evidence-safety primitives the customer qualification shares.
 *
 * Stage 17 wrote raw evidence into `.mergesutra/customer-qualification/` and then
 * scanned it, which is the right order — a scan that looked at already-redacted
 * bytes would prove nothing about what the product printed. But the hosted job has
 * to upload that same tree, and a file the harness only ever paraphrased
 * (`note-*.txt`, a model answer, the product's own evidence pack) was written
 * unsanitized. So the raw tree stays the detection surface, and everything that
 * leaves the machine goes through `sanitize()` first, then gets scanned again.
 *
 * These are the patterns the product could plausibly be holding: a BharatCode live
 * key, a generic `sk-` key, a GitHub token of any shape, and a bearer header. The
 * scripted gateway's sentinel is deliberately not in here, because it is not a
 * credential and the harness asserts it appears in the logs.
 */

export const SECRET_PATTERNS = [
  /\bbc_live_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
];

export const REDACTION = '[REDACTED]';

/** Replace every credential-shaped span, leaving the surrounding text readable. */
export function sanitize(text) {
  let output = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, REDACTION);
  }
  for (const pattern of SECRET_PATTERNS) pattern.lastIndex = 0;
  return output;
}

/** Does this text hold a credential shape? Safe to call repeatedly on shared patterns. */
export function leaked(text) {
  const input = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  for (const pattern of SECRET_PATTERNS) pattern.lastIndex = 0;
  return false;
}

/** How a bundled file is named in a report: relative to the export root, POSIX separators. */
export function relativePosix(root, file) {
  return path.relative(root, file).split(path.sep).join('/').replaceAll('\\', '/');
}

/**
 * What may not be an absolute host path in a published artifact.
 *
 * Stage 17 shipped a leak of exactly this kind (the developer's home directory in a
 * published tree), so the bundle redacts a host root on the way out as well, and
 * reports it. Stage 18 found out why naming one root is not enough: the same
 * directory is spelled three ways in one evidence tree — the plain form a log line
 * carries, the `\\`-escaped form every JSON field carries, and the forward-slash form
 * Git prints — and Windows adds a fourth by aliasing the profile directory to its 8.3
 * short form. A scrub that only knows one of them ships the identity anyway, quietly.
 *
 * So the roots are read from the running process, never hardcoded (the same code has
 * to work for a customer on Windows and a runner in `/home/runner`), and each one is
 * matched in every spelling it could appear in. The temp directory joins the list only
 * when it sits inside a home root, because that is when it carries the identity: on a
 * hosted Linux runner `/tmp` names nothing worth hiding, and rewriting every `/tmp`
 * mention would only make the evidence less readable.
 */
export const HOST_PLACEHOLDER = '[host-home]';

const SPELLINGS = [
  (value) => value,
  (value) => value.replaceAll('\\', '/'),
  (value) => value.replaceAll('\\', '\\\\'),
];

function asRoot(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function comparable(value) {
  return value.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
}

function inside(child, parent) {
  const a = comparable(child);
  const b = comparable(parent);
  return a === b || a.startsWith(`${b}/`);
}

function resolved(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return '';
  }
}

/** Roots the caller declared, so a test or a producer can name the paths it is holding. */
function declaredRoots() {
  const raw = process.env.MERGESUTRA_EVIDENCE_ROOTS;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    throw new Error('MERGESUTRA_EVIDENCE_ROOTS is not a JSON array of host paths');
  }
  return parsed.map(asRoot).filter((value) => value !== '');
}

function environmentRoots() {
  const candidates = [os.homedir(), process.env.HOME, process.env.USERPROFILE];
  const { HOMEDRIVE, HOMEPATH } = process.env;
  if (typeof HOMEDRIVE === 'string' && typeof HOMEPATH === 'string') {
    candidates.push(HOMEDRIVE + HOMEPATH);
  }
  return candidates.map(asRoot).filter((value) => value !== '');
}

/** The host's own roots: every home the process knows, plus its temp directory when the identity rides in it. */
export function hostPathRoots() {
  const homes = environmentRoots();
  const temp = asRoot(os.tmpdir());
  const roots = [...declaredRoots(), ...homes];
  if (temp !== '') {
    const carriesIdentity = homes.some(
      (home) => inside(temp, home) || (resolved(temp) !== '' && inside(resolved(temp), home)),
    );
    if (carriesIdentity) roots.push(temp, resolved(temp));
  }
  return [...new Set(roots)].sort((a, b) => b.length - a.length);
}

/** Every way one root can be spelled in text the product wrote. */
export function hostPathSpellings(root) {
  return [...new Set(SPELLINGS.map((spell) => spell(root)))];
}

/** Replace every spelling of every host root, leaving the surrounding text readable. */
export function scrubHost(text) {
  let output = String(text ?? '');
  for (const root of hostPathRoots()) {
    for (const form of hostPathSpellings(root)) {
      output = output.split(form).join(HOST_PLACEHOLDER);
    }
  }
  return output;
}

/** Does this text still name a host root? The artifact is scanned with this before upload. */
export function holdsHostPath(text) {
  const input = String(text ?? '');
  return hostPathRoots().some((root) =>
    hostPathSpellings(root).some((form) => input.includes(form)),
  );
}

/**
 * The bundle's own accounting, kept separate from the copy so the wording is
 * testable and the script stays a sequence of measurable steps.
 *
 * What a raw file held a credential shape is not decided here: that is the
 * qualification's own failure, already recorded by the harness scan that keeps the
 * scenario's `secrets` list non-empty, and the gate library refuses to certify such
 * a row. Redacting one on the way out is this step doing its job, so the script
 * says it out loud as a count instead of turning it into a second failure that
 * would bury the real one — and the artifact is still uploaded, still clean.
 *
 * Three things do make this step red: a credential shape found in the artifact
 * tree after redaction (the re-scan is the defence against a pattern that drifts
 * between the two sides, so it stays even though today's patterns cannot produce
 * it), an evidence file that could not be bundled at all, and an empty artifact.
 * A quietly lossy artifact is how a red job gets re-run until it looks green.
 *
 * @param {{survived: string[], homeSurvived: string[], skipped: string[], written: number}} record
 * @returns {string[]} problems that make the artifact step non-green
 */
export function bundleProblems(record) {
  const problems = [];
  const survived = record.survived ?? [];
  const homeSurvived = record.homeSurvived ?? [];
  const skipped = record.skipped ?? [];
  if (survived.length > 0) {
    problems.push(
      `${String(survived.length)} bundled file(s) still hold a credential shape after redaction: ${survived.join(', ')}`,
    );
  }
  if (homeSurvived.length > 0) {
    problems.push(
      `${String(homeSurvived.length)} bundled file(s) still hold a host path after redaction: ${homeSurvived.join(', ')}`,
    );
  }
  if (skipped.length > 0) {
    problems.push(
      `${String(skipped.length)} evidence file(s) were left out of the artifact: ${skipped.join(', ')}`,
    );
  }
  if ((record.written ?? 0) === 0) {
    problems.push('no evidence was bundled, so the job would upload an empty artifact');
  }
  return problems;
}

/** The disclosure line naming what was redacted, so the count is in the job log and not only in the bytes. */
export function redactionNote(redacted) {
  const names = redacted ?? [];
  if (names.length === 0) return null;
  return `CUSTOMER_EVIDENCE_REDACTIONS ${String(names.length)} ${names.join(', ')}`;
}
