import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { scanUntrustedText } from '../security/injection-scan.js';
import { defaultRedactor } from '../security/redaction.js';
import {
  MAX_ISSUE_BODY_CHARS,
  type IssueDocument,
  type RepositoryContext,
  type RepositoryIdentity,
} from './types.js';

/**
 * Runtime validation for forge responses.
 *
 * GitHub's JSON is treated exactly like model output: schema-checked at the
 * edge, and rejected with a controlled error when it does not match. Field
 * names are GitHub's snake_case; the domain objects above are MergeSutra's.
 */

export const repositoryPayloadSchema = z
  .object({
    name: z.string().min(1),
    full_name: z.string().min(3),
    owner: z.object({ login: z.string().min(1) }).passthrough(),
    default_branch: z.string().min(1),
    fork: z.boolean().optional(),
    private: z.boolean().optional(),
    archived: z.boolean().optional(),
    html_url: z.string().min(1),
    description: z.string().nullable().optional(),
  })
  .passthrough();

const labelSchema = z.union([z.string(), z.object({ name: z.string().optional() }).passthrough()]);

export const issuePayloadSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    body: z.string().nullable().optional(),
    labels: z.array(labelSchema).optional(),
    user: z.object({ login: z.string().optional() }).nullable().optional(),
    html_url: z.string().optional(),
    comments: z.number().int().nonnegative().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    /** GitHub serves pull requests from /issues/<n> too. We must not treat one as an issue. */
    pull_request: z.unknown().optional(),
  })
  .passthrough();

export const commitPayloadSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
  })
  .passthrough();

function invalid(reason: string, cause?: unknown): AppError {
  return new AppError({
    kind: 'invalid-response',
    message: `GitHub response did not match the expected shape: ${reason}.`,
    retryable: false,
    cause,
    details: { reason },
  });
}

function requireParse<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail =
      parsed.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`).join('; ') ||
      'unrecognised payload';
    throw invalid(`${what} — ${detail}`);
  }
  return parsed.data;
}

export function toRepositoryIdentity(unknown: unknown, ctx: RepositoryContext): RepositoryIdentity {
  const data = requireParse(repositoryPayloadSchema, unknown, 'repository');
  if (data.full_name.toLowerCase() !== `${ctx.owner}/${ctx.repo}`.toLowerCase()) {
    throw invalid(
      `repository full_name '${defaultRedactor.text(data.full_name)}' does not match the requested ${ctx.owner}/${ctx.repo}`,
    );
  }
  return {
    host: ctx.host,
    owner: ctx.owner,
    repo: ctx.repo,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    isFork: data.fork ?? null,
    isArchived: data.archived ?? null,
    isPrivate: data.private ?? null,
    htmlUrl: data.html_url,
    description: data.description ?? '',
    source: 'github-api',
  };
}

export function toIssueDocument(
  unknown: unknown,
  options: { readonly maxBodyChars?: number } = {},
): IssueDocument {
  const data = requireParse(issuePayloadSchema, unknown, 'issue');
  if (data.pull_request !== undefined && data.pull_request !== null) {
    throw invalid(`#${data.number} is a pull request, not an issue`);
  }
  if (data.state !== 'open' && data.state !== 'closed') {
    throw invalid(`unhandled issue state '${data.state}'`);
  }
  const max = options.maxBodyChars ?? MAX_ISSUE_BODY_CHARS;
  const rawBody = data.body ?? '';
  const wasTruncated = rawBody.length > max;
  const body = wasTruncated ? rawBody.slice(0, max) : rawBody;
  const labels = (data.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((l) => l.length > 0);

  return {
    number: data.number,
    // Titles and bodies are attacker-influenced strings: newlines are collapsed
    // so a title cannot smuggle extra lines into terminal output or a report.
    title: sanitizeInline(data.title),
    state: data.state,
    body,
    bodyLength: rawBody.length,
    bodySha256: createHash('sha256').update(rawBody, 'utf8').digest('hex'),
    wasTruncated,
    labels,
    author: data.user?.login ?? 'unknown',
    url: data.html_url ?? '',
    commentCount: data.comments ?? 0,
    createdAt: data.created_at ?? '',
    updatedAt: data.updated_at ?? '',
    isPullRequest: false,
    untrusted: true,
    injectionFindings: scanUntrustedText(body),
  };
}

/** Collapse control characters and bound the length of a display string. */
export function sanitizeInline(value: string, maxLength = 200): string {
  const flat = value
    // eslint-disable-next-line no-control-regex -- stripping C0/C1 controls from untrusted text *is* the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > maxLength ? flat.slice(0, maxLength) + '…' : flat;
}
