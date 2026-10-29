/**
 * The npm release script's registry rules, kept apart from the process that runs them.
 *
 * `npm view` has three distinguishable outcomes, and the release script must not
 * collapse them: this version is absent, this version's metadata was read, or the read
 * itself failed. Only npm's own `code E404` line, alone on a line of its own, is
 * absence; an incidental token in other text is not, because a read that failed for
 * another reason must never authorize a write. Metadata is accepted when it names the
 * package version. A `gitHead` is verified as strictly as it can be — a full lowercase
 * 40-hex commit equal to the release commit — but it is not demanded, because npm's own
 * publish path does not record one (`libnpmpublish` normalizes with `steps: ['fixName']`,
 * and `@npmcli/package-json` only produces `gitHead` when its steps name it): a version
 * this helper published correctly answers with the version alone, and refusing that left
 * the release gate red for good, since re-running reads the same answer. A read-back with
 * no commit says so on its own line rather than claiming a tie. Neither accepted shape
 * authorizes a write — only an absence does that — so the fail-closed property survives
 * the relaxed provenance rule.
 *
 * After a successful publish both an absent and a failed answer are retried within a
 * bounded poll: a version that was just published may still be propagating, and the
 * last thing the operator is told is which of the two states the final read left.
 */

const GIT_HEAD = /^[0-9a-f]{40}$/;
// npm exits 1 both for a missing version and for a failed read; only its own status
// line marks absence, and it is matched as a whole line so a URL or error body that
// happens to carry the token cannot be read as "this version is not published".
const ABSENT_LINE = /^npm (?:ERR!|error) code E404\r?$/m;
const REASON_LIMIT = 300;
const ATTEMPTS = 5;

function bounded(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, REASON_LIMIT);
}

function transcript(result) {
  return [result?.stdout, result?.stderr, result?.error?.message].filter(Boolean).join('\n').trim();
}

/**
 * Reads one `npm view` result. `{ kind: 'absent' }` is returned only for a line of npm's
 * own `code E404` status *in a read that reported an exit status*; a bare "404" line, an
 * auth or network failure, a spawn failure, a missing exit status or unparseable output
 * are all `{ kind: 'error' }`. The exit status is checked first because a killed npm can
 * flush its status line and still never have completed: its transcript is a partial write,
 * and a partial write is not an answer.
 */
export function classifyViewOutcome(result) {
  if (result?.status === 0) {
    try {
      return { kind: 'metadata', metadata: JSON.parse(result.stdout ?? '') };
    } catch {
      return { kind: 'error', reason: 'npm returned non-JSON metadata for the published package.' };
    }
  }
  const output = transcript(result);
  if (result?.status === null || result?.status === undefined) {
    return {
      kind: 'error',
      reason: bounded(
        output === ''
          ? 'npm view did not report an exit status'
          : `npm view did not report an exit status: ${output}`,
      ),
    };
  }
  if (ABSENT_LINE.test(output)) return { kind: 'absent' };
  return {
    kind: 'error',
    reason: bounded(output === '' ? `npm view exited ${result?.status} with no message` : output),
  };
}

/**
 * Throws unless the registry metadata names `version`; when it also names a `gitHead`,
 * that must be a full lowercase 40-hex commit equal to the release commit. Returns the
 * values it checked, with `gitHead` undefined when the answer carried none, so a caller
 * prints the provenance it actually has. A body that is not an object — `null`, an array
 * — names no version, so it is refused as the version mismatch it is; a bare version
 * string is what `npm view` prints for a version with nothing else to report, and is
 * accepted at that version.
 */
export function verifyRegistryMetadata(metadata, expected) {
  const object = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata);
  const version = typeof metadata === 'string' ? metadata : object ? metadata.version : undefined;
  if (version !== expected.version) {
    throw new Error(
      `Registry version mismatch: expected ${expected.version}, received ${String(version)}.`,
    );
  }
  const gitHead = object ? metadata.gitHead : undefined;
  if (gitHead !== undefined) {
    if (typeof gitHead !== 'string' || !GIT_HEAD.test(gitHead)) {
      throw new Error(
        `The registry reports gitHead '${bounded(String(gitHead))}', which is not a full lowercase 40-hex commit.`,
      );
    }
    if (gitHead !== expected.head) {
      throw new Error(
        `Registry gitHead ${gitHead} does not match release commit ${expected.head}.`,
      );
    }
  }
  return { version, gitHead };
}

/**
 * The line printed for a verified version. Both verification points use it, so the
 * statement of what was proven cannot drift between them.
 */
function verifiedLine(spec, head, verified) {
  return verified.gitHead === undefined
    ? `Registry verified: ${spec}. The registry reports no gitHead for this version, so the ` +
        `published bytes are not tied to release commit ${head}. Version, not commit, was proven.\n`
    : `Registry verified: ${spec} at ${verified.gitHead}.\n`;
}

function defaultWait() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}

/**
 * The whole release decision, with its effects injected so a test can script every
 * registry answer. Returns the process exit code; it never exits or throws on an
 * expected failure. `npm(args, { inherit })` returns a `spawnSync`-shaped result.
 */
export function publishOrVerify(options) {
  const { spec, version, head, npm } = options;
  const out = options.out ?? (() => {});
  const err = options.err ?? (() => {});
  const wait = options.wait ?? defaultWait;
  const readSpec = ['view', spec, 'version', 'gitHead', '--json'];
  const expect = { version, head };

  const first = classifyViewOutcome(npm(readSpec));
  if (first.kind === 'error') {
    err(
      `Could not read ${spec} from the registry; refusing to treat that as version absence.\n${first.reason}\n`,
    );
    return 1;
  }
  if (first.kind === 'metadata') {
    let verified;
    try {
      verified = verifyRegistryMetadata(first.metadata, expect);
    } catch (error) {
      err(`${error.message}\n`);
      return 1;
    }
    out(verifiedLine(spec, head, verified));
    out('This exact version already exists on npm; refusing to republish it.\n');
    return 0;
  }

  out(`Publishing ${spec} through npm Trusted Publishing.\n`);
  const published = npm(['publish', '--access', 'public'], { inherit: true });
  if (published?.status !== 0) return published?.status ?? 1;

  let last = 'absent';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const next = classifyViewOutcome(npm(readSpec));
    if (next.kind === 'metadata') {
      let verified;
      try {
        verified = verifyRegistryMetadata(next.metadata, expect);
      } catch (error) {
        err(`${error.message}\n`);
        return 1;
      }
      out(verifiedLine(spec, head, verified));
      return 0;
    }
    last = next.kind;
    if (next.kind === 'error') err(`Read failed: ${next.reason}\n`);
    if (attempt < ATTEMPTS) wait();
  }

  err(
    `${spec} was published, but verification did not read it back. Last attempt: ${
      last === 'error' ? 'read failed' : 'reported absent'
    }. The version may already be live; re-run this helper to verify it rather than publish again.\n`,
  );
  return 1;
}
