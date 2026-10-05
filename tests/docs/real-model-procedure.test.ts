import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PROCEDURE = path.join(ROOT, 'docs', 'REAL_MODEL_E2E_PROCEDURE.md');
const PROGRAM = path.join(ROOT, 'src', 'cli', 'program.ts');
const BIN = path.join(ROOT, 'dist', 'bin.js');

/**
 * Does the document that tells a person how to spend a real model credential describe the
 * command line that actually exists?
 *
 * Stage 14 closes by handing a human being a procedure: set these variables, type these
 * commands in this order, this is what each one costs, this is the only repository it may
 * touch. That document is read once, by a person who is about to authenticate a paid call,
 * and then usually never again — which makes it the most expensive place in this repository
 * for a sentence that is merely plausible. S14-6 found exactly that shape in `README.md`: an
 * environment variable described as "left unset" that no code reads, standing in the paragraph
 * a reader would consult to decide whether a run can reach a remote. The command surface drifts
 * the same way, and drift there is worse, because a mistyped flag is not a wrong belief but a
 * refusal at the moment the key is already in the environment.
 *
 * Four relationships are mechanical, and each has a failure this file can see coming.
 *
 * 1. **Every command line must be a command this build has.** The verbs come from the built
 *    program's own `--help`, not from source, because the help screen — not `program.ts` — is
 *    what the reader will compare the document against. `run` is registered as a planned
 *    command and exits 2 saying so, so a procedure that tells someone to type it is caught here.
 * 2. **Every flag must be one that verb offers.** `implement --model <id>` is real and `plan
 *    --model <id>` is not — `plan` takes only a run id, so a reader who wrote it would get an
 *    unknown-option refusal instead of a plan. Flags are read from option-declaration lines,
 *    never from prose, so a flag named only inside another flag's description does not count
 *    as offered.
 * 3. **Every budget number must be inside the range that flag prints.** `--max-steps 100` is
 *    refused at the CLI boundary (the cap is 40), so suggesting it does not merely overstate
 *    what a run costs — it types a command that cannot run at all.
 * 4. **Every variable the procedure tells a person to export must be one something reads.** The
 *    reverse of the README guard, applied to the file where being wrong costs a person an
 *    environment they do not need.
 *
 * What this file does **not** claim: it cannot tell whether the procedure is safe, complete, or
 * honest about what a run achieved. It reads command shapes, not meaning, so it passes without
 * complaint a document that walks a reader through a correctly spelled command that does the
 * wrong thing, and it cannot know whether an exit code quoted inside it was measured. The named
 * limits live in `docs/SECURITY_GAP_REGISTER.md` under Stage 14.
 */

let cached: string | null = null;

/** Read once, and say which document is missing rather than throwing a bare ENOENT. */
function procedureText(): string {
  if (cached === null) {
    if (!existsSync(PROCEDURE)) {
      throw new Error(
        'docs/REAL_MODEL_E2E_PROCEDURE.md is not here, and every rule in this file is a rule ' +
          'about it. Stage 14 ends at a credential this machine does not hold, so the handover ' +
          'document has to exist before any of this can be checked.',
      );
    }
    cached = readFileSync(PROCEDURE, 'utf8');
  }
  return cached;
}

function helpText(...args: string[]): string {
  const result = spawnSync(process.execPath, [BIN, ...args, '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `\`node dist/bin.js ${args.join(' ')} --help\` exited ${String(result.status)}: ` +
        `${result.stderr.trim() || result.stdout.trim() || 'no output'}\n` +
        'dist/bin.js must exist before this file runs; `npm run check` builds it first.',
    );
  }
  return result.stdout;
}

const helps = new Map<string, string>();

function helpFor(...args: string[]): string {
  const key = args.join(' ');
  if (!helps.has(key)) helps.set(key, helpText(...args));
  return helps.get(key) as string;
}

/** Flags printed on an option-declaration line, e.g. `  --repo <path>   …`. */
function offeredFlags(help: string): string[] {
  return [
    ...new Set(
      [...help.matchAll(/^\s+(?:-\w, )?(--[a-z][a-z0-9-]*)/gm)].map((match) =>
        (match[1] as string).slice(2),
      ),
    ),
  ].sort();
}

/** The numeric range a flag prints on its own declaration line: `(1-40)`. */
function flagRange(help: string, flag: string): [number, number] | null {
  const line = new RegExp(`^\\s+(?:-\\w, )?--${flag}\\b[^\\n]*$`, 'm').exec(help);
  if (!line) return null;
  const range = /\((\d+)-(\d+)\)/.exec(line[0]);
  return range ? [Number(range[1]), Number(range[2])] : null;
}

/** Verbs the CLI registers, read from source: the planned ones are not among them. */
function registeredCommands(): string[] {
  return [
    ...new Set(
      [...readFileSync(PROGRAM, 'utf8').matchAll(/\.command\('([a-z][a-z0-9-]*)/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ];
}

interface TypedCommand {
  verb: string;
  flags: string[];
  line: string;
}

/** The verb a `dist/bin.js` line invokes, skipping any global flag typed before it. */
function verbOf(line: string): string {
  const after = line.slice(line.indexOf('dist/bin.js') + 'dist/bin.js'.length).trim();
  const token = after.split(/\s+/).find((candidate) => !candidate.startsWith('-')) ?? '';
  return token.replace(/[^a-z0-9-].*$/, '');
}

/** Command lines the procedure tells the reader to type, split into verb and flags. */
function typedCommands(procedure: string): TypedCommand[] {
  return procedure
    .split('\n')
    .filter((line) => line.includes('dist/bin.js'))
    .map((line): TypedCommand | null => {
      const verb = verbOf(line);
      if (!/^[a-z][a-z0-9-]*$/.test(verb)) return null;
      const flags = [
        ...new Set([...line.matchAll(/(?:^|\s)--([a-z][a-z0-9-]*)/g)].map((m) => m[1] as string)),
      ];
      return { verb, flags, line: line.trim() };
    })
    .filter((command): command is TypedCommand => command !== null);
}

/** `--flag 12` pairs the procedure types, with the number attached. */
function budgetNumbers(
  procedure: string,
): Array<{ verb: string; flag: string; value: number; line: string }> {
  const found: Array<{ verb: string; flag: string; value: number; line: string }> = [];
  for (const line of procedure.split('\n')) {
    if (!line.includes('dist/bin.js')) continue;
    const verb = verbOf(line);
    for (const match of line.matchAll(/--([a-z][a-z0-9-]*)\s+(\d+)\b/g)) {
      found.push({ verb, flag: match[1] as string, value: Number(match[2]), line: line.trim() });
    }
  }
  return found;
}

function everySourceText(relativeDir: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) files.push(readFileSync(full, 'utf8'));
    }
  };
  if (existsSync(path.join(ROOT, relativeDir))) walk(path.join(ROOT, relativeDir));
  return files.join('\n');
}

const SRC = everySourceText('src');
const CODE = `${SRC}\n${everySourceText('tests')}`;

/** Read from an environment somewhere, or emitted as a quoted constant by source. */
function nameAppearsInCode(name: string): boolean {
  return (
    new RegExp(`(?:process\\.)?env\\.${name}\\b`).test(CODE) ||
    new RegExp(`(?:process\\.)?env\\[['"]${name}['"]\\]`).test(CODE) ||
    SRC.includes(`'${name}'`)
  );
}

describe('the real-model procedure exists, and is worth scanning', () => {
  it('is written, because Stage 14 stops at a credential this machine cannot hold', () => {
    expect(
      existsSync(PROCEDURE),
      'docs/REAL_MODEL_E2E_PROCEDURE.md is absent: the stage that ends at a credential boundary ' +
        'has to leave a human being a runnable procedure, not a promise',
    ).toBe(true);
  });

  it('types more than one command, so the rules below are not reading an empty file', () => {
    const commands = typedCommands(procedureText());
    expect(commands.length, 'the procedure types no command line').toBeGreaterThan(5);
    expect(
      new Set(commands.map((command) => command.verb)).size,
      'the procedure exercises fewer than six distinct verbs',
    ).toBeGreaterThan(5);
  });

  it('names the configuration a live run reads, so rule 4 has a surface to check', () => {
    const named = namedEnvironmentVariables(procedureText());
    expect(
      named,
      'the procedure does not name the credential or the model, which a live run cannot start ' +
        'without either',
    ).toEqual(expect.arrayContaining(['BHARATCODE_API_KEY', 'BHARATCODE_MODEL']));
  });
});

describe('every command the procedure tells a person to type is a command this build has', () => {
  it('names a verb the CLI registers', () => {
    const commands = typedCommands(procedureText());
    const real = registeredCommands();
    const invented = [...new Set(commands.map((c) => c.verb))].filter((v) => !real.includes(v));
    expect(
      invented,
      `the procedure types a command this CLI does not register: ${invented.join(', ')} ` +
        `(registered: ${real.join(', ')})`,
    ).toEqual([]);
  });

  it('offers every flag on that verb, or on the program itself', () => {
    const globals = offeredFlags(helpFor());
    const wrong = typedCommands(procedureText()).flatMap((command) =>
      command.flags
        .filter((flag) => !offeredFlags(helpFor(command.verb)).includes(flag))
        .filter((flag) => !globals.includes(flag))
        .map((flag) => `${command.verb} --${flag}`),
    );
    const named = [...new Set(wrong)];
    expect(
      named,
      `the procedure uses a flag the screen it names never printed: ${named.join(', ')}`,
    ).toEqual([]);
  });

  it('can fail, because the two verbs it leans on really do differ', () => {
    expect(
      offeredFlags(helpFor('implement')),
      'implement is expected to offer the knobs this stage depends on',
    ).toEqual(expect.arrayContaining(['repo', 'model', 'max-steps', 'max-writes', 'max-commands']));
    expect(
      offeredFlags(helpFor('plan')).includes('model'),
      'plan must not offer --model, or the rule above has nothing to bite on',
    ).toBe(false);
  });
});

describe('every budget the procedure names is a budget the CLI accepts', () => {
  it('stays inside the range the flag itself prints', () => {
    const numbers = budgetNumbers(procedureText());
    const out = numbers
      .map((item) => {
        const range = flagRange(helpFor(item.verb), item.flag);
        // A flag that prints no range prints no bound that can be broken.
        if (!range) return null;
        return item.value >= range[0] && item.value <= range[1]
          ? null
          : `${item.verb} --${item.flag} ${item.value} is outside (${range[0]}-${range[1]})`;
      })
      .filter((problem): problem is string => problem !== null);
    const named = [...new Set(out)];
    expect(
      named,
      `the procedure types a budget this CLI would refuse: ${named.join('; ')}`,
    ).toEqual([]);
  });

  it('is a scan over real numbers, not an empty list', () => {
    const numbers = budgetNumbers(procedureText());
    expect(
      numbers.length,
      'the procedure names no numeric budget, so the rule above checked nothing',
    ).toBeGreaterThan(0);
    expect(
      numbers.some((item) => item.flag === 'max-steps'),
      'the procedure sets no turn budget, which is the one knob a paid loop needs bounded',
    ).toBe(true);
  });
});

describe('every variable the procedure exports is one something reads', () => {
  it('has a reader or an emitter in this repository', () => {
    const unread = namedEnvironmentVariables(procedureText()).filter(
      (name) => !nameAppearsInCode(name),
    );
    expect(
      unread,
      `the procedure tells a person to set a variable no code reads: ${unread.join(', ')}`,
    ).toEqual([]);
  });
});

/** Names in the documented configuration families, wherever the procedure mentions them. */
function namedEnvironmentVariables(procedure: string): string[] {
  const family =
    /\b(?:BHARATCODE_[A-Z0-9_]+|MERGESUTRA_[A-Z0-9_]+|GH_[A-Z0-9_]+|GITHUB_[A-Z0-9_]+|NO_COLOR|FORCE_COLOR)\b/g;
  return [...new Set(procedure.match(family) ?? [])].sort();
}
