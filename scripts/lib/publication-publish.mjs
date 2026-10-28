import path from 'node:path';
import {
  applyPatch,
  assertApprovedDigest,
  readPublicationBundle,
  stageRunStore,
} from './publication-bundle.mjs';

/**
 * The write side of a portable publication, run by a workflow that holds a
 * write-scoped GitHub token and never the model credential.
 *
 * The order is the security argument. The typed digest is checked against the
 * bundle before anything is prepared; the record and pack are staged where the
 * product's `pr` stage will read them; the patch bytes are applied to a fresh
 * worktree; the product re-measures that worktree and this runner refuses if the
 * identity moved; only then is the transport called. `publish` is the product's own
 * `pr --approve <digest> --publish`, which repeats the approval decision, the
 * patch measurement and the per-file hash at upload — this module does not send
 * GitHub a request of its own.
 *
 * A refusal is not a failure: it means the artifact and the request disagreed and
 * nothing was sent. A failure means the transport was reached and did not report a
 * draft; the caller must inspect the remote before deciding what to do, because a
 * partial write is possible and the product's own screen carries the remediation.
 */

export async function runPublication(input) {
  const { bundleDir, approval, rootDir, workRoot, deps } = input;
  if (
    typeof deps?.prepareWorktree !== 'function' ||
    typeof deps?.measure !== 'function' ||
    typeof deps?.publish !== 'function'
  ) {
    throw new Error('runPublication needs prepareWorktree, measure and publish dependencies.');
  }
  if (typeof rootDir !== 'string' || typeof workRoot !== 'string') {
    throw new Error('runPublication needs a rootDir and a workRoot.');
  }
  const root = path.resolve(rootDir);
  const work = path.resolve(workRoot);

  const bundle = await readPublicationBundle(bundleDir);
  let digest;
  try {
    digest = assertApprovedDigest(bundle.identity, approval);
  } catch (error) {
    return { status: 'REFUSED', reason: messageOf(error), bundle };
  }

  // The product's `pr` stage reads its store from the process working directory,
  // so the workflow runs the CLI with this root as its cwd.
  const staged = await stageRunStore(path.join(root, '.mergesutra', 'runs'), bundle);

  const prepared = await deps.prepareWorktree({
    repository: bundle.identity.repository,
    baseSha: bundle.identity.baseSha,
    runId: bundle.identity.runId,
    workRoot: work,
  });
  await applyPatch(prepared.worktreeDir, bundle.patch);
  const measured = await deps.measure({
    repositoryDir: prepared.repositoryDir,
    worktreeDir: prepared.worktreeDir,
    baseSha: bundle.identity.baseSha,
  });
  if (measured?.identity !== bundle.identity.patchIdentity) {
    return {
      status: 'REFUSED',
      reason:
        `The reconstruction does not hold the patch this bundle was built for ` +
        `(approved patch ${bundle.identity.patchIdentity.slice(0, 12)}…, measured ` +
        `${String(measured?.identity).slice(0, 12)}…), so nothing was sent.`,
      bundle,
      measuredIdentity: measured?.identity ?? null,
    };
  }

  const reply = await deps.publish({
    bundle,
    rootDir: root,
    repositoryDir: prepared.repositoryDir,
    worktreeDir: prepared.worktreeDir,
    runId: bundle.identity.runId,
    approval: digest,
  });
  if (reply?.exitCode === 3) {
    // Exit 3 is the product's "shown or approved, nothing published" word. With
    // `--publish` on the command line an attempted and failed transport is exit 4,
    // so this branch never describes a partial remote write.
    return {
      status: 'REFUSED',
      reason:
        'The publication command exited 3 without opening a draft, so this invocation ' +
        'sent nothing; read its output before dispatching again.',
      exitCode: 3,
      stderr: bound(reply?.stderr ?? ''),
      bundle,
    };
  }
  if (reply?.exitCode !== 0) {
    return {
      status: 'FAILED',
      reason:
        `The publication command exited ${String(reply?.exitCode)}; inspect the remote before ` +
        'deciding what to do.',
      exitCode: reply?.exitCode ?? null,
      stderr: bound(reply?.stderr ?? ''),
      bundle,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(reply.stdout ?? '').trim());
  } catch {
    return {
      status: 'FAILED',
      reason: 'The publication command did not report JSON, so no draft can be confirmed.',
      bundle,
    };
  }
  const publication = parsed?.publication;
  if (
    parsed?.published !== true ||
    publication?.draft !== true ||
    typeof publication?.url !== 'string' ||
    !/^https:\/\/[^\s]+$/.test(publication.url)
  ) {
    return {
      status: 'FAILED',
      reason:
        `The publication command reported '${String(parsed?.outcome)}' ` +
        `and ${parsed?.published === true ? 'a page GitHub did not confirm as a draft' : 'no opened draft'}; ` +
        'inspect the remote before deciding what to do.',
      outcome: parsed?.outcome ?? null,
      bundle,
    };
  }
  return {
    status: 'PUBLISHED',
    url: publication.url,
    number: publication.number ?? null,
    branch: publication.branch ?? null,
    commitSha: publication.commitSha ?? null,
    outcome: parsed.outcome,
    recordFile: staged.record,
    bundle,
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function bound(text) {
  const oneLine = String(text).replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 397)}...`;
}
