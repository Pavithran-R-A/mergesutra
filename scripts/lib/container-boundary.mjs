/**
 * Read a live `docker inspect` record and report, as data, whether the daemon
 * actually started the container inside the boundary `sandboxDockerArgv` claims.
 *
 * The sandbox's own fixture can only report what it observed from inside
 * (`fs.readFileSync` failed, the socket never connected). Both of those are
 * claims the guest makes about itself. This checker corroborates the two that
 * matter most from the other side — which host paths the daemon handed the
 * container, and which environment variables it delivered — plus the flags the
 * record carries. Nothing here runs a command: the record checker reads only the
 * record it is handed, and the landing helpers read only the host directory the
 * calling proof owns. That is what lets the unit tests plant tampered records and
 * a planted directory tree, and the runtime proof feed both a real one.
 *
 * Field names are the ones the daemon reports, measured against a live
 * container: `HostConfig.NanoCpus` (not `NanoCPUs`), the bind in both
 * `Mounts[].Destination` and `HostConfig.Mounts[].Target`, the resolved digest in
 * `Image` and the requested reference in `Config.Image`.
 */

import { Buffer } from 'node:buffer';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const PRIVILEGED_NAME_PARTS = new Set([
  'TOKEN',
  'TOKENS',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'PAT',
  'COOKIE',
]);

const PRIVILEGED_NAME_PAIRS = [
  ['API', 'KEY'],
  ['ACCESS', 'KEY'],
  ['PRIVATE', 'KEY'],
  ['SECRET', 'KEY'],
];

function isPrivilegedEnvName(name) {
  const parts = String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .split('_')
    .filter(Boolean);
  if (parts.some((part) => PRIVILEGED_NAME_PARTS.has(part))) return true;
  return PRIVILEGED_NAME_PAIRS.some(([first, second]) =>
    parts.some((part, index) => part === first && parts[index + 1] === second),
  );
}

function pathComponents(value) {
  return String(value)
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
}

/**
 * A Windows Docker host reports the bind source in its 8.3 short form, which is
 * what the daemon measured here: the run workspace
 * `C:\Users\Example User\…` came back as `C:\Users\EXAMPLES~1\…`. Comparing the
 * two byte-for-byte would reject an honest container on every Windows host, so a
 * component that is *shaped* like a short name (`<prefix>~<digits>`) is matched
 * case-insensitively against the compressed long name. A component with no `~N`
 * must match exactly, which keeps a forged sibling path refused.
 */
function componentMatches(reported, expected) {
  if (reported === expected) return true;
  const short = /^(.+)~(\d+)$/.exec(reported);
  if (!short) return false;
  const base = short[1].toLowerCase().replace(/[^a-z0-9]/g, '');
  const long = expected.toLowerCase().replace(/[^a-z0-9]/g, '');
  return base.length > 0 && long.startsWith(base);
}

function sameHostPath(reported, expected) {
  const reportedParts = pathComponents(reported);
  const expectedParts = pathComponents(expected);
  if (reportedParts.length !== expectedParts.length) return false;
  return reportedParts.every((part, index) => componentMatches(part, expectedParts[index]));
}

export { sameHostPath };

function hasOption(options, wanted) {
  return options
    .split(',')
    .map((option) => option.trim())
    .includes(wanted);
}

function envAssignments(record) {
  const env = record?.Config?.Env;
  if (!Array.isArray(env)) return [];
  return env.filter((entry) => typeof entry === 'string');
}

/**
 * Walk the host's own filesystem and return, sorted, the absolute paths of the
 * regular files under `root` whose *entire* content equals `canary`.
 *
 * This is the host-side half of the escape measurement: the container reports
 * whether `writeFileSync` returned, and only this walk can say where those bytes
 * actually are. Symlinked entries are not read and not descended into — a link
 * inside the mount is a name the container can plant that points elsewhere, so
 * following it would let one planted link turn an escape into a "confined" hit.
 * The same rule stops a planted link from creating a cycle here.
 *
 * Files are only opened when their size equals the canary's, so a hostile
 * fixture that fills the mount with large files cannot make this read them all.
 *
 * @param {string} root directory this proof owns, e.g. its own scratch root
 * @param {string} canary the exact bytes the fixture was told to write outside
 * @returns absolute paths of matching files, sorted
 */
export async function escapeCanaryHits(root, canary) {
  const wanted = Buffer.byteLength(canary);
  const hits = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full);
        if (info.size === wanted && (await readFile(full)).toString('utf8') === canary) {
          hits.push(full);
        }
      }
    }
  };
  await walk(root);
  return hits.sort();
}

/**
 * Split host-side hits by whether the file sits under the directory the container
 * was handed. Labels are relative to `root` with `/` separators, so the verdict a
 * proof prints names the same file on every platform.
 *
 * Containment is decided by resolving the path, not by comparing prefixes: a hit
 * in `workspaceish/` is *not* under `workspace/`, and a string-prefix test would
 * have called that escape confined.
 *
 * @param {string[]} hits absolute paths from `escapeCanaryHits`
 * @param {{root: string, mount: string}} places `mount` is the bound directory
 * @returns {{insideMount: string[], outsideMount: string[]}}
 */
export function splitLanding(hits, { root, mount }) {
  const label = (file) => path.relative(root, file).split(path.sep).join('/');
  const insideMount = [];
  const outsideMount = [];
  for (const file of hits) {
    const fromMount = path.relative(mount, file);
    (fromMount.startsWith('..') || path.isAbsolute(fromMount) ? outsideMount : insideMount).push(
      label(file),
    );
  }
  return { insideMount, outsideMount };
}

/**
 * Decide, from the host side, where the bytes of the fixture's escape attempt
 * actually landed.
 *
 * The guest can only say whether `writeFileSync` returned. On a Linux host the
 * planted sibling path is an absolute path the container cannot reach, so it
 * returns nothing and reports false. On a Windows host the same string is not an
 * absolute path inside the Linux guest at all: it resolves relative to the
 * container's working directory, so the write *succeeds* and the bytes land as a
 * file named after that path inside the one directory the container was handed.
 * Treating the guest's boolean as the boundary claim therefore fails an honest
 * Windows container — and trusting that boolean alone would accept a guest that
 * lies about it.
 *
 * So the caller walks the host filesystem and reports what it found; this
 * predicate only draws the conclusion. `insideMount` and `outsideMount` are
 * labels of host files whose entire content equals the escape canary the fixture
 * was told to write, split by whether the file sits under the directory handed to
 * the container.
 *
 * @returns one `CODE: detail` line per reason the landing is unaccounted for;
 *   empty means the host evidence matches the guest's report and every byte the
 *   container wrote stayed inside its own mount.
 */
export function escapeLandingViolations({ hostPathWrite, insideMount, outsideMount }) {
  const failures = [];
  const add = (code, detail) => failures.push(`${code}: ${detail}`);
  if (outsideMount.length > 0) {
    add(
      'LANDING_OUTSIDE_MOUNT',
      `escape bytes exist on the host outside the mount: ${outsideMount.join(', ')}`,
    );
  }
  if (hostPathWrite === true && insideMount.length === 0) {
    add('LANDING_UNACCOUNTED', 'the write returned but the host found no copy of those bytes');
  }
  if (hostPathWrite !== true && insideMount.length > 0) {
    add(
      'LANDING_UNSOLICITED',
      `the write did not return yet ${insideMount.length} file(s) carry those bytes: ${insideMount.join(', ')}`,
    );
  }
  return failures;
}

/**
 * @param record one decoded `docker inspect` element for the sandboxed container.
 * @param expectation the boundary the caller intended, including the credential
 *   canaries it planted in its own environment so their absence is measurable.
 * @returns one `CODE: detail` line per violated boundary; empty means the record
 *   corroborates the boundary.
 */
export function containerBoundaryViolations(record, expectation) {
  const failures = [];
  const add = (code, detail) => failures.push(`${code}: ${detail}`);

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['RECORD_UNREADABLE: no container record was captured from the daemon'];
  }
  const host = record.HostConfig ?? {};
  const config = record.Config ?? {};

  if (host.NetworkMode !== 'none')
    add('NETWORK_MODE', `network mode is ${String(host.NetworkMode)}`);
  if (host.Privileged !== false)
    add('NOT_PRIVILEGED', 'the container is not recorded as unprivileged');
  if (host.ReadonlyRootfs !== true)
    add('READONLY_ROOTFS', 'the container root filesystem is writable');
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL')) {
    add('CAP_DROP_ALL', 'the daemon did not record a drop of all capabilities');
  }
  if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges:true')) {
    add('NO_NEW_PRIVILEGES', 'no-new-privileges is absent from the recorded security options');
  }
  if (Array.isArray(host.GroupAdd) && host.GroupAdd.length > 0) {
    add('GROUP_ADD', `the container was given extra groups: ${host.GroupAdd.join(', ')}`);
  }
  if (host.Memory !== expectation.memoryBytes)
    add('MEMORY_LIMIT', `memory is ${String(host.Memory)}`);
  if (host.PidsLimit !== expectation.pidsLimit)
    add('PIDS_LIMIT', `pids-limit is ${String(host.PidsLimit)}`);
  if (host.NanoCpus !== expectation.nanoCpus)
    add('CPU_LIMIT', `nano-cpus is ${String(host.NanoCpus)}`);
  if (host.AutoRemove !== true) add('AUTO_REMOVE', 'the container is not recorded as --rm');

  if (Array.isArray(host.Binds) && host.Binds.length > 0) {
    add('EXTRA_BINDS', host.Binds.join(', '));
  }
  if (Array.isArray(host.Devices) && host.Devices.length > 0) {
    add(
      'HOST_DEVICES',
      host.Devices.map((device) => device?.PathOnHost ?? String(device)).join(', '),
    );
  }

  const tmpfsKeys = Object.keys(host.Tmpfs ?? {});
  if (tmpfsKeys.length !== 1 || tmpfsKeys[0] !== '/tmp') {
    add('TMPFS_SET', `tmpfs mounts are ${tmpfsKeys.join(', ') || '(none)'}`);
  } else {
    const options = String(host.Tmpfs['/tmp']);
    if (!hasOption(options, 'nosuid') || !hasOption(options, 'noexec')) {
      add('TMPFS_OPTIONS', `/tmp is mounted ${options}`);
    }
  }

  const mounts = Array.isArray(record.Mounts) ? record.Mounts : [];
  if (mounts.length !== 1) {
    add('MOUNT_COUNT', `the container was given ${mounts.length} mounts, expected exactly 1`);
  }
  for (const mount of mounts) {
    if (mount?.Source !== undefined && !sameHostPath(mount.Source, expectation.workspace)) {
      add(
        'MOUNT_SOURCE',
        `${String(mount.Source)} is not the run workspace ${expectation.workspace}`,
      );
    }
    if (mount?.Destination !== expectation.sandboxRoot) {
      add('MOUNT_DESTINATION', `mounted at ${String(mount.Destination)}`);
    }
    if (mount?.RW !== true)
      add('MOUNT_WRITABLE', `${String(mount?.Source)} is read-only in the container`);
  }

  if (config.WorkingDir !== expectation.sandboxRoot) {
    add('WORKDIR', `workdir is ${String(config.WorkingDir)}`);
  }

  const programPinned =
    record.Path === expectation.file &&
    Array.isArray(config.Entrypoint) &&
    config.Entrypoint.length === 1 &&
    config.Entrypoint[0] === expectation.file;
  if (!programPinned) {
    add(
      'PROGRAM_PINNED',
      `the container starts ${String(record.Path)} via entrypoint ${JSON.stringify(config.Entrypoint)}`,
    );
  } else {
    const forwarded = Array.isArray(config.Cmd) ? config.Cmd : [];
    if (forwarded.join('\u0000') !== expectation.args.join('\u0000')) {
      add('PROGRAM_ARGS', `argv is ${JSON.stringify(forwarded)}`);
    }
  }

  const requestedImage = String(config.Image ?? '');
  if (!/@sha256:[0-9a-f]{64}$/.test(requestedImage)) {
    add('IMAGE_PINNED', `${requestedImage || '(none)'} is not digest-pinned`);
  } else if (requestedImage !== expectation.image) {
    add('IMAGE_MATCH', `${requestedImage} is not the pinned image ${expectation.image}`);
  }
  if (record.Image !== expectation.imageDigest) {
    add('IMAGE_MATCH', `the daemon started ${String(record.Image)}`);
  }

  const user = String(config.User ?? '');
  const [uid, gid] = user.split(':');
  const numericUid = Number(uid);
  const numericGid = gid === undefined ? undefined : Number(gid);
  const unprivileged =
    user !== '' &&
    /^\d+$/.test(uid) &&
    Number.isSafeInteger(numericUid) &&
    numericUid > 0 &&
    (numericGid === undefined || (Number.isSafeInteger(numericGid) && numericGid > 0));
  if (!unprivileged) {
    add(
      'USER_UNPRIVILEGED',
      `identity is "${user || '(unset: the image default, which may be root)'}"`,
    );
  }

  if (record?.State?.Running !== true) {
    add('CONTAINER_RUNNING', `state is ${String(record?.State?.Status ?? 'unknown')}`);
  }

  for (const assignment of envAssignments(record)) {
    const name = assignment.slice(0, assignment.indexOf('='));
    const value = assignment.slice(assignment.indexOf('=') + 1);
    if (isPrivilegedEnvName(name)) {
      add('ENV_PRIVILEGED_NAME', name);
      continue;
    }
    if (expectation.canaryValues.some((canary) => canary.length > 0 && value.includes(canary))) {
      add('ENV_CANARY_LEAK', name);
    }
  }

  return failures;
}
