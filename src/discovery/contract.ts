import { z } from 'zod';
import { VERSION } from '../version.js';
import type { CiCommand, CiFacts } from './ci.js';
import type { DeclaredScript, ManifestFacts } from './manifests.js';
import type { ContributionDocFact, ProtectedAreasFact } from './policy.js';

/**
 * The repository contract: what this project requires of a contribution,
 * stated as facts with the file each fact came from.
 *
 * Two rules shape it. A gate is `REPOSITORY_REQUIRED` only when the repository
 * itself demanded it — a CI step that actually runs it; MergeSutra never
 * promotes its own preference into a repository requirement. A script that
 * exists but that no CI step runs is `DECLARED_ONLY`, which is a different
 * claim from "the project has no lint step" and is reported as such, because a
 * reviewer must be able to check each sentence against a file rather than
 * against a tool's opinion.
 */

export const CONTRACT_SCHEMA_VERSION = 1;

export const GATE_KINDS = ['format', 'lint', 'typecheck', 'test', 'build'] as const;
export const CHECK_SOURCES = ['REPOSITORY_REQUIRED', 'MERGESUTRA_ADDITIONAL', 'OPTIONAL'] as const;
export const GATE_STATUSES = ['REPOSITORY_REQUIRED', 'DECLARED_ONLY', 'NOT_DECLARED'] as const;

const sourceFactSchema = z.object({ file: z.string(), detail: z.string() }).strict();

/** Where a gate came from, with the line a reviewer can open the file at. */
export const gateProvenanceSchema = z
  .object({
    file: z.string(),
    detail: z.string(),
    line: z.number().int().positive().nullable(),
  })
  .strict();

export const gateSchema = z
  .object({
    kind: z.enum(GATE_KINDS),
    status: z.enum(GATE_STATUSES),
    source: z.enum(CHECK_SOURCES),
    command: z.string().nullable(),
    provenance: gateProvenanceSchema.nullable(),
    why: z.string(),
  })
  .strict();

export const contributionDocSchema = z
  .object({
    path: z.string(),
    status: z.enum(['read', 'unreadable']),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    instructionLikeRules: z.array(z.string()).readonly(),
  })
  .strict();

export const protectedAreasSchema = z
  .object({
    declaredIn: z.string().nullable(),
    status: z.enum(['declared', 'unreadable', 'absent']),
    entryCount: z.number().int().nonnegative(),
    samplePaths: z.array(z.string()).readonly(),
  })
  .strict();

export const repositoryContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    mergeSutraVersion: z.string(),
    /** Every field here was read from an untrusted repository. */
    untrusted: z.literal(true),
    ecosystem: z.enum(['node', 'python', 'rust', 'go', 'unknown']),
    packageManager: z.object({ name: z.string(), source: sourceFactSchema }).nullable(),
    runtimeVersion: z.object({ value: z.string(), source: sourceFactSchema }).nullable(),
    gates: z.array(gateSchema).readonly(),
    ci: z
      .object({
        provider: z.enum(['github-actions', 'none']),
        workflows: z
          .array(z.object({ path: z.string(), jobs: z.array(z.string()) }).strict())
          .readonly(),
        coverage: z.enum(['full', 'partial']),
        caveats: z.array(z.string()).readonly(),
        observedCommandCount: z.number().int().nonnegative(),
      })
      .strict(),
    protectedAreas: protectedAreasSchema,
    contributionDocs: z.array(contributionDocSchema).readonly(),
    limitations: z.array(z.string()).readonly(),
  })
  .strict();

export type Gate = z.infer<typeof gateSchema>;
export type GateKind = Gate['kind'];
export type RepositoryContract = z.infer<typeof repositoryContractSchema>;

export interface BuildContractInput {
  readonly manifests: ManifestFacts;
  readonly ci: CiFacts;
  readonly protectedAreas: ProtectedAreasFact;
  readonly contributionDocs: readonly ContributionDocFact[];
}

/**
 * Script names a repository commonly uses for each gate, in priority order.
 *
 * The read-only spelling comes first: a contract that reported `prettier --write .`
 * as the format gate would be telling a later stage to edit the user's files.
 */
const SCRIPT_NAMES: Record<GateKind, readonly string[]> = {
  format: ['format:check', 'format', 'fmt', 'prettier'],
  lint: ['lint:check', 'lint', 'eslint'],
  typecheck: ['typecheck', 'type-check', 'check:types', 'tsc'],
  test: ['test', 'test:unit', 'vitest', 'jest'],
  build: ['build', 'compile'],
};

/** Any script name that identifies its gate, e.g. `format:check` -> format. */
const KIND_BY_SCRIPT_NAME: ReadonlyMap<string, GateKind> = new Map(
  GATE_KINDS.flatMap((kind) => SCRIPT_NAMES[kind].map((name) => [name, kind] as const)),
);

/**
 * Tool-level evidence that a command performs a gate.
 *
 * Matched against lowercased text, so every literal here must be lowercase.
 * Deliberately conservative: an unrecognised command stays unclaimed rather
 * than being filed under a gate.
 */
const TOOL_EVIDENCE: Record<GateKind, RegExp> = {
  format: /\b(prettier|black|ruff)\b[^\n]*--check|\b(rustfmt|gofmt)\b/,
  lint: /\b(eslint|biome|ruff|flake8|golangci-lint)\b|cargo clippy/,
  typecheck: /\b(vue-tsc|mypy|pyright)\b|\btsc\b(?![^\n]*--outdir)/,
  test: /\b(vitest|jest|pytest|phpunit)\b|\b(npm|pnpm|yarn|bun) test\b|(^|[;&|]\s*)(cargo|go) test\b/,
  build:
    /\b(vite|webpack|rollup|turbo|next)\b[^\n]*build|\btsc\b[^\n]*(--build|-b)\b|(^|[;&|]\s*)(cargo|go) build\b|\bmake\b/,
};

/** Setting a workspace up is not a gate, and reporting it as unexplained noise would be misleading. */
const SETUP_COMMAND =
  /\b(?:npm|pnpm|yarn|bun|npx) ci\b|\b(?:npm|pnpm|yarn|bun) install\b|\b(?:pip|uv|poetry) (?:install|sync)\b|\b(?:go (?:mod|work) (?:download|tidy)|cargo fetch|bundle install)\b|\bapt[-\s]|\bbrew install\b/;

/** Every script a piece of command text invokes, in the order it appears. */
const ANY_INVOCATION = /(?:npm|pnpm|yarn|bun|npx)(?:[ -][\w@/.-]+)*\s+(?:run\s+)?([\w:./-]+)/g;

/** How far into a repository's own script chain the resolver follows. */
const MAX_SCRIPT_DEPTH = 3;

/** How a command reaches a gate, in terms a reviewer can open in an editor. */
export interface GateRoute {
  readonly kind: GateKind;
  /** The script the CI step invoked, or null when the step named the tool itself. */
  readonly via: string | null;
  /** The declared script that actually carries the gate, if a script carries it. */
  readonly script: string | null;
}

/** The CI step that makes a gate required, with the route that found it. */
interface CiGateHit extends GateRoute {
  readonly command: CiCommand;
}

function invokedScripts(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(ANY_INVOCATION)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

/**
 * A script whose own name says which gate it carries is the better citation:
 * a composite body that happens to contain `npm test` proves the gate, but the
 * repository's `test` script names the command a contributor should run.
 */
function isNamedCarrier(route: GateRoute): boolean {
  return route.script !== null && KIND_BY_SCRIPT_NAME.get(route.script) === route.kind;
}

function dedupeRoutes(routes: GateRoute[]): GateRoute[] {
  const seen = new Map<GateKind, GateRoute>();
  for (const route of routes) {
    const existing = seen.get(route.kind);
    if (!existing) seen.set(route.kind, route);
    else if (!isNamedCarrier(existing) && isNamedCarrier(route)) seen.set(route.kind, route);
  }
  return [...seen.values()];
}

/** The first CI step that enforces each gate, plus the steps no gate explains. */
interface CiResolution {
  readonly hits: ReadonlyMap<GateKind, CiGateHit>;
  readonly unexplained: readonly CiCommand[];
}

function resolveCi(ci: CiFacts, scripts: ReadonlyMap<string, DeclaredScript>): CiResolution {
  const hits = new Map<GateKind, CiGateHit>();
  const unexplained: CiCommand[] = [];
  for (const command of ci.commands) {
    const routes = gatesEnforced(command.command, scripts);
    if (routes.length === 0) {
      if (!SETUP_COMMAND.test(command.command.trim().toLowerCase())) unexplained.push(command);
      continue;
    }
    for (const route of routes) {
      if (!hits.has(route.kind)) hits.set(route.kind, { ...route, command });
    }
  }
  return { hits, unexplained };
}

export function buildRepositoryContract(input: BuildContractInput): RepositoryContract {
  const { manifests, ci } = input;
  const byName = new Map(manifests.scripts.map((script) => [script.name, script]));
  const { hits, unexplained } = resolveCi(ci, byName);

  const gates: Gate[] = GATE_KINDS.map((kind) => {
    const declared = SCRIPT_NAMES[kind]
      .map((name) => byName.get(name))
      .find((script): script is NonNullable<typeof script> => script !== undefined);
    const hit = hits.get(kind);

    if (hit) {
      const carrier = (hit.script ? byName.get(hit.script) : undefined) ?? declared;
      if (carrier) {
        const direct = hit.via === carrier.name;
        return {
          kind,
          status: 'REPOSITORY_REQUIRED',
          source: 'REPOSITORY_REQUIRED',
          command: carrier.command,
          provenance: {
            file: hit.command.workflow,
            detail: `${hit.command.workflow}:${hit.command.line} ${
              direct ? 'runs it' : `runs '${hit.command.command}'`
            }; ${carrier.source.file}:${carrier.source.detail} declares it`,
            line: hit.command.line,
          },
          why: direct
            ? `CI executes the '${carrier.name}' the repository declares`
            : hit.via === null
              ? `CI runs ${hit.command.command}, which performs the '${carrier.name}' this gate needs`
              : `CI runs '${hit.via}', which reaches the '${carrier.name}' this gate needs`,
        };
      }
      return {
        kind,
        status: 'REPOSITORY_REQUIRED',
        source: 'REPOSITORY_REQUIRED',
        command: hit.command.command,
        provenance: {
          file: hit.command.workflow,
          detail: `line ${hit.command.line}`,
          line: hit.command.line,
        },
        why: 'CI runs a command that performs this gate',
      };
    }
    if (declared) {
      return {
        kind,
        status: 'DECLARED_ONLY',
        source: 'OPTIONAL',
        command: declared.command,
        provenance: {
          file: declared.source.file,
          detail: declared.source.detail,
          line: null,
        },
        why: `'${declared.name}' exists but no CI step was found that runs it, so it is not treated as required`,
      };
    }
    return {
      kind,
      status: 'NOT_DECLARED',
      source: 'OPTIONAL',
      command: null,
      provenance: null,
      why: 'nothing in the manifests or CI declares this gate',
    };
  });

  const limitations: string[] = [
    'The contract records what the repository declares. MergeSutra adds no requirement of its own to this list.',
    'Contribution documents were scanned for shape, not obeyed; their prose does not become a check.',
  ];
  if (unexplained.length > 0) {
    const listed = unexplained
      .slice(0, 3)
      .map((command) => `'${command.command}' (${command.workflow}:${command.line})`)
      .join(', ');
    limitations.push(
      `CI runs ${unexplained.length} step(s) this contract could not classify as a gate: ${listed}${
        unexplained.length > 3 ? ', and more' : ''
      }. Those steps may enforce requirements not listed here.`,
    );
  }
  if (ci.provider === 'none') {
    limitations.push('No CI workflow found: nothing can be marked required from CI evidence.');
  }
  if (ci.coverage === 'partial') {
    limitations.push(
      `CI coverage was partial: ${ci.caveats.join(' ') || 'unsupported YAML constructs were present'}`,
    );
  }
  if (manifests.ecosystem === 'unknown') {
    limitations.push('No recognised manifest: the toolchain could not be identified.');
  }
  if (manifests.unreadable.length > 0) {
    limitations.push(
      `Unreadable manifests: ${manifests.unreadable.map((u) => `${u.file} (${u.reason})`).join(', ')}.`,
    );
  }
  if (input.protectedAreas.status === 'absent') {
    limitations.push('No CODEOWNERS file found: ownership of specific paths is unknown.');
  }
  if (input.protectedAreas.status === 'unreadable') {
    limitations.push(
      `${input.protectedAreas.declaredIn} exists but could not be read; protected areas are unknown.`,
    );
  }
  limitations.push(
    'Branch protection, required reviewers and merge policies live in repository settings and were not queried.',
  );

  return repositoryContractSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    mergeSutraVersion: VERSION,
    untrusted: true,
    ecosystem: manifests.ecosystem,
    packageManager: manifests.packageManager
      ? { name: manifests.packageManager.name, source: manifests.packageManager.source }
      : null,
    runtimeVersion: manifests.runtimeVersion
      ? { value: manifests.runtimeVersion.value, source: manifests.runtimeVersion.source }
      : null,
    gates,
    ci: {
      provider: ci.provider,
      workflows: ci.workflows.map((w) => ({ path: w.path, jobs: [...w.jobs] })),
      coverage: ci.coverage,
      caveats: [...ci.caveats],
      observedCommandCount: ci.commands.length,
    },
    protectedAreas: { ...input.protectedAreas, samplePaths: [...input.protectedAreas.samplePaths] },
    contributionDocs: input.contributionDocs.map((doc) => ({
      ...doc,
      instructionLikeRules: [...doc.instructionLikeRules],
    })),
    limitations,
  });
}

/**
 * Which gates a command enforces, following the repository's own scripts.
 *
 * `npm run check` says nothing about gates on its own; the package.json behind
 * it says everything. The chain is walked to a bounded depth because a
 * composite script one level deep is a fact a reviewer can follow in two file
 * reads, while a cycle is not a fact at all.
 *
 * Exported because a later stage has to ask the same question about a command
 * it is about to run, and must get the same evidence-bound answer.
 */
export function gatesEnforced(
  command: string,
  scripts: ReadonlyMap<string, DeclaredScript>,
  via: string | null = null,
  current: string | null = null,
  depth = 0,
): GateRoute[] {
  const text = command.trim().toLowerCase();
  const routes: GateRoute[] = [];
  for (const kind of GATE_KINDS) {
    if (TOOL_EVIDENCE[kind].test(text)) routes.push({ kind, via, script: current });
  }
  if (depth >= MAX_SCRIPT_DEPTH) return dedupeRoutes(routes);

  for (const name of invokedScripts(text)) {
    const root = via ?? name;
    const named = KIND_BY_SCRIPT_NAME.get(name);
    if (named) routes.push({ kind: named, via: root, script: name });
    const body = scripts.get(name);
    if (body) routes.push(...gatesEnforced(body.command, scripts, root, name, depth + 1));
  }
  return dedupeRoutes(routes);
}

/** Does this command perform the gate, directly or through a declared script? */
export function runsGate(
  command: string,
  kind: GateKind,
  scripts: ReadonlyMap<string, DeclaredScript> = new Map(),
): boolean {
  return gatesEnforced(command, scripts).some((route) => route.kind === kind);
}

export function parseRepositoryContract(unknown: unknown): RepositoryContract {
  return repositoryContractSchema.parse(unknown) as RepositoryContract;
}
