import { AppError, kindForStatus, type AppErrorKind } from '../core/errors.js';
import { githubReadRunner, type Runner } from '../core/runner.js';
import { isSafePathSegment } from '../security/path-safety.js';
import { defaultRedactor, type Redactor } from '../security/redaction.js';
import { toIssueDocument, toRepositoryIdentity, commitPayloadSchema } from './schemas.js';
import type { RepositoryContext } from './types.js';
import type { CommitRef, IssueDocument, RepositoryIdentity } from './types.js';

/**
 * Reading GitHub through the `gh` CLI.
 *
 * `gh` is used rather than a hand-rolled REST client because it already owns
 * the credential problem: the user runs `gh auth login` once, and MergeSutra
 * never stores, forwards or prints a token. Environment-backed GitHub
 * authentication is preserved only for this dedicated read transport; ordinary
 * repository/workspace commands run through the default runner, which strips
 * `GH_TOKEN`, `GITHUB_TOKEN` and `GITHUB_PAT` before spawning them.
 * Commands are argv arrays with
 * `--hostname`, so a GitHub Enterprise host is a value, never part of a shell
 * string, and every path segment is re-validated before it is interpolated.
 *
 * Responses are untrusted: parsed as JSON, then schema-validated.
 */

export interface GitHubSource {
  repository(ctx: RepositoryContext): Promise<RepositoryIdentity>;
  issue(ctx: RepositoryContext & { readonly number: number }): Promise<IssueDocument>;
  branchHead(ctx: RepositoryContext & { readonly branch: string }): Promise<CommitRef>;
}

export interface GhClientDeps {
  readonly run?: Runner;
  readonly redactor?: Redactor;
}

export class GhCliGitHubSource implements GitHubSource {
  private readonly run: Runner;
  private readonly redactor: Redactor;

  constructor(deps: GhClientDeps = {}) {
    this.run = deps.run ?? githubReadRunner;
    this.redactor = deps.redactor ?? defaultRedactor;
  }

  async repository(ctx: RepositoryContext): Promise<RepositoryIdentity> {
    const json = await this.api(`repos/${segment(ctx.owner)}/${segment(ctx.repo)}`, ctx.host);
    return toRepositoryIdentity(json, ctx);
  }

  async issue(ctx: RepositoryContext & { number: number }): Promise<IssueDocument> {
    const json = await this.api(
      `repos/${segment(ctx.owner)}/${segment(ctx.repo)}/issues/${issueNumber(ctx.number)}`,
      ctx.host,
    );
    return toIssueDocument(json);
  }

  async branchHead(ctx: RepositoryContext & { branch: string }): Promise<CommitRef> {
    const json = await this.api(
      `repos/${segment(ctx.owner)}/${segment(ctx.repo)}/commits/${branch(ctx.branch)}`,
      ctx.host,
    );
    const parsed = commitPayloadSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError({
        kind: 'invalid-response',
        message: `GitHub did not return a commit object for ${ctx.owner}/${ctx.repo}@${ctx.branch}.`,
        remediation: 'Confirm the branch name exists on the repository.',
      });
    }
    return {
      sha: parsed.data.sha,
      shortSha: parsed.data.sha.slice(0, 10),
      source: 'github-api',
    };
  }

  private async api(endpoint: string, host: string): Promise<unknown> {
    const result = await this.run('gh', ['api', '--hostname', host, '--method', 'GET', endpoint]);

    if (result.code !== 0) throw this.ghError(result.stderr, result.stdout, result.code);

    const text = result.stdout.trim();
    if (text.length === 0) {
      throw new AppError({
        kind: 'invalid-response',
        message: 'gh returned an empty response body.',
        remediation: 'Retry, or check GitHub status and your network connection.',
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new AppError({
        kind: 'invalid-response',
        message: 'gh returned a response that is not JSON.',
        retryable: false,
        cause,
        details: { sample: this.redactor.text(bound(text, 200)) },
        remediation: 'This usually means an intermediary intercepted the request.',
      });
    }
  }

  private ghError(stderr: string, stdout: string, code: number): AppError {
    const combined = bound(`${stderr}\n${stdout}`, 400);
    const text = this.redactor.text(combined);
    const lower = text.toLowerCase();

    if (/enoent|not recognized|command not found|can't find gh/.test(lower)) {
      return new AppError({
        kind: 'config',
        message: 'GitHub CLI (gh) is not available on PATH.',
        remediation:
          'Install the GitHub CLI and run `gh auth login`. MergeSutra never accepts tokens as command arguments.',
        details: { exitCode: code },
      });
    }

    const status = /http (\d{3})/.exec(lower)?.[1] ?? /(\d{3}) status/.exec(lower)?.[1];
    const parsedStatus = status ? Number.parseInt(status, 10) : undefined;

    if (
      lower.includes('gh auth login') ||
      lower.includes('not logged in') ||
      lower.includes('authentication')
    ) {
      return new AppError({
        kind: 'auth',
        message: 'GitHub requests need authentication that gh does not have.',
        retryable: false,
        status: parsedStatus,
        details: { output: text },
        remediation: 'Run `gh auth login`, then retry.',
      });
    }

    if (lower.includes('rate limit')) {
      return new AppError({
        kind: 'rate-limit',
        message: 'GitHub rate limited this request.',
        retryable: true,
        status: parsedStatus ?? 403,
        details: { output: text },
        remediation: 'Wait for the limit to reset, or authenticate with `gh auth login`.',
      });
    }

    if (parsedStatus === 404 || lower.includes('not found') || lower.includes("doesn't exist")) {
      return new AppError({
        kind: 'not-found',
        message: 'GitHub returned not-found for that repository or issue.',
        retryable: false,
        status: 404,
        details: { output: text },
        remediation:
          'A private or renamed repository also looks like this when you lack access. Check the URL and your permissions.',
      });
    }

    const mapped = parsedStatus ? kindForStatus(parsedStatus) : undefined;
    return new AppError({
      kind: mapped?.kind ?? mapNetworkish(lower),
      message: `gh exited with code ${code}.`,
      retryable: mapped?.retryable ?? parsedStatus === undefined,
      status: parsedStatus,
      details: { output: text },
      remediation: 'Check `gh auth status` and your network connection, then retry.',
    });
  }
}

function mapNetworkish(lower: string): AppErrorKind {
  if (/could not resolve|connection refused|timed out|network|econnreset|certificate/.test(lower)) {
    return 'network';
  }
  return 'invalid-response';
}

function bound(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function segment(value: string): string {
  if (!isSafePathSegment(value)) {
    throw new AppError({
      kind: 'validation',
      message: `Refusing to place '${bound(defaultRedactor.text(value), 60)}' into a GitHub API path.`,
      remediation: 'Repository owners and names must match GitHub naming rules.',
    });
  }
  return value;
}

function issueNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError({
      kind: 'validation',
      message: `Issue number ${String(value)} is not a positive integer.`,
      remediation: 'Supply an issue URL containing a positive issue number.',
    });
  }
  return String(value);
}

function branch(value: string): string {
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(value) || value.includes('..')) {
    throw new AppError({
      kind: 'validation',
      message: `Refusing to place branch '${bound(defaultRedactor.text(value), 60)}' into a GitHub API path.`,
      remediation: 'Branch names may contain letters, digits, dot, slash, underscore and hyphen.',
    });
  }
  return value;
}
