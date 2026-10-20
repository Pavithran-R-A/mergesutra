import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubPublicationRemote } from '../../src/pr/github-publisher.js';
import type { RunResult, Runner } from '../../src/core/runner.js';
import type { PushBranchInput } from '../../src/pr/publisher.js';
import { describePatch } from '../../src/verify/patch.js';
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
    repository: REPOSITORY,
    branch: 'mergesutra/run-20261020T000000Z-abc123',
    baseSha,
    patchIdentity: patch.identity,
    runId: 'run-20261020T000000Z-abc123',
  };
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
    `POST repos/${REPOSITORY}/pulls`,
    ok({
      html_url: `https://github.com/${REPOSITORY}/pull/7`,
      number: 7,
      draft: true,
      state: 'open',
    }),
  );
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
    const created = await remote.createPullRequest({
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
    expect(endpoints.filter((entry) => !entry.endsWith('/pulls')).slice(-3)).toEqual([
      `POST repos/${REPOSITORY}/git/trees`,
      `POST repos/${REPOSITORY}/git/commits`,
      `POST repos/${REPOSITORY}/git/refs`,
    ]);
    expect(endpoints.at(-1)).toBe(`POST repos/${REPOSITORY}/pulls`);

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
        repository: REPOSITORY,
        title: 'Parser accepts invalid empty dates',
        body: 'Body.\n',
        head: 'mergesutra/run-1',
        base: 'main',
      }),
    ).rejects.toThrow(/URL|url/i);
  });

  it('never puts a credential in an argument and never uses a mutating verb beyond the five calls', async () => {
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
    // Two GETs at most (base commit is the only one), and every write POSTs to
    // exactly the four Git Data endpoints plus the pull request.
    expect(scripted.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(scripted.calls.filter((call) => call.method === 'POST')).toHaveLength(5);
    expect(scripted.calls.every((call) => call.args.includes('--hostname'))).toBe(true);
    expect(scripted.calls.every((call) => call.args.includes(HOST))).toBe(true);
  });
});
