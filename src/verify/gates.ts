import {
  GATE_KINDS,
  SCRIPT_NAMES,
  gatesEnforced,
  isSetupCommand,
  type GateKind,
} from '../discovery/contract.js';
import { detectCi } from '../discovery/ci.js';
import { CONTRIBUTION_CANDIDATES, MAX_DOC_BYTES } from '../discovery/policy.js';
import type { DeclaredScript, ManifestFacts } from '../discovery/manifests.js';
import type { RepoReader } from '../discovery/repo-fs.js';
import { decideTool, riskOf, type RiskClass } from '../process/tool-policy.js';
import { toExecutableArgv } from './command.js';
import type { AcceptanceCriterion } from '../contract/schema.js';

/**
 * What the repository itself requires to pass — Stage 7's input.
 *
 * This is the module where a verification engine can quietly become an opinion
 * machine, so it is written to do as little as possible. Four rules hold it back:
 *
 * 1. **A gate needs a command that exists.** Only two things create a gate: a CI
 *    step that runs it, and a script the repository declares. Prose in a
 *    contributing guide, a config file that implies a tool, or a MergeSutra
 *    preference all corroborate a gate and never create one. `cargo clippy`
 *    mentioned in CONTRIBUTING.md of a TypeScript repository is not a gate.
 * 2. **Where a command came from is not how demanding it is.** `provenance`
 *    answers "which file, which line"; `requirementLevel` answers "did the
 *    repository insist". A declared script nobody runs is `REPOSITORY_SUGGESTED`,
 *    which is a different claim from "there is no lint step" — and a different
 *    claim again from `REPOSITORY_REQUIRED`, which only a CI step earns.
 * 3. **Nothing here runs, installs or fixes.** A missing `node_modules` is a
 *    sentence in `missingPrerequisites`, not an `npm ci`.
 * 4. **A candidate that cannot be honoured is refused loudly.** A workflow step
 *    that needs a shell, an install, or a script the manifest never declares is
 *    reported with its file and line rather than dropped, because "CI has five
 *    steps and MergeSutra checked two of them" has to be visible to a reviewer.
 *
 * Two commands that enforce the same kind stay two gates: a narrowed run and the
 * whole suite are different evidence about different claims.
 *
 * `executionClass` is a disclosure, not a switch. It says what a command's own
 * job is — `vitest run` reports, `prettier --write .` edits — and the engine
 * inspects the workspace after *every* gate regardless, because a test suite can
 * write a snapshot file too.
 */

export const GATE_PROVENANCE_SOURCES = [
  'PACKAGE_SCRIPT',
  'CI_WORKFLOW',
  'PROJECT_CONFIG',
  'CONTRIBUTING_DOC',
  'MERGESUTRA_BUILTIN',
  'USER_SUPPLIED',
] as const;
export type GateProvenanceSource = (typeof GATE_PROVENANCE_SOURCES)[number];

export const REQUIREMENT_LEVELS = [
  'REPOSITORY_REQUIRED',
  'REPOSITORY_SUGGESTED',
  'MERGESUTRA_ADDITIONAL',
  'USER_REQUESTED',
] as const;
export type RequirementLevel = (typeof REQUIREMENT_LEVELS)[number];

export const EXECUTION_CLASSES = ['READ_ONLY', 'MUTATION_CAPABLE'] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

export interface GateProvenance {
  readonly source: GateProvenanceSource;
  readonly file: string;
  readonly detail: string;
  readonly line: number | null;
}

export interface DiscoveredGate {
  /** Which acceptance dimension the command checks; two gates may share one. */
  readonly name: GateKind;
  readonly argv: readonly string[];
  /** Repository-relative directory; `.` until a workspace needs more. */
  readonly cwd: string;
  readonly requirementLevel: RequirementLevel;
  readonly provenance: GateProvenance;
  readonly corroboratedBy: readonly GateProvenance[];
  readonly relevantCriteria: readonly string[];
  readonly executionClass: ExecutionClass;
  readonly risk: RiskClass;
}

export interface UnusableCandidate {
  readonly command: string;
  readonly provenance: GateProvenance;
  readonly risk: RiskClass;
  readonly reason: string;
}

export interface DiscoveryOutcome {
  readonly gates: readonly DiscoveredGate[];
  readonly refused: readonly UnusableCandidate[];
  readonly missingPrerequisites: readonly string[];
  readonly notes: readonly string[];
}

export interface DiscoveryInput {
  readonly reader: RepoReader;
  readonly criteria: readonly Pick<AcceptanceCriterion, 'id' | 'verificationPlan'>[];
  readonly manifests: ManifestFacts;
}

/** Scripts a package manager runs without the word `run`. */
const IMPLICIT_SCRIPTS = new Set(['test', 'start', 'stop', 'restart']);

/** The package managers whose CLI shape this module can spell an argv for. */
const KNOWN_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Config files that only make sense alongside one kind of gate. */
const PROJECT_CONFIG_EVIDENCE: Record<GateKind, readonly string[]> = {
  format: ['.prettierrc', '.prettierrc.json', 'prettier.config.js', 'rustfmt.toml'],
  lint: ['eslint.config.js', '.eslintrc.json', 'biome.json', 'ruff.toml', '.golangci.yml'],
  typecheck: ['tsconfig.json', 'tsconfig.base.json', 'mypy.ini', 'pyrightconfig.json'],
  test: ['vitest.config.ts', 'jest.config.js', 'playwright.config.ts', 'pytest.ini'],
  build: ['vite.config.ts', 'webpack.config.js', 'Makefile'],
};

/**
 * A command whose own job is to change files.
 *
 * Matched against the whole reachable text — the argv plus every script body it
 * invokes — because `npm run format` says nothing until package.json says
 * `prettier --write .`.
 */
const MUTATION_EVIDENCE =
  /--write\b|--fix\b|--in-place\b|(^|\s)-[wi](\s|$)|\bgit commit\b|(^|\s|--)build\b|\bmake\b|\b(?:git )?apply\b/;

/** Positive evidence that a command reports rather than edits. */
const READ_ONLY_EVIDENCE =
  /--check\b|--noEmit\b|--dry-run\b|--list-different\b|(^|\s)-[ld](\s|$)|\b(?:vitest|jest|mocha|pytest|unittest|phpunit)\b|\S+ test\b|\b(?:eslint|biome)\b/;

/** How far into a repository's script chain a gate's purpose is followed. */
const MAX_SCRIPT_DEPTH = 3;

/** The most commands quoted out of one contributing document. */
const MAX_DOC_COMMANDS = 40;

interface Draft {
  readonly name: GateKind;
  readonly argv: readonly string[];
  readonly requirementLevel: RequirementLevel;
  readonly provenance: GateProvenance;
  readonly corroborated: GateProvenance[];
}

export async function discoverGates(input: DiscoveryInput): Promise<DiscoveryOutcome> {
  const { reader, criteria, manifests } = input;
  const ci = await detectCi(reader);
  const scripts = new Map(manifests.scripts.map((script) => [script.name, script]));
  const configs = await reader.existsAny(
    GATE_KINDS.flatMap((kind) => PROJECT_CONFIG_EVIDENCE[kind]),
  );
  const docs = await readContributingDocs(reader);
  const gates = new Map<string, Draft>();
  const refused: UnusableCandidate[] = [];

  // CI first: a step that actually runs is what makes a gate required, and a
  // required gate must not be overwritten by the weaker claim below it.
  for (const step of ci.commands) {
    const text = step.command.trim();
    const provenance: GateProvenance = {
      source: 'CI_WORKFLOW',
      file: step.workflow,
      detail: `runs \`${text}\``,
      line: step.line,
    };
    const translated = toExecutableArgv(text);
    if (!translated.ok) {
      // A step only a shell can execute has no argv to classify, and a shell can
      // do anything, so the honest label is the severest class rather than a
      // comforting "unknown".
      refused.push({ command: text, provenance, risk: 'DESTRUCTIVE', reason: translated.reason });
      continue;
    }
    const argv = [...translated.argv];
    const decision = decideTool({ op: 'execute', argv, cwd: '.' }, { workspace: reader.root });
    if (!decision.allowed) {
      refused.push({ command: text, provenance, risk: decision.risk, reason: decision.reason });
      continue;
    }
    if (isSetupCommand(text)) {
      refused.push({
        command: text,
        provenance,
        risk: decision.risk,
        reason: setupRefusal(text),
      });
      continue;
    }
    const routes = gatesEnforced(text, scripts);
    if (routes.length === 0) {
      refused.push({
        command: text,
        provenance,
        risk: decision.risk,
        reason: unexplainedRefusal(text, manifests),
      });
      continue;
    }
    for (const route of routes) {
      const key = `${route.kind} ${argv.join(' ')}`;
      if (!gates.has(key)) {
        gates.set(key, {
          name: route.kind,
          argv,
          requirementLevel: 'REPOSITORY_REQUIRED',
          provenance,
          corroborated: [],
        });
      }
    }
  }

  // Declared scripts: the same command a contributor would type. Where CI already
  // covers one it becomes corroboration, not a second gate, so `pnpm test` and
  // `npm test` in one repository cannot be mistaken for two requirements.
  const manager = packageManagerFor(manifests);
  for (const kind of GATE_KINDS) {
    for (const name of SCRIPT_NAMES[kind]) {
      const script = scripts.get(name);
      if (!script) continue;
      if (coversScript(gates, kind, name)) continue;
      gates.set(`${kind} ${name}`, {
        name: kind,
        argv: scriptArgv(manager, name),
        requirementLevel: 'REPOSITORY_SUGGESTED',
        provenance: {
          source: 'PACKAGE_SCRIPT',
          file: script.source.file,
          detail: script.source.detail,
          line: null,
        },
        corroborated: [],
      });
    }
  }

  const built: DiscoveredGate[] = [...gates.values()]
    .sort((a, b) => GATE_KINDS.indexOf(a.name) - GATE_KINDS.indexOf(b.name))
    .map((draft) => ({
      name: draft.name,
      argv: draft.argv,
      cwd: '.',
      requirementLevel: draft.requirementLevel,
      provenance: draft.provenance,
      corroboratedBy: corroborationFor(draft, scripts, configs, docs),
      relevantCriteria: relevantCriteriaFor(draft, criteria),
      executionClass: executionClassFor(draft, scripts),
      risk: riskOf({ op: 'execute', argv: [...draft.argv], cwd: '.' }),
    }));

  const missingPrerequisites: string[] = [];
  if (manifests.ecosystem === 'node') {
    const entries = await reader.listDirectory('.');
    if (!entries.some((entry) => entry.name === 'node_modules' && entry.kind === 'directory')) {
      missingPrerequisites.push(
        'No node_modules directory: a gate that reaches a local binary will fail for want of installed dependencies. MergeSutra will not install anything to make a gate run — a human sets the workspace up, and the report says so.',
      );
    }
  }

  const notes: string[] = [...ci.caveats];
  for (const unreadable of manifests.unreadable) {
    notes.push(`${unreadable.file}: ${unreadable.reason}, so no gate was read from it.`);
  }
  for (const doc of docs) {
    if (doc.commands.length > 0) {
      notes.push(
        `${doc.path} names ${doc.commands.length} command(s); they corroborate a gate whose command MergeSutra could otherwise point at, and never create one.`,
      );
    }
  }

  return { gates: built, refused, missingPrerequisites, notes };
}

function setupRefusal(text: string): string {
  return `Refusing to treat '${text}' as a gate: it installs dependencies, and MergeSutra never installs anything as a side effect of verifying. A setup step is reported, never run.`;
}

function unexplainedRefusal(text: string, manifests: ManifestFacts): string {
  const invoked = /\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:./-]+)/.exec(text)?.[1];
  if (invoked) {
    const where = manifests.scripts.some((script) => script.source.file === 'package.json')
      ? 'package.json'
      : 'any recognised manifest';
    return `Refusing to treat '${text}' as a gate: ${where} declares no '${invoked}' script, so MergeSutra would be guessing at what the command proves.`;
  }
  return `Refusing to treat '${text}' as a gate: nothing in the CI steps or the manifests says which check it performs, and inventing one would be MergeSutra's opinion, not the repository's requirement.`;
}

function packageManagerFor(manifests: ManifestFacts): string {
  const name = manifests.packageManager?.name ?? 'npm';
  return KNOWN_PACKAGE_MANAGERS.has(name) ? name : 'npm';
}

function scriptArgv(manager: string, name: string): string[] {
  return IMPLICIT_SCRIPTS.has(name) ? [manager, name] : [manager, 'run', name];
}

/** Is this script already reachable from a gate recorded for this kind? */
function coversScript(gates: Map<string, Draft>, kind: GateKind, name: string): boolean {
  for (const draft of gates.values()) {
    if (draft.name !== kind) continue;
    if (draft.argv[draft.argv.length - 1] === name) return true;
  }
  return false;
}

function corroborationFor(
  draft: Draft,
  scripts: ReadonlyMap<string, DeclaredScript>,
  configs: readonly string[],
  docs: readonly { path: string; commands: string[] }[],
): GateProvenance[] {
  const entries: GateProvenance[] = [];
  const add = (entry: GateProvenance): void => {
    if (sameFact(entry, draft.provenance)) return;
    if (entries.some((existing) => sameFact(existing, entry))) return;
    entries.push(entry);
  };

  const last = draft.argv[draft.argv.length - 1] ?? '';
  const script = scripts.get(last);
  if (script && SCRIPT_NAMES[draft.name].includes(last)) {
    add({
      source: 'PACKAGE_SCRIPT',
      file: script.source.file,
      detail: script.source.detail,
      line: null,
    });
  }
  for (const file of configs) {
    if (PROJECT_CONFIG_EVIDENCE[draft.name].includes(file)) {
      add({
        source: 'PROJECT_CONFIG',
        file,
        detail: `${file} is present, which only makes sense alongside a ${draft.name} step`,
        line: null,
      });
    }
  }
  const spelled = draft.argv.join(' ');
  for (const doc of docs) {
    if (doc.commands.some((command) => normalizeCommand(command) === spelled)) {
      add({
        source: 'CONTRIBUTING_DOC',
        file: doc.path,
        detail: `tells a contributor to run \`${spelled}\``,
        line: null,
      });
    }
  }
  return entries;
}

function sameFact(a: GateProvenance, b: GateProvenance): boolean {
  return a.source === b.source && a.file === b.file && a.detail === b.detail;
}

function relevantCriteriaFor(
  draft: Draft,
  criteria: readonly Pick<AcceptanceCriterion, 'id' | 'verificationPlan'>[],
): string[] {
  const spelled = draft.argv.join(' ');
  const ids = new Set<string>();
  for (const criterion of criteria) {
    for (const step of criterion.verificationPlan) {
      if ('command' in step && normalizeCommand(step.command) === spelled) ids.add(criterion.id);
    }
  }
  return [...ids].sort();
}

function executionClassFor(
  draft: Draft,
  scripts: ReadonlyMap<string, DeclaredScript>,
): ExecutionClass {
  const texts = reachableTexts(draft.argv, scripts);
  // Ordered on purpose: a test runner that is also handed `--update` is a
  // command that edits, and "it is a test" is not a claim to the contrary.
  if (texts.some((text) => MUTATION_EVIDENCE.test(text))) return 'MUTATION_CAPABLE';
  if (texts.some((text) => READ_ONLY_EVIDENCE.test(text))) return 'READ_ONLY';
  return 'MUTATION_CAPABLE';
}

/** The argv plus every script body it eventually invokes. */
function reachableTexts(
  argv: readonly string[],
  scripts: ReadonlyMap<string, DeclaredScript>,
): string[] {
  const texts = [argv.join(' ').toLowerCase()];
  const seen = new Set<string>();
  let pending = [texts[0] ?? ''];
  for (let depth = 0; depth < MAX_SCRIPT_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const text of pending) {
      for (const token of text.split(/\s+/)) {
        if (!scripts.has(token) || seen.has(token)) continue;
        seen.add(token);
        const body = (scripts.get(token)?.command ?? '').toLowerCase();
        next.push(body);
        texts.push(body);
      }
    }
    if (next.length === 0) break;
    pending = next;
  }
  return texts;
}

async function readContributingDocs(
  reader: RepoReader,
): Promise<{ path: string; commands: string[] }[]> {
  const present = await reader.existsAny(CONTRIBUTION_CANDIDATES);
  const docs: { path: string; commands: string[] }[] = [];
  for (const relativePath of present) {
    const file = await reader.readText(relativePath, MAX_DOC_BYTES);
    if (!file || file.truncated) continue;
    docs.push({ path: file.relativePath, commands: docCommands(file.text) });
  }
  return docs;
}

/**
 * Commands a document shows a contributor, as data.
 *
 * Fenced blocks and inline spans are collected without judgement about whether
 * they are commands at all — that is the point. The list is only ever compared
 * against a gate MergeSutra already has a real source for, so an over-read
 * sentence costs nothing and a prose-only repository gains no requirement.
 */
function docCommands(text: string): string[] {
  const found: string[] = [];
  for (const block of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
    for (const line of (block[1] ?? '').split(/\r?\n/)) found.push(line);
  }
  for (const inline of text.matchAll(/`([^`\n]{1,120})`/g)) found.push(inline[1] ?? '');
  return [
    ...new Set(
      found
        .map(normalizeCommand)
        .filter((command) => command.length > 0)
        .slice(0, MAX_DOC_COMMANDS),
    ),
  ];
}

function normalizeCommand(text: string): string {
  return text
    .trim()
    .replace(/^\$\s+/, '')
    .replace(/\s+/g, ' ');
}
