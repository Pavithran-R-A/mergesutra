import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubPublicationRemote } from '../../src/pr/github-publisher.js';
import type { RunResult, Runner } from '../../src/core/runner.js';
import type { PushBranchInput } from '../../src/pr/publisher.js';
import { describePatch } from '../../src/verify/patch.js';
import { sha256Hex } from '../../src/security/digest.js';
import { cleanUp, hasGit, implementedRun, put } from '../helpers/verifyRun.js';

/**
 * The one transport that writes to GitHub, exercised without a network.
 *
 * Two properties are the whole reason this module exists in a product whose
 * approval boundary used to be "there are no hands": the bytes it sends are the
 * bytes the human approved, and the only thing it can ask GitHub to create is a
 * *draft* pull request. Both are measured here against a real Git workspace and a
 * scripted `gh`, so neither is a claim about the transport's intentions.
 *
 * The scripted runner records every argv. That is how the credential rule is
 * checked: `gh` owns the login, so no token appears in an argument, an environment
 * variable this module passes, or a request body. It is also how the draft rule is
 * checked at the wire — the request body has `draft: true` and no merge field.
 */

const AVAILABLE = await hasGit();
const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

const REPOSITORY = 'projectbharat/datekit';
const HOST = 'github.com';

interface Call {
  readonly method: string;
  readonly endpoint: string;
  readonly args: readonly string[];
  readonly payload: unknown;
}

interface Scripted {
  readonly run: Runner;
  readonly calls: Call[];
  /** Responses by `METHOD endpoint`; a missing entry is a test bug. */
  readonly replies: Map<string, RunResult | (() => RunResult)>;
}

function scriptedGitHub(): Scripted {
  const calls: Call[] = [];
  const replies = new Map<string, RunResult | (() => RunResult)>();
  const run: Runner = async (file, args) => {
    if (file !== 'gh') throw new Error(`unexpected executable ${file}`);
    const method = args[args.indexOf('--method') + 1] ?? '';
    const endpoint = args[args.length - 1] ?? '';
    let payload: unknown = null;
    const inputAt = args.indexOf('--input');
    if (inputAt >= 0) {
      payload = JSON.parse(readFileSync(args[inputAt + 1] ?? '', 'utf8')) as unknown;
    }
    calls.push({ method, endpoint, args: [...args], payload });
    const reply = replies.get(`${method} ${endpoint}`);
    if (reply === undefined) {
      throw new Error(
        `no scripted reply for ${method} ${endpoint}; calls: ${calls.map((c) => `${c.method} ${c.endpoint}`).join(', ')}`,
      );
    }
    return typeof reply === 'function' ? reply() : reply;
  };
  return { run, calls, replies };
}

function ok(body: unknown): RunResult {
  return { code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false, truncated: false };
}

function fail(stderr: string, code = 1): RunResult {
  return { code, stdout: '', stderr, timedOut: false, truncated: false };
}

async function inputFor(directory: string, baseSha: string): Promise<PushBranchInput> {
  const patch = await describePatch({ workspace: directory, baseSha });
  return {
    directory,
    host: HOST,
    repository: REPOSITORY,
    branch: 'mergesutra/run-20261020T000000Z-abc123',
    baseSha,
    patchIdentity: patch.identity,
    runId: 'run-20261020T000000Z-abc123',
  };
}

const READ_BACK_TREE = `GET repos/${REPOSITORY}/git/trees/${'c'.repeat(40)}?recursive=1`;

interface SentEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string | null;
}

function sentEntries(scripted: Scripted): SentEntry[] {
  const tree = scripted.calls.find((call) => call.endpoint.endsWith('/git/trees'))?.payload as
    { tree: SentEntry[] } | undefined;
  return tree?.tree ?? [];
}

function treeReadCalls(scripted: Scripted): Call[] {
  return scripted.calls.filter((call) => call.endpoint.includes('/git/trees/'));
}

function jqPrograms(calls: readonly Call[]): string[] {
  return calls.map((call) => {
    const at = call.args.indexOf('--jq');
    return at >= 0 ? (call.args[at + 1] ?? '') : '';
  });
}

/** The path literals a filter program sends to jq, decoded back to strings. */
function filtersOf(programs: readonly string[]): string[] {
  return programs.flatMap((program) =>
    [...program.matchAll(/\.path == ("(?:[^"\\]|\\.)*")/g)].map(
      (match) => JSON.parse(match[1] ?? '""') as string,
    ),
  );
}

/**
 * The projection the current tree read asked GitHub to apply. The scripted
 * runner is the only jq in this test, so a reply that ignores the program would
 * let a chunk-merge defect pass; this makes each reply carry only its own paths,
 * as GitHub would.
 */
function currentFilters(scripted: Scripted): string[] | undefined {
  const call = scripted.calls.at(-1);
  if (call === undefined || !call.endpoint.includes('/git/trees/')) return undefined;
  return filtersOf(jqPrograms([call]));
}

async function putMany(workspace: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, '0');
    await put(workspace, `src/generated-${suffix}/file-${suffix}.txt`, `value ${suffix}\n`);
  }
}

function scriptHappyPath(scripted: Scripted, baseSha: string, branch: string): void {
  scripted.replies.set(
    `GET repos/${REPOSITORY}/git/commits/${baseSha}`,
    ok({ sha: baseSha, tree: { sha: 'a'.repeat(40) } }),
  );
  let blob = 0;
  scripted.replies.set(`POST repos/${REPOSITORY}/git/blobs`, () =>
    ok({ sha: String(++blob).padStart(40, 'b') }),
  );
  scripted.replies.set(`POST repos/${REPOSITORY}/git/trees`, ok({ sha: 'c'.repeat(40) }));
  scripted.replies.set(`POST repos/${REPOSITORY}/git/commits`, ok({ sha: 'd'.repeat(40) }));
  scripted.replies.set(
    `POST repos/${REPOSITORY}/git/refs`,
    ok({ ref: `refs/heads/${branch}`, object: { sha: 'd'.repeat(40) } }),
  );
  scripted.replies.set(
    `GET repos/${REPOSITORY}/git/ref/heads/${branch}`,
    ok({ ref: `refs/heads/${branch}`, object: { sha: 'd'.repeat(40), type: 'commit' } }),
  );
  scripted.replies.set(
    `GET repos/${REPOSITORY}/git/commits/${'d'.repeat(40)}`,
    ok({
      sha: 'd'.repeat(40),
      tree: { sha: 'c'.repeat(40) },
      parents: [{ sha: baseSha }],
    }),
  );
  scripted.replies.set(READ_BACK_TREE, () => {
    const sent = sentEntries(scripted).filter((entry) => entry.sha !== null);
    const wanted = currentFilters(scripted);
    return ok({
      sha: 'c'.repeat(40),
      truncated: false,
      tree: wanted === undefined ? sent : sent.filter((entry) => wanted.includes(entry.path)),
    });
  });
  scripted.replies.set(
    `POST repos/${REPOSITORY}/pulls`,
    ok({
      html_url: `https://github.com/${REPOSITORY}/pull/7`,
      number: 7,
      draft: true,
      state: 'open',
    }),
  );
}

async function refusalOf(promise: Promise<unknown>): Promise<{
  message: string;
  remediation?: string;
  kind?: string;
  retryable?: boolean;
}> {
  try {
    await promise;
  } catch (error) {
    return error as {
      message: string;
      remediation?: string;
      kind?: string;
      retryable?: boolean;
    };
  }
  throw new Error('expected the transport to refuse');
}

describe.skipIf(!AVAILABLE)('the GitHub draft-pull-request transport', () => {
  it('sends the measured patch as blobs over the approved base, then one draft pull request', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const patch = await describePatch({ workspace: fixture.repoDir, baseSha: fixture.base });
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const pushed = await remote.pushBranch(input);
    const pushEndpoints = scripted.calls.map((call) => `${call.method} ${call.endpoint}`);
    const created = await remote.createPullRequest({
      host: HOST,
      repository: REPOSITORY,
      title: 'Parser accepts invalid empty dates',
      body: '## Summary\n\nBody.\n',
      head: input.branch,
      base: 'main',
    });

    expect(pushed).toEqual({ branch: input.branch, commitSha: 'd'.repeat(40) });
    expect(created).toEqual({
      url: `https://github.com/${REPOSITORY}/pull/7`,
      number: 7,
      draft: true,
    });

    const endpoints = scripted.calls.map((call) => `${call.method} ${call.endpoint}`);
    expect(endpoints[0]).toBe(`GET repos/${REPOSITORY}/git/commits/${fixture.base}`);
    // One blob per changed file, then the tree, the commit and the ref.
    expect(endpoints.filter((entry) => entry.endsWith('/git/blobs'))).toHaveLength(
      patch.files.length,
    );
    // The writes come first; the three reads that prove them follow the ref.
    expect(
      endpoints.filter((entry) => entry.startsWith('POST ') && !entry.endsWith('/pulls')).slice(-3),
    ).toEqual([
      `POST repos/${REPOSITORY}/git/trees`,
      `POST repos/${REPOSITORY}/git/commits`,
      `POST repos/${REPOSITORY}/git/refs`,
    ]);
    expect(pushEndpoints.slice(-3)).toEqual([
      `GET repos/${REPOSITORY}/git/ref/heads/${input.branch}`,
      `GET repos/${REPOSITORY}/git/commits/${'d'.repeat(40)}`,
      `GET repos/${REPOSITORY}/git/trees/${'c'.repeat(40)}?recursive=1`,
    ]);
    expect(endpoints.at(-1)).toBe(`POST repos/${REPOSITORY}/pulls`);

    // The tree read is projected through one `--jq` argument naming exactly the
    // sent paths; the scripted runner returns the whole tree, so this asserts the
    // request shape the real gh would execute.
    const treeReads = treeReadCalls(scripted);
    expect(treeReads).toHaveLength(1);
    const program = jqPrograms(treeReads)[0] ?? '';
    expect(treeReads[0]?.args.indexOf('--jq')).toBe((treeReads[0]?.args.length ?? 0) - 3);
    expect(program).toContain('truncated: .truncated');
    expect(program).not.toContain('\n');
    expect(program.length).toBeLessThanOrEqual(3000);
    expect(filtersOf([program]).sort()).toEqual(patch.files.map((file) => file.path).sort());

    const blobs = scripted.calls.filter((call) => call.endpoint.endsWith('/git/blobs'));
    const sent = blobs.map((call) =>
      Buffer.from((call.payload as { content: string }).content, 'base64').toString('utf8'),
    );
    expect(sent).toContain(
      'export function parseDate(i: string): Date {\n  if (!i) throw new Error("empty");\n  return new Date(i);\n}\n',
    );

    const tree = scripted.calls.find((call) => call.endpoint.endsWith('/git/trees'))?.payload as {
      base_tree: string;
      tree: { path: string; mode: string; type: string; sha: string | null }[];
    };
    expect(tree.base_tree).toBe('a'.repeat(40));
    expect(tree.tree.map((entry) => entry.path).sort()).toEqual(
      patch.files.map((file) => file.path),
    );
    expect(tree.tree.every((entry) => entry.type === 'blob' && entry.mode === '100644')).toBe(true);

    // Each tree entry must point at the blob reply for its own file. The
    // read-back cannot catch a swapped mapping, because GitHub would store what
    // the request sent; only an assertion against the measured patch can.
    const treeByPath = new Map(tree.tree.map((entry) => [entry.path, entry]));
    // Keyed by digest with a per-digest cursor, so two files whose bytes are identical
    // still have both of their tree entries asserted rather than the first file twice.
    expect(patch.files.filter((file) => file.contentSha256 === null)).toEqual([]);
    const pathsByDigest = new Map<string, string[]>();
    for (const file of patch.files) {
      const digest = file.contentSha256;
      if (digest === null) continue;
      const paths = pathsByDigest.get(digest) ?? [];
      paths.push(file.path);
      pathsByDigest.set(digest, paths);
    }
    const matched = new Map<string, number>();
    blobs.forEach((call, index) => {
      const content = Buffer.from((call.payload as { content: string }).content, 'base64');
      const digest = sha256Hex(content);
      const used = matched.get(digest) ?? 0;
      matched.set(digest, used + 1);
      const path = (pathsByDigest.get(digest) ?? [])[used];
      expect(path, `no measured file for blob ${String(index)}`).toBeDefined();
      expect(treeByPath.get(path ?? '')?.sha).toBe(String(index + 1).padStart(40, 'b'));
    });

    const commit = scripted.calls.find((call) => call.endpoint.endsWith('/git/commits'))
      ?.payload as {
      message: string;
      tree: string;
      parents: string[];
    };
    expect(commit.parents).toEqual([fixture.base]);
    expect(commit.tree).toBe('c'.repeat(40));
    expect(commit.message).toContain(input.runId);

    const ref = scripted.calls.find((call) => call.endpoint.endsWith('/git/refs'))?.payload as {
      ref: string;
      sha: string;
    };
    expect(ref).toEqual({ ref: `refs/heads/${input.branch}`, sha: 'd'.repeat(40) });

    const pulls = scripted.calls.find((call) => call.endpoint.endsWith('/pulls'))
      ?.payload as Record<string, unknown>;
    expect(pulls).toEqual({
      title: 'Parser accepts invalid empty dates',
      body: '## Summary\n\nBody.\n',
      head: input.branch,
      base: 'main',
      draft: true,
    });
    expect(pulls).not.toHaveProperty('merge');
    expect(pulls).not.toHaveProperty('auto_merge');
    expect(pulls).not.toHaveProperty('reviewers');
  });

  it('names a deletion in the tree rather than leaving the file behind', async () => {
    const fixture = await implementedRun(tempDirs);
    await rm(path.join(fixture.repoDir, 'README.md'));
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await remote.pushBranch(input);

    const tree = scripted.calls.find((call) => call.endpoint.endsWith('/git/trees'))?.payload as {
      tree: { path: string; sha: string | null }[];
    };
    expect(tree.tree).toContainEqual({
      path: 'README.md',
      mode: '100644',
      type: 'blob',
      sha: null,
    });
  });

  it('refuses to send bytes that are no longer the approved patch, before any write', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    await put(
      fixture.repoDir,
      'src/parse.ts',
      'export function parseDate(): Date {\n  return new Date();\n}\n',
    );
    const scripted = scriptedGitHub();
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await expect(remote.pushBranch(input)).rejects.toThrow(/no longer|changed|approved patch/i);
    expect(scripted.calls).toEqual([]);
  });

  it('refuses when the branch already exists, and opens no pull request on top', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `POST repos/${REPOSITORY}/git/refs`,
      fail('HTTP 422: Reference already exists'),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await expect(remote.pushBranch(input)).rejects.toThrow(/already exists|exist/i);
    expect(scripted.calls.some((call) => call.endpoint.endsWith('/pulls'))).toBe(false);
  });

  it('refuses to report a pull request GitHub did not create as a draft', async () => {
    const scripted = scriptedGitHub();
    scripted.replies.set(
      `POST repos/${REPOSITORY}/pulls`,
      ok({
        html_url: `https://github.com/${REPOSITORY}/pull/7`,
        number: 7,
        draft: false,
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await expect(
      remote.createPullRequest({
        host: HOST,
        repository: REPOSITORY,
        title: 'Parser accepts invalid empty dates',
        body: 'Body.\n',
        head: 'mergesutra/run-1',
        base: 'main',
      }),
    ).rejects.toThrow(/not a draft|draft/i);
  });

  it('refuses a response that is not a GitHub pull request URL', async () => {
    const scripted = scriptedGitHub();
    scripted.replies.set(
      `POST repos/${REPOSITORY}/pulls`,
      ok({
        html_url: 'file:///etc/passwd',
        number: 7,
        draft: true,
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await expect(
      remote.createPullRequest({
        host: HOST,
        repository: REPOSITORY,
        title: 'Parser accepts invalid empty dates',
        body: 'Body.\n',
        head: 'mergesutra/run-1',
        base: 'main',
      }),
    ).rejects.toThrow(/URL|url/i);
  });

  it('claims only what a rate limit can prove, and keeps the retry it is owed before a branch', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `POST repos/${REPOSITORY}/git/refs`,
      fail('gh: HTTP 403 API rate limit exceeded for user ID 1'),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));

    expect(refusal.kind).toBe('rate-limit');
    // The blobs, tree and commit this request uploaded are objects GitHub kept, so a
    // rate limit can only be described by what it did to the request.
    expect(refusal.message).not.toMatch(/nothing was opened|nothing was created|no change/i);
    // No branch exists yet, so the same approved command is still the way to go on —
    // the advice the post-branch composition has to remove, and this one must not.
    expect(refusal.remediation).toMatch(/wait for the limit to reset, then retry/i);
    expect(refusal.message).not.toContain(input.branch);
  });

  it('never puts a credential in an argument and never uses a mutating verb beyond the five Git Data writes', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    const remote = createGitHubPublicationRemote({ run: scripted.run });
    await remote.pushBranch(input);

    for (const call of scripted.calls) {
      expect(call.args[0]).toBe('api');
      expect(call.args).toContain('--hostname');
      expect(call.args.join(' ')).not.toMatch(/authorization|token|bearer|secret/i);
      expect(call.args).not.toContain('--force');
      expect(call.args).not.toContain('-f');
    }
    // Four reads: the base commit, then the created ref, commit and tree that
    // prove what GitHub stored. The five writes are two blobs, one tree, one
    // commit and one ref; the draft pull request is created by a separate call.
    expect(scripted.calls.filter((call) => call.method === 'GET')).toHaveLength(4);
    expect(scripted.calls.filter((call) => call.method === 'POST')).toHaveLength(5);
    expect(scripted.calls.every((call) => call.args.includes('--hostname'))).toBe(true);
    expect(scripted.calls.every((call) => call.args.includes(HOST))).toBe(true);
  });

  it('refuses a branch read back at a different commit, and says the branch now exists', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `GET repos/${REPOSITORY}/git/ref/heads/${input.branch}`,
      ok({ ref: `refs/heads/${input.branch}`, object: { sha: 'e'.repeat(40), type: 'commit' } }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain(input.branch);
    expect(refusal.message).toContain('d'.repeat(40));
    expect(refusal.remediation).toMatch(/inspect the branch/i);
  });

  it('refuses a read-back commit whose parent is not the approved base', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `GET repos/${REPOSITORY}/git/commits/${'d'.repeat(40)}`,
      ok({
        sha: 'd'.repeat(40),
        tree: { sha: 'c'.repeat(40) },
        parents: [{ sha: 'e'.repeat(40) }],
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toMatch(/parent/i);
  });

  it('refuses a read-back commit that points at a different tree', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `GET repos/${REPOSITORY}/git/commits/${'d'.repeat(40)}`,
      ok({
        sha: 'd'.repeat(40),
        tree: { sha: 'e'.repeat(40) },
        parents: [{ sha: fixture.base }],
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toMatch(/tree/i);
  });

  it('refuses a tree read that omits a path the request sent', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    let omitted = '';
    scripted.replies.set(READ_BACK_TREE, () => {
      const entries = sentEntries(scripted).filter((entry) => entry.sha !== null);
      omitted = entries[0]?.path ?? '';
      return ok({ sha: 'c'.repeat(40), truncated: false, tree: entries.slice(1) });
    });
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain(omitted);
  });

  it('refuses a tree entry whose blob is not the one the request uploaded', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    let altered = '';
    scripted.replies.set(READ_BACK_TREE, () => {
      const entries = sentEntries(scripted).filter((entry) => entry.sha !== null);
      altered = entries[0]?.path ?? '';
      return ok({
        sha: 'c'.repeat(40),
        truncated: false,
        tree: entries.map((entry, index) =>
          index === 0 ? { ...entry, sha: 'e'.repeat(40) } : entry,
        ),
      });
    });
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain(altered);
    expect(refusal.message).toMatch(/blob/i);
  });

  it('refuses a tree entry whose recorded mode differs from the approved one', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    let altered = '';
    scripted.replies.set(READ_BACK_TREE, () => {
      const entries = sentEntries(scripted).filter((entry) => entry.sha !== null);
      altered = entries[0]?.path ?? '';
      return ok({
        sha: 'c'.repeat(40),
        truncated: false,
        tree: entries.map((entry, index) => (index === 0 ? { ...entry, mode: '100755' } : entry)),
      });
    });
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain(altered);
    expect(refusal.message).toMatch(/mode/i);
  });

  it('refuses a truncated tree read, because it cannot prove every path and deletion', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(READ_BACK_TREE, () =>
      ok({
        sha: 'c'.repeat(40),
        truncated: true,
        tree: sentEntries(scripted).filter((entry) => entry.sha !== null),
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toMatch(/truncated/i);
  });

  it('refuses a tree read that omits the truncation flag, rather than assuming it', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(READ_BACK_TREE, () =>
      ok({
        sha: 'c'.repeat(40),
        tree: sentEntries(scripted).filter((entry) => entry.sha !== null),
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toMatch(/truncated/i);
  });

  it('refuses a tree read that reports a different tree SHA', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(READ_BACK_TREE, ok({ sha: 'e'.repeat(40), truncated: false, tree: [] }));
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain('e'.repeat(40));
    expect(refusal.message).toMatch(/tree read reports/i);
  });

  it('refuses a tree read that still carries a path the approved patch deleted', async () => {
    const fixture = await implementedRun(tempDirs);
    await rm(path.join(fixture.repoDir, 'README.md'));
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(READ_BACK_TREE, () => {
      const entries = sentEntries(scripted);
      return ok({
        sha: 'c'.repeat(40),
        truncated: false,
        tree: [
          ...entries.filter((entry) => entry.sha !== null),
          { path: 'README.md', mode: '100644', type: 'blob', sha: 'f'.repeat(40) },
        ],
      });
    });
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain('README.md');
    expect(refusal.message).toMatch(/delete/i);
  });

  it('names the created branch when the read-back itself fails', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `GET repos/${REPOSITORY}/git/ref/heads/${input.branch}`,
      fail('HTTP 500: upstream exploded'),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/accepted the request to create/i);
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain(input.branch);
    expect(refusal.message).toContain('d'.repeat(40));
    expect(refusal.remediation).toMatch(/inspect the branch/i);
    expect(refusal.remediation).toMatch(/do not retry this command/i);
    expect(refusal.remediation).not.toMatch(/before retrying|retry once|try again/i);
    expect(refusal.kind).toBe('invalid-response');
    expect(refusal.retryable).toBe(false);
  });

  it.each([
    ['an empty body', ''],
    ['a body that is not JSON', 'not json'],
    ['a JSON body of the wrong shape', '{"ref": 7}'],
  ])(
    'accepts a healthy branch when the creation reply is %s, because the read-back is the evidence',
    async (_label, body) => {
      const fixture = await implementedRun(tempDirs);
      const input = await inputFor(fixture.repoDir, fixture.base);
      const scripted = scriptedGitHub();
      scriptHappyPath(scripted, fixture.base, input.branch);
      scripted.replies.set(`POST repos/${REPOSITORY}/git/refs`, {
        code: 0,
        stdout: body,
        stderr: '',
        timedOut: false,
        truncated: false,
      });
      const remote = createGitHubPublicationRemote({ run: scripted.run });

      await expect(remote.pushBranch(input)).resolves.toEqual({
        branch: input.branch,
        commitSha: 'd'.repeat(40),
      });
      expect(scripted.calls.at(-1)?.endpoint).toBe(READ_BACK_TREE.slice('GET '.length));
    },
  );

  it('refuses a creation reply that names another branch, and says the request was accepted', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `POST repos/${REPOSITORY}/git/refs`,
      ok({
        ref: 'refs/heads/some-other-branch',
        object: { sha: 'd'.repeat(40), type: 'commit' },
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/accepted the request to create/i);
    expect(refusal.message).toContain('refs/heads/some-other-branch');
    expect(refusal.message).toContain(input.branch);
    expect(refusal.kind).toBe('invalid-response');
    expect(refusal.retryable).toBe(false);
  });

  it('refuses a read-back ref that names a different branch', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `GET repos/${REPOSITORY}/git/ref/heads/${input.branch}`,
      ok({
        ref: 'refs/heads/some-other-branch',
        object: { sha: 'd'.repeat(40), type: 'commit' },
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain('refs/heads/some-other-branch');
  });

  it('refuses a read-back ref whose object is not a commit', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `GET repos/${REPOSITORY}/git/ref/heads/${input.branch}`,
      ok({
        ref: `refs/heads/${input.branch}`,
        object: { sha: 'd'.repeat(40), type: 'tree' },
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toMatch(/expected shape for the created branch/i);
    // The path of the failed field, not the word "commit" that the message carries
    // anyway in the SHA it quotes.
    expect(refusal.message).toContain('object.type');
  });

  it('refuses a read-back commit that reports a different SHA', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    scripted.replies.set(
      `GET repos/${REPOSITORY}/git/commits/${'d'.repeat(40)}`,
      ok({
        sha: 'e'.repeat(40),
        tree: { sha: 'c'.repeat(40) },
        parents: [{ sha: fixture.base }],
      }),
    );
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain('e'.repeat(40));
  });

  it('refuses a tree entry whose type is not a blob', async () => {
    const fixture = await implementedRun(tempDirs);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    let altered = '';
    scripted.replies.set(READ_BACK_TREE, () => {
      const entries = sentEntries(scripted).filter((entry) => entry.sha !== null);
      altered = entries[0]?.path ?? '';
      return ok({
        sha: 'c'.repeat(40),
        truncated: false,
        tree: entries.map((entry, index) => (index === 0 ? { ...entry, type: 'tree' } : entry)),
      });
    });
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain(altered);
    expect(refusal.message).toMatch(/not a blob/i);
  });

  it('reads a large patch through more than one path filter and merges every chunk', async () => {
    const fixture = await implementedRun(tempDirs);
    await putMany(fixture.repoDir, 72);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const patch = await describePatch({ workspace: fixture.repoDir, baseSha: fixture.base });
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await remote.pushBranch(input);

    const treeReads = treeReadCalls(scripted);
    expect(treeReads.length).toBeGreaterThanOrEqual(2);
    const programs = jqPrograms(treeReads);
    expect(new Set(programs).size).toBe(treeReads.length);
    for (const program of programs) expect(program.length).toBeLessThanOrEqual(3000);
    const filtered = filtersOf(programs);
    expect(filtered.length).toBe(patch.files.length);
    expect(new Set(filtered)).toEqual(new Set(patch.files.map((file) => file.path)));
  });

  it('refuses when a later tree chunk omits a path, so every chunk is checked', async () => {
    const fixture = await implementedRun(tempDirs);
    await putMany(fixture.repoDir, 72);
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    let reads = 0;
    let omitted = '';
    scripted.replies.set(READ_BACK_TREE, () => {
      reads += 1;
      const wanted = currentFilters(scripted) ?? [];
      const entries = sentEntries(scripted).filter(
        (entry) => entry.sha !== null && wanted.includes(entry.path),
      );
      if (reads === 1) return ok({ sha: 'c'.repeat(40), truncated: false, tree: entries });
      omitted = entries.at(-1)?.path ?? '';
      return ok({
        sha: 'c'.repeat(40),
        truncated: false,
        tree: entries.filter((entry) => entry.path !== omitted),
      });
    });
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    const refusal = await refusalOf(remote.pushBranch(input));
    expect(refusal.message).toMatch(/could not verify/i);
    expect(refusal.message).toContain(omitted);
  });

  it('refuses a patch that would exceed the read-back budget, before any write', async () => {
    const fixture = await implementedRun(tempDirs);
    const longDir = `generated/${'a'.repeat(40)}/${'b'.repeat(40)}/${'c'.repeat(30)}`;
    for (let index = 0; index < 400; index += 1) {
      await put(
        fixture.repoDir,
        `${longDir}/file-${String(index).padStart(3, '0')}.txt`,
        `${String(index)}\n`,
      );
    }
    const input = await inputFor(fixture.repoDir, fixture.base);
    const scripted = scriptedGitHub();
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await expect(remote.pushBranch(input)).rejects.toThrow(/tree read-backs/i);
    expect(scripted.calls).toEqual([]);
  });

  it('sends every call to the host the approved page names, not a compiled-in default', async () => {
    const fixture = await implementedRun(tempDirs);
    const approved = await inputFor(fixture.repoDir, fixture.base);
    const input = { ...approved, host: 'ghe.example.com' };
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await remote.pushBranch(input);
    await remote.createPullRequest({
      host: 'ghe.example.com',
      repository: REPOSITORY,
      title: 'Parser accepts invalid empty dates',
      body: 'Body.\n',
      head: input.branch,
      base: 'main',
    });

    expect(scripted.calls.length).toBeGreaterThan(0);
    expect(scripted.calls.every((call) => call.args.includes('--hostname'))).toBe(true);
    expect(scripted.calls.every((call) => call.args.includes('ghe.example.com'))).toBe(true);
    expect(scripted.calls.some((call) => call.args.includes(HOST))).toBe(false);
  });

  it('refuses a request for a host other than the one it was pinned to, before any gh call', async () => {
    const fixture = await implementedRun(tempDirs);
    const approved = await inputFor(fixture.repoDir, fixture.base);
    const input = { ...approved, host: 'ghe.example.com' };
    const scripted = scriptedGitHub();
    scriptHappyPath(scripted, fixture.base, input.branch);
    const remote = createGitHubPublicationRemote({ run: scripted.run, host: HOST });

    await expect(remote.pushBranch(input)).rejects.toThrow(/host/i);
    await expect(
      remote.createPullRequest({
        host: 'ghe.example.com',
        repository: REPOSITORY,
        title: 'Parser accepts invalid empty dates',
        body: 'Body.\n',
        head: 'mergesutra/run-1',
        base: 'main',
      }),
    ).rejects.toThrow(/host/i);
    expect(scripted.calls).toEqual([]);
  });

  it('refuses a host it could not safely hand to gh', async () => {
    const scripted = scriptedGitHub();
    const remote = createGitHubPublicationRemote({ run: scripted.run });

    await expect(
      remote.createPullRequest({
        host: '-oProxyCommand=calc.exe',
        repository: REPOSITORY,
        title: 'Parser accepts invalid empty dates',
        body: 'Body.\n',
        head: 'mergesutra/run-1',
        base: 'main',
      }),
    ).rejects.toThrow(/host/i);
    expect(scripted.calls).toEqual([]);
  });
});
