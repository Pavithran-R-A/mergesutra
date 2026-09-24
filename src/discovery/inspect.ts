import path from 'node:path';
import { AppError, isAppError } from '../core/errors.js';
import { defaultRunner, type Runner } from '../core/runner.js';
import { defaultRedactor } from '../security/redaction.js';
import type { RepositoryIdentity } from '../github/types.js';
import { createRunRecord, newRunId, type RunCheck, type RunRecord } from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import {
  identityFromLocalSnapshot,
  inspectLocalRepository,
  type LocalRepositorySnapshot,
} from '../intake/local-repo.js';
import { detectCi } from './ci.js';
import { buildRepositoryContract, type RepositoryContract } from './contract.js';
import { detectManifests } from './manifests.js';
import { scanContributionDocs, scanProtectedAreas } from './policy.js';
import { openRepoReader, type RepoReader } from './repo-fs.js';

/**
 * Stage 2 orchestration: turn a directory into a provenanced contract.
 *
 * Everything here is read-only. The stage deliberately stops short of
 * *obeying* what it finds: it records that CI runs `npm test` and where that
 * sentence came from, and it hands the decision to run anything to a later
 * stage. That boundary is the point — a repository that declares no checks must
 * produce a contract that says so, rather than a confident-looking list.
 */

export interface InspectOptions {
  readonly repoPath: string;
}

export interface InspectDeps {
  readonly run?: Runner;
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly random?: () => number;
  /** Overridable so tests can drive discovery without touching the filesystem. */
  readonly openReader?: (repoPath: string) => Promise<RepoReader>;
}

export interface InspectResult {
  /** The realpath'd directory that was inspected. */
  readonly root: string;
  readonly contract: RepositoryContract;
  readonly record: RunRecord;
  readonly recordFile: string | null;
  readonly saveError: string | null;
  readonly checks: readonly RunCheck[];
}

const NEXT_STAGE = 'ACCEPTANCE CONTRACT — `mergesutra contract` derives the criteria (Stage 3)';

export async function runInspect(
  options: InspectOptions,
  deps: InspectDeps = {},
): Promise<InspectResult> {
  const repoPath = options.repoPath.trim();
  if (repoPath.length === 0) {
    throw new AppError({
      kind: 'validation',
      message: 'Nothing to inspect: supply a repository path.',
      remediation: 'For example: mergesutra inspect ./path/to/clone',
    });
  }

  const run = deps.run ?? defaultRunner;
  const openReader = deps.openReader ?? openRepoReader;
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(deps.cwd));
  const checks: RunCheck[] = [];

  // 1. The directory itself. If this fails there is nothing to discover, so the
  //    run is blocked rather than reported as an empty contract.
  let reader: RepoReader;
  try {
    reader = await openReader(repoPath);
  } catch (error) {
    const kind = isAppError(error) ? error.kind : 'validation';
    throw new AppError({
      kind,
      message: `Cannot inspect ${bound(redact(errorText(error)))}`,
      remediation:
        'Pass a directory that exists; MergeSutra reads repositories but never creates them.',
    });
  }
  checks.push({ name: 'Repository path', status: 'PASS', detail: reader.root });

  // 2. Git metadata, when the directory happens to be a working tree. Its
  //    absence narrows what a later stage may claim, so it is recorded either way.
  let repository: RepositoryIdentity | null = null;
  let local: LocalRepositorySnapshot | null = null;
  try {
    local = await inspectLocalRepository(repoPath, { run });
    repository = identityFromLocalSnapshot(local);
    checks.push({
      name: 'Git metadata',
      status: 'PASS',
      detail: `${shortPath(local.toplevel)} @ ${local.head.shortSha} on ${local.branch}`,
    });
  } catch (error) {
    checks.push({
      name: 'Git metadata',
      status: 'NOT_AVAILABLE',
      detail: `not a readable Git working tree — ${bound(redact(errorText(error)))}`,
    });
  }

  // 3. Discovery. Each detector reports its own absences.
  const manifests = await detectManifests(reader);
  checks.push(
    manifests.ecosystem === 'unknown'
      ? {
          name: 'Manifest',
          status: 'WARN',
          detail: 'no package.json, pyproject.toml, Cargo.toml or go.mod found',
        }
      : {
          name: 'Manifest',
          status: 'PASS',
          detail: `${manifests.ecosystem}${
            manifests.packageManager ? `, ${manifests.packageManager.name}` : ''
          }${manifests.scripts.length > 0 ? `, ${manifests.scripts.length} script(s)` : ', no scripts'}`,
        },
  );

  const ci = await detectCi(reader);
  checks.push(
    ci.provider === 'none'
      ? { name: 'CI workflows', status: 'NOT_AVAILABLE', detail: 'no GitHub Actions found' }
      : {
          name: 'CI workflows',
          status: ci.coverage === 'full' ? 'PASS' : 'WARN',
          detail: `${ci.workflows.length} workflow(s), ${ci.commands.length} command(s), coverage ${ci.coverage}`,
        },
  );

  const contributionDocs = await scanContributionDocs(reader);
  checks.push(
    contributionDocs.length === 0
      ? { name: 'Contribution docs', status: 'SKIP', detail: 'none found' }
      : {
          name: 'Contribution docs',
          status: 'PASS',
          detail: `${contributionDocs.map((d) => `${d.path} (${d.bytes} B)`).join(', ')}`,
        },
  );

  const protectedAreas = await scanProtectedAreas(reader);
  checks.push(
    protectedAreas.status === 'declared'
      ? {
          name: 'Protected areas',
          status: 'PASS',
          detail: `${protectedAreas.declaredIn}: ${protectedAreas.entryCount} ownership rule(s)`,
        }
      : {
          name: 'Protected areas',
          status: 'SKIP',
          detail:
            protectedAreas.status === 'absent' ? 'no CODEOWNERS file' : 'CODEOWNERS unreadable',
        },
  );

  const contract = defaultRedactor.deep(
    buildRepositoryContract({ manifests, ci, protectedAreas, contributionDocs }),
  );
  const required = contract.gates.filter((gate) => gate.status === 'REPOSITORY_REQUIRED');
  const declaredOnly = contract.gates.filter((gate) => gate.status === 'DECLARED_ONLY');
  checks.push({
    name: 'Repository contract',
    status: required.length + declaredOnly.length === 0 ? 'WARN' : 'PASS',
    detail: `${required.length} repository-required gate(s), ${declaredOnly.length} declared-only, ${
      contract.gates.length - required.length - declaredOnly.length
    } undeclared`,
  });

  const outcome: RunRecord['outcome'] =
    manifests.ecosystem === 'unknown' && ci.provider === 'none'
      ? 'INCONCLUSIVE'
      : 'INSPECT_COMPLETE';
  if (outcome === 'INCONCLUSIVE') {
    checks.unshift({
      name: 'Inspection',
      status: 'NOT_AVAILABLE',
      detail: 'neither a manifest nor a CI workflow was found; the contract below is empty of fact',
    });
  }

  const now = deps.now?.() ?? new Date();
  const record = createRunRecord({
    runId: newRunId(now, deps.random ?? Math.random),
    createdAt: now.toISOString(),
    stage: 'inspect',
    outcome,
    issueRef: null,
    issue: null,
    repository,
    base: local?.head ?? null,
    local,
    checks,
    contract,
    nextStage: NEXT_STAGE,
    limitations: [...contract.limitations],
  });

  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = bound(redact(errorText(error)));
  }

  return { root: reader.root, contract, record, recordFile, saveError, checks };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function redact(text: string): string {
  return defaultRedactor.text(text);
}

function bound(text: string): string {
  const trimmed = text.trim().split('\n')[0] ?? '';
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed;
}

function shortPath(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  if (relative.length === 0 || relative.startsWith('..')) return absolute;
  return `./${relative.replaceAll('\\', '/')}`;
}
