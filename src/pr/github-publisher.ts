import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { githubApiRunner, type RunResult, type Runner } from '../core/runner.js';
import { sha256Hex } from '../security/digest.js';
import { isSafePathSegment, resolveInsideRoot } from '../security/path-safety.js';
import { describePatch, type PatchDescription, type PatchFileFact } from '../verify/patch.js';
import { REPOSITORY_HOST_PATTERN } from './branch.js';
import type {
  CreatePullRequestInput,
  PublicationRemote,
  PullRequestRef,
  PushedBranch,
  PushBranchInput,
} from './publisher.js';

/**
 * The real publication transport: GitHub's Git Data API, then a draft pull request.
 *
 * This is the only module in the product that writes to somebody else's repository,
 * so it is built around three refusals rather than three features.
 *
 * 1. **It sends the approved patch or nothing.** `pushBranch` re-measures the
 *    workspace with Stage 7's `describePatch` and compares the result to the patch
 *    identity carried by the request. A byte that moved after the human's yes is a
 *    different patch, and this module stops before the first network call. Each
 *    file's bytes are hashed again as they are read, because the measurement and
 *    the upload are two reads of a directory a run could still be writing.
 * 2. **It cannot move history.** The commit is created through the Git Data API on
 *    top of the recorded base SHA; there is no push, no force, no refspec and no
 *    update of an existing ref. `POST /git/refs` fails if the branch exists, and
 *    that failure is surfaced rather than retried with a different verb.
 * 3. **It opens a draft and only a draft.** The pull request body is a strict
 *    shape with `draft: true`; a response that says otherwise is an error naming
 *    the URL, not a success. Merge, auto-merge, reviewers and maintainer edits are
 *    fields this module never sends.
 * 4. **It reads back what it wrote.** Creating a ref is GitHub's word that the
 *    branch exists; it is not evidence that the branch points at the commit the
 *    request built, or that the commit's tree carries the approved paths, modes
 *    and blobs. After the ref is created this module reads the branch, the commit
 *    and the tree again and compares them to the request. The tree read projects
 *    only the paths that were sent, because the runner's output is bounded and a
 *    full recursive listing of a large repository is not; a patch that would need
 *    more projected reads than this transport permits is refused before any write.
 *    A read that fails, or a tree GitHub truncated, is reported as "the request was
 *    accepted but could not be verified" — inspection, never a success claim and
 *    never a retry that could collide with a branch the request created.
 *
 * Authentication is `gh`'s own. The runner preserves an environment-backed GitHub
 * login and strips model credentials, and no token is ever placed in an argument,
 * a request body or a URL. The JSON bodies travel through a private temporary file
 * because the runner has no stdin channel; the file is removed in `finally`.
 */

const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** GitHub's blob endpoint accepts larger, but a single-file patch this large is not a reviewable change. */
const MAX_FILE_BYTES = 40 * 1024 * 1024;
/** Keeps one `--jq` argument well inside a Windows command line. */
const TREE_FILTER_LIMIT = 3_000;
/** A patch this large is not reviewable, and every read-back re-lists the whole tree. */
const MAX_TREE_READS = 20;

export interface GitHubPublicationDeps {
  readonly run?: Runner;
  /**
   * Pins the transport to one host. Left unset, the transport goes wherever the
   * request's own `host` names — never to a default, because a page approved for
   * an enterprise host must not be sent to github.com by omission.
   */
  readonly host?: string;
  readonly now?: () => Date;
}

export function createGitHubPublicationRemote(deps: GitHubPublicationDeps = {}): PublicationRemote {
  return new GitHubPublicationRemote(deps);
}

class GitHubPublicationRemote implements PublicationRemote {
  private readonly run: Runner;
  private readonly pinnedHost: string | null;
  private readonly now: () => Date;

  constructor(deps: GitHubPublicationDeps) {
    this.run = deps.run ?? githubApiRunner;
    this.pinnedHost = deps.host ?? null;
    this.now = deps.now ?? (() => new Date());
    if (this.pinnedHost !== null && !REPOSITORY_HOST_PATTERN.test(this.pinnedHost)) {
      throw new AppError({
        kind: 'config',
        message: `Refusing to use '${bound(this.pinnedHost)}' as a GitHub host.`,
        remediation: 'A host is a name such as github.com or a GitHub Enterprise hostname.',
      });
    }
  }

  /**
   * The host this request is allowed to reach, decided before anything is read or
   * sent. Both refusals happen before the first `gh` invocation, so a page approved
   * for one host can never produce a request against another.
   */
  private destination(host: string): string {
    if (!REPOSITORY_HOST_PATTERN.test(host)) {
      throw new AppError({
        kind: 'validation',
        message:
          `Refusing to publish to '${bound(host)}': that is not a hostname a GitHub API ` +
          'request could name.',
        remediation:
          'Approve a page whose repository host was reported by intake; MergeSutra will not ' +
          'substitute a default host for one it cannot understand.',
        details: { host },
      });
    }
    if (this.pinnedHost !== null && host !== this.pinnedHost) {
      throw new AppError({
        kind: 'validation',
        message:
          `Refusing to publish to '${bound(host)}' through a transport pinned to the host ` +
          `'${bound(this.pinnedHost)}'.`,
        remediation:
          'Wire the transport for the host this page names, or approve a page for the pinned host.',
        details: { host, pinned: this.pinnedHost },
      });
    }
    return host;
  }

  async pushBranch(input: PushBranchInput): Promise<PushedBranch> {
    const host = this.destination(input.host);
    const { owner, name } = repositoryOf(input.repository);
    const patch = await describePatch({ workspace: input.directory, baseSha: input.baseSha });
    if (patch.identity !== input.patchIdentity) {
      throw new AppError({
        kind: 'validation',
        message:
          'Cannot publish: the workspace no longer holds the patch that was approved, so the ' +
          'page a human read no longer describes these bytes.',
        remediation:
          'Re-run `mergesutra pr` to measure and show the current patch, then approve its digest.',
        details: { approved: input.patchIdentity, measured: patch.identity },
      });
    }
    if (patch.files.length === 0) {
      throw new AppError({
        kind: 'validation',
        message: 'Cannot publish: the approved patch contains no changed files.',
        remediation: 'There is nothing to put on a branch, so there is no pull request to open.',
      });
    }

    const filters = treeFilters(patch.files.map((file) => file.path));
    if (filters.length > MAX_TREE_READS) {
      throw new AppError({
        kind: 'validation',
        message:
          `Cannot publish: this patch changes ${String(patch.files.length)} paths, which would ` +
          `need ${String(filters.length)} tree read-backs, beyond the ${String(MAX_TREE_READS)} ` +
          'this transport issues to verify a branch.',
        remediation:
          'Split the change into smaller approved patches, so each branch can be read back and ' +
          'compared in full before a draft is called opened.',
      });
    }

    const baseCommit = await this.api(
      host,
      'GET',
      `repos/${owner}/${name}/git/commits/${input.baseSha}`,
    );
    const baseTree = parseOf(baseCommit, baseCommitSchema, 'the base commit');
    const entries = await this.treeEntries(host, input.directory, patch, owner, name);

    const treeReply = await this.api(host, 'POST', `repos/${owner}/${name}/git/trees`, {
      base_tree: baseTree.tree.sha,
      tree: entries,
    });
    const tree = parseOf(treeReply, shaReplySchema, 'the new tree');

    const commitReply = await this.api(host, 'POST', `repos/${owner}/${name}/git/commits`, {
      message: `mergesutra: apply approved patch for ${input.runId}`,
      tree: tree.sha,
      parents: [input.baseSha],
    });
    const commit = parseOf(commitReply, shaReplySchema, 'the new commit');

    // From here the repository has accepted every write. The creation reply is
    // advisory only: the read-back below is what proves what GitHub stored.
    const refReply = await this.request(host, 'POST', `repos/${owner}/${name}/git/refs`, {
      ref: `refs/heads/${input.branch}`,
      sha: commit.sha,
    });

    await this.verifyPublished(
      input,
      owner,
      name,
      entries,
      tree.sha,
      commit.sha,
      refReply,
      filters,
    );
    return { branch: input.branch, commitSha: commit.sha };
  }

  /**
   * Re-read the branch, commit and tree after the write, and compare them to the
   * request. Every failure here happens after GitHub accepted the ref-creation
   * request, so the message says that plainly and the remediation is inspection
   * rather than a retry.
   */
  private async verifyPublished(
    input: PushBranchInput,
    owner: string,
    name: string,
    entries: readonly TreeEntry[],
    treeSha: string,
    commitSha: string,
    refReply: string,
    filters: readonly string[],
  ): Promise<void> {
    const prefix = `repos/${owner}/${name}`;
    try {
      const creation = parseCreationReply(refReply);
      if (creation !== undefined && creation.ref !== `refs/heads/${input.branch}`) {
        throw new Error(`the ref-creation reply names '${bound(creation.ref)}'`);
      }

      const ref = parseOf(
        await this.api(input.host, 'GET', `${prefix}/git/ref/heads/${input.branch}`),
        refReadSchema,
        'the created branch',
      );
      if (ref.ref !== `refs/heads/${input.branch}`) {
        throw new Error(`GitHub reports the ref '${bound(ref.ref)}'`);
      }
      if (ref.object.sha !== commitSha) {
        throw new Error(`the branch points at ${ref.object.sha}, not ${commitSha}`);
      }

      const commit = parseOf(
        await this.api(input.host, 'GET', `${prefix}/git/commits/${commitSha}`),
        commitReadSchema,
        'the created commit',
      );
      if (commit.sha !== commitSha) {
        throw new Error(`GitHub returned commit ${commit.sha}, not ${commitSha}`);
      }
      if (commit.tree.sha !== treeSha) {
        throw new Error(`the commit carries tree ${commit.tree.sha}, not ${treeSha}`);
      }
      const parents = commit.parents.map((parent) => parent.sha);
      if (parents.length !== 1 || parents[0] !== input.baseSha) {
        throw new Error(
          `the commit's parents are ${parents.join(', ') || 'none'}, not only ${input.baseSha}`,
        );
      }

      const remote = new Map<string, TreeReadEntry>();
      for (const filter of filters) {
        const tree = parseOf(
          await this.api(
            input.host,
            'GET',
            `${prefix}/git/trees/${treeSha}?recursive=1`,
            undefined,
            filter,
          ),
          treeReadSchema,
          'the created tree',
        );
        if (tree.sha !== treeSha) {
          throw new Error(`the tree read reports ${tree.sha}, not ${treeSha}`);
        }
        if (tree.truncated) {
          throw new Error('GitHub truncated the tree listing, so not every path was checked');
        }
        for (const entry of tree.tree) remote.set(entry.path, entry);
      }

      for (const entry of entries) {
        const stored = remote.get(entry.path);
        if (entry.sha === null) {
          if (stored !== undefined) {
            throw new Error(`'${entry.path}' was deleted by the patch but is still in the tree`);
          }
          continue;
        }
        if (stored === undefined) throw new Error(`'${entry.path}' is missing from the tree`);
        if (stored.type !== 'blob') {
          throw new Error(`'${entry.path}' is a ${stored.type}, not a blob`);
        }
        if (stored.sha !== entry.sha) {
          throw new Error(`'${entry.path}' holds blob ${stored.sha}, not ${entry.sha}`);
        }
        if (stored.mode !== entry.mode) {
          throw new Error(`'${entry.path}' has mode ${stored.mode}, not ${entry.mode}`);
        }
      }
    } catch (cause) {
      const reason = cause instanceof Error ? bound(cause.message) : 'an unknown read-back failure';
      throw new AppError({
        kind: 'invalid-response',
        retryable: false,
        message:
          `GitHub accepted the request to create branch '${input.branch}' at commit ${commitSha}, ` +
          `but MergeSutra could not verify what it stored: ${reason}.`,
        remediation:
          'Do not retry this command; inspect the branch and any pull request on GitHub, and ' +
          'decide what it should carry. MergeSutra will not move, force or delete a branch it ' +
          'created.',
        cause,
        details: { branch: input.branch, commitSha, reason },
      });
    }
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const host = this.destination(input.host);
    const { owner, name } = repositoryOf(input.repository);
    const reply = await this.api(host, 'POST', `repos/${owner}/${name}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: true,
    });
    const created = parseOf(reply, pullRequestReplySchema, 'the pull request');

    if (created.draft !== true) {
      throw new AppError({
        kind: 'invalid-response',
        message:
          `GitHub created ${created.html_url} but reported it is not a draft. MergeSutra opens ` +
          'drafts only, so this pull request needs a human now.',
        remediation:
          'Open the URL and convert the pull request to a draft, or close it. Do not merge it ' +
          'until you have read the page it carries.',
        details: { url: created.html_url, number: created.number, draft: false },
      });
    }

    return { url: created.html_url, number: created.number, draft: true };
  }

  /**
   * One tree entry per measured file, with deletions named explicitly.
   *
   * `sha: null` is GitHub's spelling for "remove this path from the base tree". A
   * file the patch added or modified is re-read here and hashed against the
   * measurement; the extra check is the only thing standing between a TOCTOU write
   * and a branch whose bytes the human never saw.
   */
  private async treeEntries(
    host: string,
    workspace: string,
    patch: PatchDescription,
    owner: string,
    name: string,
  ): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    for (const file of patch.files) {
      if (file.change === 'DELETED') {
        entries.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const measured = await this.readMeasured(workspace, file);
      const blob = await this.api(host, 'POST', `repos/${owner}/${name}/git/blobs`, {
        content: measured.content.toString('base64'),
        encoding: 'base64',
      });
      const blobSha = parseOf(blob, shaReplySchema, 'the new blob').sha;
      entries.push({ path: file.path, mode: measured.mode, type: 'blob', sha: blobSha });
    }
    return entries;
  }

  private async readMeasured(
    workspace: string,
    file: PatchFileFact,
  ): Promise<{ content: Buffer; mode: string }> {
    const absolute = resolveInsideRoot(workspace, file.path, 'patch file');
    const facts = await lstat(absolute);
    if (facts.isSymbolicLink()) {
      throw new AppError({
        kind: 'validation',
        message: `Cannot publish '${file.path}': it is a symbolic link, and GitHub would receive a regular file instead.`,
        remediation:
          'Remove the link from the patch, or publish a patch that changes regular files only.',
      });
    }
    if (!facts.isFile()) {
      throw new AppError({
        kind: 'validation',
        message: `Cannot publish '${file.path}': it is not a regular file.`,
        remediation: 'Publish a patch that changes regular files only.',
      });
    }
    if (facts.size > MAX_FILE_BYTES) {
      throw new AppError({
        kind: 'validation',
        message: `Cannot publish '${file.path}': ${String(facts.size)} bytes is beyond the reviewable limit.`,
        remediation:
          'Split the change, or publish large assets through a human-controlled process.',
      });
    }
    const content = await readFile(absolute);
    if (sha256Hex(content) !== file.contentSha256) {
      throw new AppError({
        kind: 'validation',
        message: `Cannot publish '${file.path}': it changed between measurement and upload.`,
        remediation:
          'Re-run `mergesutra pr` so a person reads the page for the bytes that are here now.',
      });
    }
    return { content, mode: (facts.mode & 0o111) === 0 ? '100644' : '100755' };
  }

  private async request(
    host: string,
    method: 'GET' | 'POST',
    endpoint: string,
    payload?: unknown,
    jq?: string,
  ): Promise<string> {
    const args = ['api', '--hostname', host, '--method', method];
    let cleanup: (() => Promise<void>) | null = null;
    if (payload !== undefined) {
      const written = await writePayload(payload);
      cleanup = written.cleanup;
      args.push('--input', written.file);
    }
    if (jq !== undefined) args.push('--jq', jq);
    args.push(endpoint);

    let result: RunResult;
    try {
      result = await this.run('gh', args);
    } finally {
      if (cleanup !== null) await cleanup();
    }

    if (result.code !== 0) throw this.failure(result, endpoint);
    return result.stdout.trim();
  }

  private async api(
    host: string,
    method: 'GET' | 'POST',
    endpoint: string,
    payload?: unknown,
    jq?: string,
  ): Promise<unknown> {
    const text = await this.request(host, method, endpoint, payload, jq);
    if (text.length === 0) {
      throw new AppError({
        kind: 'invalid-response',
        message: 'GitHub returned an empty response body.',
        remediation: 'Retry, or check GitHub status and your network connection.',
        details: { endpoint },
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new AppError({
        kind: 'invalid-response',
        message: 'GitHub returned a response that is not JSON.',
        retryable: false,
        cause,
        details: { endpoint, sample: bound(text) },
        remediation: 'This usually means an intermediary intercepted the request.',
      });
    }
  }

  private failure(result: RunResult, endpoint: string): AppError {
    const text = bound(`${result.stderr}\n${result.stdout}`);
    const lower = text.toLowerCase();
    const status = /http (\d{3})/.exec(lower)?.[1] ?? /(\d{3}) status/.exec(lower)?.[1];
    const parsedStatus = status ? Number.parseInt(status, 10) : undefined;

    if (/enoent|not recognized|command not found|can't find gh/.test(lower)) {
      return new AppError({
        kind: 'config',
        message: 'GitHub CLI (gh) is not available on PATH, so no draft can be opened.',
        remediation:
          'Install the GitHub CLI and run `gh auth login`. MergeSutra never accepts tokens as arguments.',
        details: { endpoint, exitCode: result.code },
      });
    }
    if (
      lower.includes('not logged in') ||
      lower.includes('gh auth login') ||
      lower.includes('authentication')
    ) {
      return new AppError({
        kind: 'auth',
        message: 'GitHub refused the request because gh is not authenticated.',
        retryable: false,
        status: parsedStatus,
        remediation: 'Run `gh auth login`, then retry the same approved command.',
        details: { endpoint, output: text },
      });
    }
    if (lower.includes('rate limit')) {
      return new AppError({
        kind: 'rate-limit',
        // "Nothing was opened" would be a claim about the repository, and a limit can
        // only be described by what it did to this request: the objects already
        // uploaded for a branch stay uploaded, and a draft refused here may still be
        // owed to a retry.
        message: 'GitHub rate limited this request.',
        retryable: true,
        status: parsedStatus ?? 403,
        remediation: 'Wait for the limit to reset, then retry the same approved command.',
        details: { endpoint, output: text },
      });
    }
    if (parsedStatus === 422 && lower.includes('already exists')) {
      // GitHub answers both writes with a 422 and the same phrase, so which request was
      // refused is only knowable from the endpoint this failure came from. Naming the
      // other one would tell a person a write failed that in fact succeeded.
      const draftRequest = endpoint.endsWith('/pulls');
      return new AppError({
        kind: 'validation',
        message: draftRequest
          ? 'GitHub refused to open the draft because a pull request already exists for that branch and target. ' +
            'MergeSutra does not close, reopen or replace another pull request.'
          : 'GitHub refused to create the branch because a branch with that name already exists. ' +
            'MergeSutra does not move or overwrite existing branches.',
        remediation: draftRequest
          ? 'Inspect the existing pull request on GitHub — converting it, adding to it or closing it ' +
            'all happen there. MergeSutra will not touch a pull request it did not open.'
          : "Inspect the existing branch. If it is not this run's, delete it yourself or choose a " +
            'fresh workspace branch; MergeSutra will not force the name.',
        details: { endpoint, output: text },
      });
    }
    if (parsedStatus === 404 || lower.includes('not found')) {
      return new AppError({
        kind: 'not-found',
        message: 'GitHub returned not-found for the repository or issue this request named.',
        retryable: false,
        status: 404,
        remediation: 'Check the repository name and that gh is logged in to the right host.',
        details: { endpoint, output: text },
      });
    }
    return new AppError({
      kind: 'invalid-response',
      message: `GitHub refused the ${endpoint.split('/').at(-1) ?? 'request'} (exit ${String(result.code)}).`,
      retryable: parsedStatus === undefined || parsedStatus >= 500,
      status: parsedStatus,
      remediation:
        'Read the output above, check `gh auth status`, and retry only if nothing was created.',
      details: { endpoint, output: text },
    });
  }
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob';
  readonly sha: string | null;
}

interface TreeReadEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

const baseCommitSchema = z
  .object({ tree: z.object({ sha: z.string().regex(SHA_PATTERN) }) })
  .passthrough();
const shaReplySchema = z.object({ sha: z.string().regex(SHA_PATTERN) }).passthrough();
const refReplySchema = z.object({ ref: z.string().min(1) }).passthrough();
const refReadSchema = z
  .object({
    ref: z.string().regex(/^refs\/heads\/.+$/),
    object: z
      .object({ sha: z.string().regex(SHA_PATTERN), type: z.literal('commit') })
      .passthrough(),
  })
  .passthrough();
const commitReadSchema = z
  .object({
    sha: z.string().regex(SHA_PATTERN),
    tree: z.object({ sha: z.string().regex(SHA_PATTERN) }).passthrough(),
    parents: z.array(z.object({ sha: z.string().regex(SHA_PATTERN) }).passthrough()),
  })
  .passthrough();
const treeReadSchema = z
  .object({
    sha: z.string().regex(SHA_PATTERN),
    truncated: z.boolean(),
    tree: z.array(
      z
        .object({
          path: z.string().min(1),
          mode: z.string().min(1),
          type: z.string().min(1),
          sha: z.string().regex(SHA_PATTERN),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const pullRequestReplySchema = z
  .object({
    html_url: z.string().regex(/^https:\/\/[^\s]+$/),
    number: z.number().int().positive(),
    draft: z.boolean(),
  })
  .passthrough();

function parseOf<T>(value: unknown, schema: z.ZodType<T>, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'invalid-response',
      message: `GitHub did not return the expected shape for ${label}: ${issue?.path.join('.') ?? 'document'}: ${issue?.message ?? 'invalid'}.`,
      remediation: 'Retry once; if it persists, inspect the repository before publishing again.',
      details: { label },
    });
  }
  return parsed.data;
}

function treeProgram(selectors: string): string {
  return `{sha: .sha, truncated: .truncated, tree: [.tree[] | select(${selectors})]}`;
}

/** The program's fixed text, charged into every group's budget. */
const TREE_FILTER_OVERHEAD = treeProgram('').length;

/**
 * One `--jq` program per group of paths, so a filtered tree read stays inside the
 * runner's 1 MiB output bound however large the repository is. Paths enter as JSON
 * strings, which are also valid jq string literals, so a quote or a backslash in a
 * filename stays data instead of becoming jq syntax. Each group's fixed wrapper is
 * charged against the same limit; a single path longer than the budget is kept in a
 * group of its own, because a filename cannot be split.
 */
function treeFilters(paths: readonly string[]): string[] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = TREE_FILTER_OVERHEAD;
  for (const file of new Set(paths)) {
    const addition = JSON.stringify(file).length + ' or .path == '.length;
    if (current.length > 0 && size + addition > TREE_FILTER_LIMIT) {
      groups.push(current);
      current = [];
      size = TREE_FILTER_OVERHEAD;
    }
    current.push(file);
    size += addition;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) =>
    treeProgram(group.map((file) => `.path == ${JSON.stringify(file)}`).join(' or ')),
  );
}

/**
 * The creation reply is advisory. The read-back below is what proves the branch,
 * so an empty or unreadable body is not a reason to fail a write that succeeded;
 * a readable body that names another branch is.
 */
function parseCreationReply(text: string): { ref: string } | undefined {
  if (text.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const reply = refReplySchema.safeParse(parsed);
  return reply.success ? { ref: reply.data.ref } : undefined;
}

function repositoryOf(repository: string): { owner: string; name: string } {
  const match = REPOSITORY_PATTERN.exec(repository);
  if (match === null || !isSafePathSegment(match[1] ?? '') || !isSafePathSegment(match[2] ?? '')) {
    throw new AppError({
      kind: 'validation',
      message: `Refusing to use '${bound(repository)}' as a GitHub repository.`,
      remediation: 'A publication candidate names its repository as owner/name.',
    });
  }
  return { owner: match[1] ?? '', name: match[2] ?? '' };
}

async function writePayload(
  payload: unknown,
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mergesutra-gh-'));
  const file = path.join(dir, 'request.json');
  try {
    await writeFile(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    file,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 200 ? oneLine : `${oneLine.slice(0, 197)}...`;
}
