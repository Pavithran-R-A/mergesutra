import path from 'node:path';
import { hasGitSegment, isInsideRoot } from '../security/path-safety.js';
import { isArgvShaped, isBareProgram } from '../security/command-safety.js';

/**
 * The tool controller: one question, answered the same way everywhere.
 *
 * Stages 6 and 7 want to do things — edit a file, run a check, hand a diff to
 * GitHub. Each of those could be a separate `if` scattered through whichever
 * stage needs it, and the scattered version is how a new capability arrives
 * without anyone re-deciding whether it is allowed. So the judgement lives here
 * instead: a pure function from a request to a decision, which the asking stage
 * has to carry to its caller rather than assume past.
 *
 * Three properties are worth stating plainly:
 *
 * 1. Risk is *derived*, never accepted. A caller cannot declare its own action
 *    READ to get past a gate. For a command the class comes from the argv
 *    itself, so `git push --force` proposed as `execute` is still DESTRUCTIVE
 *    and `bash -c "…"` is still a shell. The derived class is then *honoured*:
 *    a command that reaches the network or a remote is not excused for running
 *    inside the workspace, because confinement is not what those commands act on.
 * 2. Every command states where it runs. An unstated working directory is a
 *    command that could run anywhere on the machine, so it is refused.
 * 3. This is a judgement on strings, not an enforcement point. Confinement here
 *    resolves a path lexically; the only module that writes files
 *    (`src/security/writer.ts`) repeats the check after following symlinks. A
 *    decision that passes and a write that lands are kept deliberately apart.
 */

export const RISK_CLASSES = [
  'READ',
  'WRITE',
  'EXECUTE',
  'NETWORK',
  'REMOTE_MUTATION',
  'DESTRUCTIVE',
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/**
 * The operations a stage may ask about. Note what is missing: there is no
 * delete and no "run this string". MergeSutra does not remove or relocate a
 * user's files at all, so there is nothing here to classify.
 */
export type ToolOp =
  | { readonly op: 'read'; readonly path: string }
  | { readonly op: 'write'; readonly path: string }
  | { readonly op: 'execute'; readonly argv: readonly string[]; readonly cwd: string }
  | { readonly op: 'network'; readonly target: string }
  | { readonly op: 'remote-mutation'; readonly summary: string };

export interface ToolContext {
  /** The one directory this run owns: its workspace. */
  readonly workspace: string;
  /** A human said yes to exactly this summary. Nothing else counts as a yes. */
  readonly approval?: { readonly summary: string };
}

export interface ToolDecision {
  readonly risk: RiskClass;
  readonly allowed: boolean;
  /**
   * True when the only thing missing is a human approval. A caller renders
   * `BLOCKED` for that and a plain failure for a refusal — the difference is
   * whether a yes would change anything.
   */
  readonly requiresApproval: boolean;
  /** One sentence, fit to print in a report. Never contains file contents. */
  readonly reason: string;
}

/** Most severe class in a set; `READ` for an empty one. */
export function highestRisk(classes: readonly RiskClass[]): RiskClass {
  let top: RiskClass = 'READ';
  for (const candidate of classes) {
    if (RISK_CLASSES.indexOf(candidate) > RISK_CLASSES.indexOf(top)) top = candidate;
  }
  return top;
}

/**
 * Classify a `git` argv by what it does, and to whom.
 *
 * Conservative in one direction only: an unrecognised subcommand is treated as
 * a local write, because the read-only allowlist is the part that would be
 * dangerous to guess at. Remote and destructive verbs are matched on the whole
 * argv, so `push --force` is never filed under `push`.
 *
 * Global options come before the subcommand and are the interesting part: git
 * reads them itself, so `-c core.pager=…` or `--git-dir=…` would let a command
 * that classifies as a read run a program or write somewhere else. MergeSutra
 * only ever emits `-C`, which chooses a directory and nothing else, so that is
 * skipped and every other prefix option is refused rather than reasoned about.
 */
export function risksOfGitArgv(argv: readonly string[]): RiskClass {
  const verb = parseGitVerb(argv);
  if (verb.hostile) return 'DESTRUCTIVE';
  const sub = verb.sub;
  const rest = verb.rest;

  if (sub === 'push') {
    return rest.some((arg) => FORCEFUL_FLAGS.has(arg)) ? 'DESTRUCTIVE' : 'REMOTE_MUTATION';
  }
  if (sub === 'config') {
    // Reading configuration is a read. Writing it — especially into the global
    // file — changes the user's machine, which is not MergeSutra's to change.
    if (rest.some((arg) => ESCALATING_CONFIG.has(arg))) return 'DESTRUCTIVE';
    if (rest.some((arg) => CONFIG_READ_FLAGS.has(arg))) return 'READ';
    return 'WRITE';
  }
  if (sub === 'worktree') {
    const verb_ = rest[0] ?? '';
    // `add` is how a run gets its own workspace. `list` only reports. The rest
    // (`remove`, `prune`, `move`, `lock`) discard or relocate a checkout, and
    // MergeSutra leaves cleanup of a workspace to the human who owns the disk.
    if (verb_ === 'add') return 'WRITE';
    if (verb_ === 'list') return 'READ';
    return 'DESTRUCTIVE';
  }
  if (sub === 'remote') {
    return REMOTE_READ_VERBS.has(rest[0] ?? '') ? 'READ' : 'WRITE';
  }
  if (sub === 'branch') {
    // Creating a branch is a local write; deleting one discards a ref a human may
    // not have pushed anywhere, which is the same class as throwing away commits.
    return rest.some((arg) => BRANCH_DELETE_FLAGS.has(arg)) ? 'DESTRUCTIVE' : 'WRITE';
  }
  if (sub === 'stash') {
    // The stash is a queue: reading it changes nothing, every other verb moves or
    // drops somebody's uncommitted work.
    if (STASH_READ_VERBS.has(rest[0] ?? '')) return 'READ';
    return 'DESTRUCTIVE';
  }
  if (sub === 'reset' && !rest.some((arg) => NON_DESTRUCTIVE_RESET.has(arg))) return 'DESTRUCTIVE';
  if (DESTRUCTIVE_GIT.has(sub)) return 'DESTRUCTIVE';
  if (REMOTE_READ_GIT.has(sub)) return 'NETWORK';
  if (READ_ONLY_GIT.has(sub)) return 'READ';
  return 'WRITE';
}

interface GitVerb {
  readonly sub: string;
  readonly rest: readonly string[];
  readonly hostile: boolean;
}

const INERT_GLOBAL_OPTIONS = new Set(['--bare', '--literal-pathspecs', '--no-pager']);
/** Inert options that consume the next token as their value. */
const OPTIONS_WITH_VALUE = new Set(['-C']);
/**
 * Options that change what git reads, executes or writes. Nothing about them is
 * "a read that happens to carry a flag", so they end the command's claim to be
 * anything milder than DESTRUCTIVE.
 */
const HOSTILE_GLOBAL_OPTIONS = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--paginate',
  '-p',
  '--super-prefix',
  '--work-tree',
]);

function parseGitVerb(argv: readonly string[]): GitVerb {
  let index = 1;
  for (;;) {
    const token = argv[index] ?? '';
    const named = token.split('=', 1)[0] ?? '';
    if (HOSTILE_GLOBAL_OPTIONS.has(token) || HOSTILE_GLOBAL_OPTIONS.has(named)) {
      return { sub: '', rest: [], hostile: true };
    }
    if (OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (INERT_GLOBAL_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    return { sub: token, rest: argv.slice(index + 1), hostile: false };
  }
}

const FORCEFUL_FLAGS = new Set(['--force', '--force-with-lease', '-f', '--no-verify']);
/**
 * Refused outright.
 *
 * `apply` and `am` write many files at once while bypassing the confined
 * writer, which is the one thing that makes "writes stay in the workspace"
 * true; `rebase` rewrites commits the human may not have pushed yet; `clean`,
 * `gc` and `prune` discard work that is not in a commit; `filter-branch`
 * rewrites history. MergeSutra has no need for any of them, and a stage that
 * thinks it does has a design problem worth surfacing.
 *
 * `checkout`, `restore` and `switch` join them on the strength of one artifact:
 * ADR-057 makes a dirty workspace the authoritative product of an interrupted
 * cycle and forbids recovery from discarding it, and `git checkout -- .` is the
 * single command that would end that story neatly and destroy the patch. This
 * build never spawns any of the three — every internal git call is observation
 * or `worktree add`, which creates its own branch — so the conservative reading
 * of the verb costs the pipeline nothing.
 */
const DESTRUCTIVE_GIT = new Set([
  'am',
  'apply',
  'checkout',
  'clean',
  'filter-branch',
  'gc',
  'prune',
  'rebase',
  'restore',
  'switch',
]);
const BRANCH_DELETE_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '--unset-upstream',
]);
const STASH_READ_VERBS = new Set(['list', 'show']);
const REMOTE_READ_GIT = new Set(['clone', 'fetch', 'pull']);
const REMOTE_READ_VERBS = new Set(['-v', '--verbose', 'get-url', 'show']);
const READ_ONLY_GIT = new Set([
  'blame',
  'cat-file',
  'check-ignore',
  'describe',
  'diff',
  'log',
  'ls-files',
  'merge-base',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
]);
const ESCALATING_CONFIG = new Set(['--global', '--system', '--worktree']);
const CONFIG_READ_FLAGS = new Set(['-l', '--get', '--get-all', '--get-regexp', '--list']);
const NON_DESTRUCTIVE_RESET = new Set(['--soft', '--mixed']);

/**
 * Programs that are never tools here, in any form.
 *
 * Privilege escalation is not part of a run at any state, and the removal
 * programs have exactly one use — deleting things — which MergeSutra does not
 * do to a user's checkout. (A later stage removes files it wrote itself inside
 * its own workspace; that is a different question and is not this policy's
 * permission.)
 */
const PRIVILEGE_PROGRAMS = new Set(['doas', 'runas', 'sudo']);
const REMOVAL_PROGRAMS = new Set([
  'dd',
  'del',
  'diskpart',
  'erase',
  'mkfs',
  'rm',
  'rmdir',
  'shred',
]);

/**
 * Languages whose `-c` takes a *command string*.
 *
 * Running `node scripts/build.js` is ordinary EXECUTE — repository tooling is
 * what a verification stage exists to run. Handing an interpreter a string to
 * interpret is not: every composition character MergeSutra refused in an
 * argument is re-parsed by the interpreter, which is the shell path closing
 * again through a side door.
 */
const INTERPRETERS = new Set([
  'bash',
  'cmd',
  'cscript',
  'node',
  'perl',
  'php',
  'powershell',
  'pwsh',
  'python',
  'python3',
  'ruby',
  'sh',
  'zsh',
]);
/**
 * Compared lower-case, because the interpreters above are not.
 *
 * `cmd` accepts `/C` and `/c` alike and `powershell` accepts `-Command`,
 * `-command` and `-COMMAND`; a rule that matched one spelling merely relocated
 * the bypass on the machine where that case-insensitivity is normal.
 */
const INLINE_CODE_FLAGS = new Set([
  '-c',
  '-e',
  '--eval',
  '-command',
  '-encodedcommand',
  '-enc',
  '/c',
  '/k',
]);

/**
 * The GitHub CLI, refused as a *class* rather than parsed for intent.
 *
 * Stage 1 reads an issue through its own transport (`src/github/gh-client.ts`,
 * which never asks this module) and Stage 10 publishes through a digest-bound
 * capability that this build leaves disabled. Neither needs a run to name `gh`,
 * so there is no read/write parser here to get wrong: any `gh` argv is a remote
 * mutation as far as a run is concerned, and a `gh api` whose verb is hidden in a
 * later token is exactly the command this rule exists to catch.
 */
const GITHUB_CLI = new Set(['gh']);

/**
 * Programs whose whole job is to move bytes off this machine.
 *
 * A coding model needs no exfiltration channel, and these are the reachable
 * ones on the supported systems. This is not an enumeration of every network
 * client on Earth — that is the residual limit, stated in SECURITY_MODEL.md.
 */
const NETWORK_CLIENTS = new Set([
  'curl',
  'wget',
  'aria2c',
  'ftp',
  'tftp',
  'nc',
  'scp',
  'sftp',
  'rsync',
]);

/**
 * Package managers, classified by subcommand instead of by program name.
 *
 * `npm test` is repository execution and Stage 7's consent governs it; making
 * every `npm` invocation NETWORK would refuse the project's own gates. What the
 * subcommand does is the question, so the unknown answer falls to NETWORK — the
 * class a run may not start — rather than to the ordinary one.
 */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'yarnpkg']);
/** Downloads or executes code that may not exist locally yet. */
const BARE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const PM_REMOTE = new Set([
  'publish',
  'unpublish',
  'deprecate',
  'dist-tag',
  'access',
  'token',
  'owner',
  'adduser',
]);
/**
 * The subcommands that only touch files already here. Anything the package
 * manager does that is not on this list is treated as network, including a verb
 * invented after this file was written: `npm view` reads the registry, and
 * `npm version` runs `git tag` behind MergeSutra's back, so neither is here.
 */
const PM_LOCAL = new Set(['test', 'run', 'run-script', 'ls', 'list', 'help', 'why', 'prefix']);
const PM_INFO_FLAGS = new Set(['--version', '-v', '--help', '-h']);

/**
 * The first token that is not an option, which is where a package manager
 * subcommand actually lives: `npm --silent run lint` runs `run`.
 */
function firstSubcommand(argv: readonly string[]): string | undefined {
  for (const token of argv.slice(1)) {
    const value = token.toLowerCase();
    if (!value.startsWith('-')) return value;
    // An option that takes a value would otherwise let its value pose as the verb.
    if (!PM_INFO_FLAGS.has(value) && !value.includes('=')) return undefined;
  }
  return undefined;
}

function risksOfPackageManager(argv: readonly string[]): RiskClass {
  const sub = firstSubcommand(argv);
  if (sub === undefined) {
    return argv.slice(1).every((token) => PM_INFO_FLAGS.has(token.toLowerCase()))
      ? 'EXECUTE'
      : 'NETWORK';
  }
  if (PM_REMOTE.has(sub)) return 'REMOTE_MUTATION';
  if (PM_LOCAL.has(sub)) return 'EXECUTE';
  return 'NETWORK';
}

/**
 * Why a network-classed command is refused, in the command's own terms.
 *
 * One sentence would be legal and useless: a report reader needs to know whether
 * the run tried to fetch a URL, download a package, or hand its own files to a
 * server, because those are three different accidents.
 */
function networkReason(argv: readonly string[]): string {
  const program = programName(argv[0] ?? '');
  const shown = bound(argv.join(' '));
  if (
    BARE_RUNNERS.has(program) ||
    firstSubcommand(argv) === 'exec' ||
    firstSubcommand(argv) === 'dlx' ||
    firstSubcommand(argv) === 'x'
  ) {
    return `Refusing ${shown}: it can fetch a package and execute code that is not here yet, which is a second supply chain behind the one this build already trusts.`;
  }
  if (PACKAGE_MANAGERS.has(program)) {
    return `Refusing ${shown}: it would reach the registry and change this checkout's dependencies. MergeSutra never installs anything on a run's behalf; a human installs, or a CI system does.`;
  }
  return `Refusing ${shown}: a run does not open its own network channel. MergeSutra's own network use is its two transports — the issue reader and the model client — and neither goes through this decision.`;
}

/** Classify one request. Public so a report can state what it decided. */
export function riskOf(request: ToolOp): RiskClass {
  switch (request.op) {
    case 'read':
      return 'READ';
    case 'write':
      return 'WRITE';
    case 'network':
      return 'NETWORK';
    case 'remote-mutation':
      return 'REMOTE_MUTATION';
    case 'execute':
      return riskOfCommand(request.argv);
  }
}

function riskOfCommand(argv: readonly string[]): RiskClass {
  const program = programName(argv[0] ?? '');
  if (PRIVILEGE_PROGRAMS.has(program) || REMOVAL_PROGRAMS.has(program)) return 'DESTRUCTIVE';
  if (
    INTERPRETERS.has(program) &&
    argv.some((token) => INLINE_CODE_FLAGS.has(token.toLowerCase()))
  ) {
    return 'DESTRUCTIVE';
  }
  if (GITHUB_CLI.has(program)) return 'REMOTE_MUTATION';
  if (BARE_RUNNERS.has(program)) return 'NETWORK';
  if (NETWORK_CLIENTS.has(program)) return 'NETWORK';
  if (PACKAGE_MANAGERS.has(program)) return risksOfPackageManager(argv);
  if (program === 'git') return risksOfGitArgv(argv);
  // `prettier --write .`, `vitest run` — ordinary EXECUTE. Whether the
  // *arguments* are the repository's own is Stage 7's gate.
  return 'EXECUTE';
}

function programName(token: string): string {
  const lowered = token.toLowerCase();
  const separator = Math.max(lowered.lastIndexOf('/'), lowered.lastIndexOf('\\'));
  const base = separator === -1 ? lowered : lowered.slice(separator + 1);
  // Windows resolves `rm`, `rm.exe` and `rm.cmd` to the same thing; a name test
  // that only matched the bare spelling would be a joke there.
  for (const suffix of EXECUTABLE_SUFFIXES) {
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}

const EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.com'];

export function decideTool(request: ToolOp, context: ToolContext): ToolDecision {
  const risk = riskOf(request);

  if (risk === 'DESTRUCTIVE') {
    return {
      risk,
      allowed: false,
      requiresApproval: false,
      reason: destructiveReason(request),
    };
  }
  if (risk === 'REMOTE_MUTATION') return decideRemote(request, context);
  if (request.op === 'execute') {
    // A network client named by a run is not workspace execution that happens to
    // be confined: the confinement is the part it does not care about.
    if (risk === 'NETWORK') {
      return {
        risk,
        allowed: false,
        requiresApproval: false,
        reason: networkReason(request.argv),
      };
    }
    return decideExecute(request, context, risk);
  }
  if (request.op === 'network') {
    return {
      risk,
      allowed: true,
      requiresApproval: false,
      reason: 'Network use is allowed and always disclosed; no credential crosses it.',
    };
  }
  return decideFile(request, context, risk);
}

function destructiveReason(request: ToolOp): string {
  if (request.op === 'execute') {
    const program = programName(request.argv[0] ?? '');
    if (PRIVILEGE_PROGRAMS.has(program)) {
      return `Refusing to start '${program}': MergeSutra never escalates privileges.`;
    }
    if (REMOVAL_PROGRAMS.has(program)) {
      return `Refusing to start '${program}': MergeSutra does not delete files. Say in the report that a path should go, and let a human do it.`;
    }
    if (INTERPRETERS.has(program)) {
      return `Refusing ${bound(request.argv.join(' '))}: an interpreter handed a string re-opens the shell path this policy exists to close. Point it at a script file instead.`;
    }
    if (parseGitVerb(request.argv).hostile) {
      return `Refusing ${bound(request.argv.join(' '))}: a global git option can redirect which repository, program or config git acts on, which no risk class of this command covers.`;
    }
    return `Refusing the destructive command ${bound(request.argv.join(' '))}. No approval enables it.`;
  }
  return 'MergeSutra does not perform destructive operations, and no approval enables them.';
}

function decideRemote(request: ToolOp, context: ToolContext): ToolDecision {
  const summary = request.op === 'remote-mutation' ? request.summary : commandSummary(request);
  if (summary.length > 0 && context.approval?.summary === summary) {
    return {
      risk: 'REMOTE_MUTATION',
      allowed: true,
      requiresApproval: false,
      reason: 'A human approved exactly this remote action.',
    };
  }
  return {
    risk: 'REMOTE_MUTATION',
    allowed: false,
    requiresApproval: true,
    reason: `A remote mutation waits for explicit human approval of this exact action: ${bound(summary)}.`,
  };
}

/** A git command that reaches the remote is described by the command itself. */
function commandSummary(request: ToolOp): string {
  return request.op === 'execute' ? request.argv.join(' ') : '';
}

function decideFile(request: ToolOp, context: ToolContext, risk: RiskClass): ToolDecision {
  const verb = risk === 'READ' ? 'read' : 'write';
  const target = request.op === 'read' || request.op === 'write' ? request.path : undefined;
  if (target === undefined) {
    return denied(risk, `Refusing: this is not a file operation.`);
  }
  if (hasGitSegment(target)) {
    return denied(risk, `Refusing to ${verb} through a .git path: ${bound(target)}.`);
  }
  if (withinWorkspace(context.workspace, target) === null) {
    return denied(risk, `The ${verb} target leaves this run's workspace: ${bound(target)}.`);
  }
  return {
    risk,
    allowed: true,
    requiresApproval: false,
    reason: `The ${verb} target stays inside this run's workspace.`,
  };
}

function decideExecute(
  request: ToolOp & { readonly op: 'execute' },
  context: ToolContext,
  risk: RiskClass,
): ToolDecision {
  if (!isArgvShaped(request.argv)) {
    return denied(
      risk,
      'Commands must arrive as an argv array with no shell syntax; a command string is refused.',
    );
  }
  const program = request.argv[0] ?? '';
  if (!isBareProgram(program)) {
    return denied(
      risk,
      `Refusing to start '${bound(program)}': only a program found on the search path is allowed.`,
    );
  }
  if (withinWorkspace(context.workspace, request.cwd) === null) {
    return denied(
      risk,
      `The command would run outside this run's workspace: ${bound(request.cwd)}.`,
    );
  }
  return {
    risk,
    allowed: true,
    requiresApproval: false,
    reason: `Allowed as argv inside the workspace — ${bound(request.argv.join(' '))} — with a timeout and bounded output.`,
  };
}

function denied(risk: RiskClass, reason: string): ToolDecision {
  return { risk, allowed: false, requiresApproval: false, reason };
}

/** Lexical containment only; the writer repeats it after resolving links. */
function withinWorkspace(workspace: string, target: string): string | null {
  const absolute = path.isAbsolute(target) ? target : path.resolve(workspace, target);
  return isInsideRoot(workspace, absolute) ? absolute : null;
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}
