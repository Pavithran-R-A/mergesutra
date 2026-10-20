import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * The portable half of Stage 10: an approved page, the bytes under it, and the
 * evidence beside them, in one artifact a different workflow can reconstruct.
 *
 * The live-model job is the only job that may hold the BharatCode secret, and the
 * publication job is the only job that may hold a write-scoped GitHub token. This
 * module is how the first hands the second a page without handing it a credential:
 * every byte it carries is copied from the run's own workspace and checked against
 * the hash Stage 7 measured, and every link between the page, the patch, the pack
 * and the record is re-checked before the artifact is written and again when it is
 * read. Reconstruction is not proof — the publication runner re-measures the
 * worktree with the product's own `describePatch` before it sends anything — but a
 * bundle that fails these checks cannot even reach that step.
 *
 * The publication digest is carried, not derived. It is the number a human types,
 * and only the product's `publicationDigestOf` may mint it; this module hashes
 * bytes and refuses paths, and deriving a second opinion would create a second
 * authority. The runner compares the typed digest to the carried one, and the
 * product re-decides the approval against the reconstructed page before publishing.
 */

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_FILE = 'bundle.json';
export const PACK_FILE_NAMES = ['report.md', 'report.json', 'commands.jsonl'];
export const SCRATCH_SEGMENT = '.mergesutra';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CHANGES = new Set(['ADDED', 'MODIFIED', 'DELETED']);
const MODES = new Set(['100644', '100755']);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function refused(message) {
  const error = new Error(message);
  error.code = 'PUBLICATION_BUNDLE_REFUSED';
  return error;
}

function refuse(message) {
  throw refused(message);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    refuse(`A publication bundle needs a non-empty ${label}.`);
  }
  return value;
}

function requireRunId(value) {
  if (typeof value !== 'string' || !RUN_ID.test(value)) {
    refuse(`A publication bundle names an unsafe run id: '${String(value).slice(0, 80)}'.`);
  }
  return value;
}

function requireRepository(value) {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) {
    refuse(
      `A publication bundle needs a repository as owner/name, not '${String(value).slice(0, 120)}'.`,
    );
  }
  return value;
}

function requireSha40(value, label) {
  if (typeof value !== 'string' || !SHA40.test(value)) {
    refuse(`A publication bundle needs a full lowercase ${label} (40 hex characters).`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    refuse(`A publication bundle needs a lowercase 64-character ${label}.`);
  }
  return value;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * A repository-relative path, or a refusal naming the path.
 *
 * Backslashes are refused rather than normalised: the same artifact is read on a
 * Linux runner after being written on either host, and a path whose meaning changes
 * with the separator is not a path either reader can agree on. MergeSutra's scratch
 * is refused as a segment because a nested run's metadata is another run's code.
 */
export function checkedBundlePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    refuse('Refusing a publication bundle path that is empty or over 1024 characters.');
  }
  if (hasControlCharacter(value)) {
    refuse(`Refusing a publication bundle path with a control character: '${printable(value)}'.`);
  }
  if (value.includes('\\')) {
    refuse(
      `Refusing a publication bundle path with a backslash; Git reports forward slashes: '${printable(value)}'.`,
    );
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith('/')) {
    refuse(
      `Refusing the absolute path '${printable(value)}': a bundle path is repository-relative.`,
    );
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    refuse(`Refusing the path '${printable(value)}': it contains an empty or traversal segment.`);
  }
  if (segments.some((segment) => segment.toLowerCase() === SCRATCH_SEGMENT)) {
    refuse(
      `Refusing the path '${printable(value)}': MergeSutra's own scratch is never part of a patch.`,
    );
  }
  return value;
}

function printable(value) {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function resolveInside(root, relative) {
  const resolved = path.resolve(root, ...relative.split('/'));
  const rest = path.relative(root, resolved);
  if (
    rest.length === 0 ||
    rest === '..' ||
    rest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rest)
  ) {
    refuse(`Refusing the path '${printable(relative)}': it resolves outside the target directory.`);
  }
  return resolved;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read one file fact from the workspace and copy its bytes into the bundle.
 *
 * A symbolic link is refused rather than followed: the publication transport will
 * refuse to send one anyway, and copying its target's bytes would make the bundle
 * claim a regular file that the run never held.
 */
async function measureFile(root, file) {
  const relative = checkedBundlePath(file.path);
  const absolute = resolveInside(root, relative);
  const facts = await lstat(absolute).catch(() => null);
  if (facts === null) {
    refuse(`The bundle cannot carry '${relative}': its content is missing from the workspace.`);
  }
  if (facts.isSymbolicLink()) {
    refuse(
      `The bundle cannot carry '${relative}': it is a symbolic link, and a bundle holds regular files.`,
    );
  }
  if (!facts.isFile()) {
    refuse(`The bundle cannot carry '${relative}': it is not a regular file.`);
  }
  const declared = requireSha256(file.contentSha256, `content hash for '${relative}'`);
  const bytes = await readFile(absolute);
  const actual = sha256(bytes);
  if (actual !== declared) {
    refuse(
      `The content hash for '${relative}' does not match its bytes ` +
        `(recorded ${declared.slice(0, 12)}…, read ${actual.slice(0, 12)}…).`,
    );
  }
  return {
    path: relative,
    tracked: file.tracked,
    change: file.change,
    contentSha256: actual,
    contentBase64: bytes.toString('base64'),
    mode: (facts.mode & 0o111) === 0 ? '100644' : '100755',
  };
}

function copyDeleted(file) {
  const relative = checkedBundlePath(file.path);
  if (file.contentSha256 !== null) {
    refuse(`The bundle cannot carry '${relative}': a deletion has no content hash.`);
  }
  return { path: relative, tracked: file.tracked, change: file.change, contentSha256: null };
}

async function filesOf(patch, workspace) {
  if (!Array.isArray(patch.files) || patch.files.length === 0) {
    refuse('A publication bundle needs at least one changed file.');
  }
  const root = await realpath(workspace).catch(() => {
    refuse(`The bundle cannot read the workspace '${printable(String(workspace))}'.`);
  });
  const seen = new Set();
  const files = [];
  for (const file of patch.files) {
    if (typeof file !== 'object' || file === null) {
      refuse('A publication bundle patch file is not an object.');
    }
    if (!CHANGES.has(file.change)) {
      refuse(
        `Refusing the path '${printable(String(file.path))}': unknown change '${String(file.change)}'.`,
      );
    }
    if (typeof file.tracked !== 'boolean') {
      refuse(
        `Refusing the path '${printable(String(file.path))}': its tracked flag is not a boolean.`,
      );
    }
    const relative = checkedBundlePath(file.path);
    if (seen.has(relative)) {
      refuse(`Refusing the path '${relative}': it appears twice in one patch.`);
    }
    seen.add(relative);
    files.push(file.change === 'DELETED' ? copyDeleted(file) : await measureFile(root, file));
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function parseRecordText(recordText, runId) {
  let parsed;
  try {
    parsed = JSON.parse(recordText);
  } catch {
    refuse('The bundle carries a run record that is not JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    refuse('The bundle carries a run record that is not an object.');
  }
  if (parsed.runId !== runId) {
    refuse(`The bundle's run record names '${String(parsed.runId)}', not '${runId}'.`);
  }
  if (parsed.stage !== 'pr') {
    refuse(
      `The bundle's run record is at stage '${String(parsed.stage)}', not the pr stage a publication needs.`,
    );
  }
  return parsed;
}

function parsePackText(packText, patchIdentity) {
  if (typeof packText !== 'object' || packText === null) {
    refuse('The bundle carries no evidence pack.');
  }
  const names = Object.keys(packText).sort();
  if (
    names.length !== PACK_FILE_NAMES.length ||
    names.some((name, index) => name !== [...PACK_FILE_NAMES].sort()[index])
  ) {
    refuse(`The bundle's evidence pack must carry exactly ${PACK_FILE_NAMES.join(', ')}.`);
  }
  for (const name of PACK_FILE_NAMES) {
    if (typeof packText[name] !== 'string') {
      refuse(`The bundle's '${name}' is not text.`);
    }
  }
  let report;
  try {
    report = JSON.parse(packText['report.json']);
  } catch {
    refuse('The bundle carries a report.json that is not JSON.');
  }
  if (report?.patch?.plannedIdentity !== patchIdentity) {
    refuse(
      `The bundle's evidence pack describes patch '${String(report?.patch?.plannedIdentity)}', ` +
        `not the patch the page names (patch identity '${patchIdentity}').`,
    );
  }
}

function crossCheck(input) {
  const { identity, candidate, patch, recordText, packText } = input;
  if (typeof identity !== 'object' || identity === null) {
    refuse('A publication bundle carries no identity.');
  }
  if (identity.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    refuse(`Unsupported publication bundle schema version '${String(identity.schemaVersion)}'.`);
  }
  const runId = requireRunId(identity.runId);
  const repository = requireRepository(identity.repository);
  const baseSha = requireSha40(identity.baseSha, 'base commit SHA');
  const patchIdentity = requireSha256(identity.patchIdentity, 'patch identity');
  const evidencePackIdentity = requireSha256(
    identity.evidencePackIdentity,
    'evidence pack identity',
  );
  requireSha256(identity.publicationDigest, 'publication digest');
  requireString(identity.targetBranch, 'target branch');
  requireString(identity.proposedBranch, 'proposed branch');
  if (
    identity.sourceRunUrl !== null &&
    identity.sourceRunUrl !== undefined &&
    !/^https:\/\/[^\s]+$/.test(identity.sourceRunUrl)
  ) {
    refuse('A publication bundle source run URL must be an https URL or null.');
  }

  if (typeof candidate !== 'object' || candidate === null) {
    refuse('A publication bundle carries no candidate.');
  }
  if (candidate.patchIdentity !== patchIdentity) {
    refuse(
      `The candidate names patch identity '${String(candidate.patchIdentity)}', but the bundle ` +
        `carries '${patchIdentity}'; a portable artifact may not swap the candidate for a different patch.`,
    );
  }
  if (candidate.runId !== runId) {
    refuse(`The candidate names run '${String(candidate.runId)}', not '${runId}'.`);
  }
  if (candidate.repository !== repository) {
    refuse(
      `The candidate names repository '${String(candidate.repository)}', not '${repository}'.`,
    );
  }
  if (candidate.baseSha !== baseSha) {
    refuse('The candidate and the bundle name different base commits.');
  }
  if (
    candidate.targetBranch !== identity.targetBranch ||
    candidate.proposedBranch !== identity.proposedBranch
  ) {
    refuse('The candidate and the bundle name different branches.');
  }
  if (candidate.evidencePackIdentity !== evidencePackIdentity) {
    refuse('The candidate and the bundle name different evidence packs.');
  }
  if (
    typeof candidate.prTitle !== 'string' ||
    typeof candidate.prBody !== 'string' ||
    candidate.prTitle.length === 0 ||
    candidate.prBody.length === 0
  ) {
    refuse('The candidate has no page to publish.');
  }

  if (typeof patch !== 'object' || patch === null) {
    refuse('A publication bundle carries no patch.');
  }
  if (patch.schemaVersion !== 1) {
    refuse(`Unsupported publication patch schema version '${String(patch.schemaVersion)}'.`);
  }
  if (patch.baseSha !== baseSha || patch.identity !== patchIdentity) {
    refuse('The bundle patch does not describe the patch its identity names.');
  }
  if (!Array.isArray(patch.files) || patch.files.length === 0) {
    refuse('A publication bundle needs at least one changed file.');
  }
  const seen = new Set();
  for (const file of patch.files) {
    if (typeof file !== 'object' || file === null) {
      refuse('A publication bundle patch file is not an object.');
    }
    const relative = checkedBundlePath(file.path);
    if (seen.has(relative)) {
      refuse(`Refusing the path '${relative}': it appears twice in one patch.`);
    }
    seen.add(relative);
    if (!CHANGES.has(file.change) || typeof file.tracked !== 'boolean') {
      refuse(`Refusing the path '${relative}': its change or tracked flag is malformed.`);
    }
    if (file.change === 'DELETED') {
      if (file.contentSha256 !== null || file.contentBase64 !== undefined) {
        refuse(`Refusing the path '${relative}': a deletion cannot carry content.`);
      }
      continue;
    }
    const declared = requireSha256(file.contentSha256, `content hash for '${relative}'`);
    if (typeof file.contentBase64 !== 'string' || !BASE64.test(file.contentBase64)) {
      refuse(`Refusing the path '${relative}': its content is not base64.`);
    }
    if (file.mode !== undefined && !MODES.has(file.mode)) {
      refuse(`Refusing the path '${relative}': unknown file mode '${String(file.mode)}'.`);
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (sha256(bytes) !== declared) {
      refuse(`The content hash for '${relative}' does not match the bytes the bundle carries.`);
    }
  }
  const changedPaths = patch.files.map((file) => file.path).sort();
  const deletedPaths = patch.files
    .filter((file) => file.change === 'DELETED')
    .map((file) => file.path)
    .sort();
  if (
    !Array.isArray(identity.changedPaths) ||
    !Array.isArray(identity.deletedPaths) ||
    identity.changedPaths.length !== changedPaths.length ||
    identity.changedPaths.some((entry, index) => entry !== changedPaths[index]) ||
    identity.deletedPaths.length !== deletedPaths.length ||
    identity.deletedPaths.some((entry, index) => entry !== deletedPaths[index])
  ) {
    refuse('The bundle identity and its patch disagree about which paths change.');
  }

  const record = parseRecordText(requireString(recordText, 'run record'), runId);
  const linked = (record.publications ?? []).some(
    (entry) =>
      entry?.candidate?.patchIdentity === patchIdentity && entry?.candidate?.runId === runId,
  );
  if (!linked) {
    refuse('The bundle run record does not carry the candidate the page names.');
  }
  parsePackText(packText, patchIdentity);
}

export async function buildPublicationBundle(input) {
  const identity = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    runId: requireRunId(input.runId),
    repository: requireRepository(input.repository),
    baseSha: requireSha40(input.baseSha, 'base commit SHA'),
    targetBranch: requireString(input.targetBranch, 'target branch'),
    proposedBranch: requireString(input.proposedBranch, 'proposed branch'),
    patchIdentity: requireSha256(input.patchIdentity, 'patch identity'),
    evidencePackIdentity: requireSha256(input.evidencePackIdentity, 'evidence pack identity'),
    publicationDigest: requireSha256(input.publicationDigest, 'publication digest'),
    changedPaths: [],
    deletedPaths: [],
    sourceRunUrl: input.sourceRunUrl ?? null,
  };
  const patch = input.patch;
  if (typeof patch !== 'object' || patch === null || patch.schemaVersion !== 1) {
    refuse('A publication bundle needs a schema-1 patch description.');
  }
  if (patch.baseSha !== identity.baseSha || patch.identity !== identity.patchIdentity) {
    refuse('The bundle patch does not describe the patch its identity names.');
  }
  if (input.candidate?.patchIdentity !== identity.patchIdentity) {
    refuse(
      `The candidate names patch identity '${String(input.candidate?.patchIdentity)}', but the bundle ` +
        `carries '${identity.patchIdentity}'; a portable artifact may not swap the candidate for a different patch.`,
    );
  }
  const files = await filesOf(patch, input.workspace);
  identity.changedPaths = files.map((file) => file.path);
  identity.deletedPaths = files
    .filter((file) => file.change === 'DELETED')
    .map((file) => file.path);
  const bundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    identity,
    candidate: input.candidate,
    patch: { schemaVersion: 1, baseSha: identity.baseSha, identity: identity.patchIdentity, files },
    recordText: input.recordText,
    packText: input.packText,
  };
  crossCheck(bundle);
  return bundle;
}

export async function readPublicationBundle(dir) {
  const file = path.join(dir, BUNDLE_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    refuse(`No publication bundle was found at '${printable(file)}'.`);
  }
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    refuse('The publication bundle is not JSON.');
  }
  crossCheck(bundle);
  return bundle;
}

export async function writePublicationBundle(dir, bundle) {
  crossCheck(bundle);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, BUNDLE_FILE);
  await atomicWrite(file, `${JSON.stringify(bundle, null, 2)}\n`);
  return { dir, file, identity: bundle.identity };
}

export function assertApprovedDigest(identity, approval) {
  const normalised = typeof approval === 'string' ? approval.trim().toLowerCase() : '';
  if (!SHA256.test(normalised)) {
    refuse(
      'A publication approval must be the 64-character hex digest of the page, ' +
        `not '${printable(String(approval)).slice(0, 80)}'.`,
    );
  }
  if (normalised !== identity.publicationDigest) {
    refuse(
      `That approval names a different candidate: it digests '${normalised.slice(0, 12)}…', ` +
        `while this bundle's page digests '${String(identity.publicationDigest).slice(0, 12)}…'.`,
    );
  }
  return normalised;
}

/**
 * Reconstruct the approved bytes in a fresh worktree.
 *
 * Each file is written through a temporary sibling and renamed into place, so a
 * crashed run leaves either the base byte or the approved byte, never half of one.
 * A symlink at the destination is refused rather than replaced through: the link may
 * point outside the worktree, and a reconstruction that follows it is not confined.
 */
export async function applyPatch(target, patch) {
  const root = await realpath(target).catch(() => {
    refuse(`Cannot apply the bundle: the target '${printable(String(target))}' does not exist.`);
  });
  if (typeof patch !== 'object' || patch === null || !Array.isArray(patch.files)) {
    refuse('Cannot apply the bundle: it carries no patch files.');
  }
  let applied = 0;
  for (const file of patch.files) {
    const relative = checkedBundlePath(file.path);
    const absolute = resolveInside(root, relative);
    if (file.change === 'DELETED') {
      const facts = await lstat(absolute).catch(() => null);
      if (facts === null) {
        refuse(
          `Cannot apply the bundle: it deletes '${relative}', but that file does not exist in the base tree.`,
        );
      }
      if (facts.isDirectory()) {
        refuse(`Cannot apply the bundle: it deletes '${relative}', but that path is a directory.`);
      }
      await rm(absolute);
      applied += 1;
      continue;
    }
    if (typeof file.contentBase64 !== 'string' || !BASE64.test(file.contentBase64)) {
      refuse(`Cannot apply the bundle: '${relative}' has no base64 content.`);
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (sha256(bytes) !== file.contentSha256) {
      refuse(`Cannot apply the bundle: '${relative}' does not match its content hash.`);
    }
    await ensureParent(root, relative);
    const facts = await lstat(absolute).catch(() => null);
    if (facts?.isSymbolicLink()) {
      refuse(`Cannot apply the bundle: '${relative}' is a symbolic link in the base tree.`);
    }
    if (facts?.isDirectory()) {
      refuse(`Cannot apply the bundle: '${relative}' is a directory in the base tree.`);
    }
    const temp = path.join(
      path.dirname(absolute),
      `.mergesutra-apply-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
    );
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    try {
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    // The publication transport reads this bit to choose 100644 or 100755.
    await chmod(absolute, file.mode === '100755' ? 0o755 : 0o644).catch(() => undefined);
    applied += 1;
  }
  return { applied };
}

async function ensureParent(root, relative) {
  const segments = relative.split('/').slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const facts = await lstat(current).catch(() => null);
    if (facts === null) {
      await mkdir(current);
      continue;
    }
    if (facts.isSymbolicLink()) {
      refuse(`Cannot apply the bundle: '${printable(relative)}' passes through a symbolic link.`);
    }
    if (!facts.isDirectory()) {
      refuse(`Cannot apply the bundle: '${printable(relative)}' passes through a non-directory.`);
    }
  }
}

/**
 * Put the record and pack where the product's `pr` stage will look for them.
 *
 * The store is the run's own; a different record under the same run id is a
 * rewrite of history, not a staging step, so it is refused rather than replaced.
 * Re-staging identical bytes is allowed, which makes a retried publication
 * invocation idempotent without letting it change what a human approved.
 */
export async function stageRunStore(storeRoot, bundle) {
  const runId = requireRunId(bundle?.identity?.runId);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const record = path.join(storeRoot, `${runId}.json`);
  await writeIfSameOrAbsent(record, bundle.recordText, 'run record');
  const packDir = path.join(storeRoot, runId);
  await mkdir(packDir, { recursive: true, mode: 0o700 });
  for (const name of PACK_FILE_NAMES) {
    await writeIfSameOrAbsent(
      path.join(packDir, name),
      bundle.packText[name],
      'evidence pack file',
    );
  }
  return { record, packDir };
}

async function writeIfSameOrAbsent(file, content, label) {
  const existing = await readFile(file, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    if (existing !== content) {
      refuse(`Refusing to overwrite a different ${label} at '${printable(file)}'.`);
    }
    return;
  }
  await atomicWrite(file, content);
}

async function atomicWrite(file, content) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
